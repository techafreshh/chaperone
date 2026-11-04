#!/usr/bin/env node
// Attack suite: fires 3 blocked attacks plus 1 clean transit against the
// guard and prints per-gate pass/fail. Fixture verdicts are signed with the
// local suite Ed25519 key registered by scripts/fixtures.mjs — an operator
// fixture, never a TEE attestation (live judgment stays
// `node scripts/verifier-live-smoke.mjs --judge`).
// Usage: scripts/attack-suite.sh [--contract <guard-id>] [options]
// Env: GUARD_CONTRACT_ID (or NEAR_CONTRACT_ID), NEAR_ACCOUNT_ID,
// NEAR_PRIVATE_KEY. Exit 0 only when all four gates match.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, getTransactionLastResult } from "near-api-js";
import {
  agentAccountId,
  keystoreDir,
  keystorePath,
  nearToYoctoString,
  readKeystore,
} from "./lib/agent-keys.mjs";
import {
  GATE_DEFS,
  SUITE_DEFAULTS,
  buildVerdictPayload,
  formatGateLine,
  resolveGuardId,
  txHashOf,
} from "./lib/attack-gates.mjs";
import { resolveSuiteKey, signWithSuiteKey } from "./fixtures.mjs";

const TESTNET_RPC_URL = "https://rpc.testnet.near.org";
const TERA_GAS = 10n ** 12n;
const CALL_GAS = 30n * TERA_GAS;

function usage() {
  return [
    "Usage: scripts/attack-suite.sh [--contract <guard-id>] [options]",
    "",
    "Options:",
    "  --contract <id>      Guard contract account id (or $GUARD_CONTRACT_ID / $NEAR_CONTRACT_ID)",
    "  --rpc-url <url>      NEAR RPC endpoint (default: $NEAR_RPC_URL or testnet)",
    "  --account-id <id>    Signer account id: guard owner and agent parent",
    "                       (default: $NEAR_ACCOUNT_ID)",
    "  --private-key <key>  Signer private key ed25519:... (default: $NEAR_PRIVATE_KEY)",
    "  --good-payee <id>    Clean-transit payee (default: $SUITE_GOOD_PAYEE or good.testnet)",
    "  --attacker-payee <id> Held-transit payee (default: $SUITE_ATTACKER_PAYEE or attacker.testnet)",
    "  --evil-payee <id>    Never-allowlisted probe payee (default: $SUITE_EVIL_PAYEE or evil.testnet)",
    "  --skip-fixtures      Skip the fixtures.mjs setup step (fixtures already provisioned)",
    "  --help               Print this help and exit 0",
    "",
    "The clean-transit line carries attestation=verifier:<key> sig:<prefix>",
    "from the local suite key. That is a fixture signature, not TEE proof.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--contract" && i + 1 < argv.length) {
      out.contract = argv[(i += 1)];
    } else if (arg === "--rpc-url" && i + 1 < argv.length) {
      out.rpcUrl = argv[(i += 1)];
    } else if (arg === "--account-id" && i + 1 < argv.length) {
      out.accountId = argv[(i += 1)];
    } else if (arg === "--private-key" && i + 1 < argv.length) {
      out.privateKey = argv[(i += 1)];
    } else if (arg === "--good-payee" && i + 1 < argv.length) {
      out.goodPayee = argv[(i += 1)];
    } else if (arg === "--attacker-payee" && i + 1 < argv.length) {
      out.attackerPayee = argv[(i += 1)];
    } else if (arg === "--evil-payee" && i + 1 < argv.length) {
      out.evilPayee = argv[(i += 1)];
    } else if (arg === "--skip-fixtures") {
      out.skipFixtures = true;
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return out;
}

async function viewFunction(provider, contractId, methodName, args) {
  const res = await provider.query({
    request_type: "call_function",
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    finality: "final",
  });
  return JSON.parse(Buffer.from(res.result).toString());
}

async function getRequest(provider, contractId, requestId) {
  const record = await viewFunction(provider, contractId, "get_request", {
    request_id: requestId,
  });
  if (!record) {
    throw new Error(`get_request(${requestId}) returned null.`);
  }
  return record;
}

function assertRequestId(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Bad request_payment shape: request_id is ${JSON.stringify(value)}.`);
  }
  return value;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    console.log(usage());
    return;
  }

  let guardId;
  try {
    guardId = resolveGuardId(process.env, args.contract);
  } catch (err) {
    console.error(`${err.message}\n${usage()}`);
    process.exit(2);
  }
  const rpcUrl = args.rpcUrl ?? process.env.NEAR_RPC_URL ?? TESTNET_RPC_URL;
  const signerId = args.accountId ?? process.env.NEAR_ACCOUNT_ID;
  const signerKey = args.privateKey ?? process.env.NEAR_PRIVATE_KEY;
  if (!signerId || !signerKey) {
    console.error(
      "Missing signer credentials: pass --account-id/--private-key or set NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY.",
    );
    process.exit(2);
  }
  const goodPayee = args.goodPayee ?? process.env.SUITE_GOOD_PAYEE ?? SUITE_DEFAULTS.goodPayee;
  const attackerPayee =
    args.attackerPayee ?? process.env.SUITE_ATTACKER_PAYEE ?? SUITE_DEFAULTS.attackerPayee;
  const evilPayee = args.evilPayee ?? process.env.SUITE_EVIL_PAYEE ?? SUITE_DEFAULTS.evilPayee;

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");

  if (!args.skipFixtures) {
    const res = spawnSync(
      process.execPath,
      [
        join(here, "fixtures.mjs"),
        "--contract", guardId,
        "--rpc-url", rpcUrl,
        "--account-id", signerId,
        "--private-key", signerKey,
        "--good-payee", goodPayee,
        "--attacker-payee", attackerPayee,
      ],
      { stdio: "inherit" },
    );
    if (res.error) {
      throw res.error;
    }
    if (res.status !== 0) {
      console.error(`fixtures.mjs failed with exit ${res.status}.`);
      process.exit(res.status ?? 1);
    }
  }

  const agentId = agentAccountId(SUITE_DEFAULTS.agentRef, signerId);
  const stored = readKeystore(keystorePath(repoRoot, agentId));
  if (!stored?.agentPrivateKey) {
    console.error(
      `No agent key for ${agentId}: run without --skip-fixtures so fixtures provision it first.`,
    );
    process.exit(2);
  }
  if (!readKeystore(join(keystoreDir(repoRoot), "verifier.json"))) {
    console.error("No suite verifier key: run without --skip-fixtures so fixtures register it first.");
    process.exit(2);
  }
  const suiteKey = resolveSuiteKey(repoRoot);

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const agent = new Account(agentId, provider, KeyPair.fromString(stored.agentPrivateKey));
  const owner = new Account(signerId, provider, KeyPair.fromString(signerKey));

  async function requestAsAgent(payee, amountNear, vendor) {
    const outcome = await agent.callFunctionRaw({
      contractId: guardId,
      methodName: "request_payment",
      args: {
        payee,
        amount_yocto: nearToYoctoString(amountNear, "amount"),
        purpose_ref: SUITE_DEFAULTS.purposeRef,
        vendor,
      },
      gas: CALL_GAS,
    });
    return { tx: txHashOf(outcome), result: getTransactionLastResult(outcome) };
  }

  async function submitFixtureVerdict(requestId, consistent) {
    // Assert through the authoritative view, not the SDK return shape.
    const record = await getRequest(provider, guardId, requestId);
    if (record.status !== "staged") {
      throw new Error(
        `Gate setup failed: request ${requestId} is ${record.status}, expected staged.`,
      );
    }
    const payload = buildVerdictPayload(record, consistent);
    const signatureBase58 = signWithSuiteKey(payload, suiteKey);
    const outcome = await owner.callFunctionRaw({
      contractId: guardId,
      methodName: "submit_verdict",
      args: { request_id: requestId, consistent, signature_base58: signatureBase58 },
      gas: CALL_GAS,
    });
    return { verdictTx: txHashOf(outcome), signatureBase58 };
  }

  const attestationExtra = (signatureBase58) =>
    `attestation=verifier:${suiteKey.publicKeyBase58} sig:${signatureBase58.slice(0, 8)}`;

  try {
    // Gate 1: 20 NEAR clears the 10 NEAR per-payment cap probe — above the
    // cap, inside the daily allowance and the 30 NEAR invoice-114 cap, so
    // the cap check fires first.
    {
      const def = GATE_DEFS[0];
      const { tx, result } = await requestAsAgent(
        goodPayee,
        SUITE_DEFAULTS.overAllowanceNear,
        SUITE_DEFAULTS.cleanVendor,
      );
      const requestId = assertRequestId(result?.request_id);
      const storedReq = await getRequest(provider, guardId, requestId);
      if (storedReq.status !== "rejected" || storedReq.reason !== "ExceedsPerPaymentCap") {
        throw new Error(
          `Gate over-allowance failed: request ${requestId} is ${storedReq.status}/${storedReq.reason}.`,
        );
      }
      console.log(formatGateLine(def, { requestId, tx }));
    }

    // Gate 2: the evil probe payee is never allowlisted.
    {
      const def = GATE_DEFS[1];
      const { tx, result } = await requestAsAgent(
        evilPayee,
        SUITE_DEFAULTS.allowlistProbeNear,
        SUITE_DEFAULTS.cleanVendor,
      );
      const requestId = assertRequestId(result?.request_id);
      const storedReq = await getRequest(provider, guardId, requestId);
      if (storedReq.status !== "rejected" || storedReq.reason !== "PayeeNotAllowlisted") {
        throw new Error(
          `Gate allowlist failed: request ${requestId} is ${storedReq.status}/${storedReq.reason}.`,
        );
      }
      console.log(formatGateLine(def, { requestId, tx }));
    }

    // Gate 3: poisoned vendor to an allowlisted attacker payee stages, then
    // the fixture verdict (consistent=false) holds it.
    {
      const def = GATE_DEFS[2];
      const { tx, result } = await requestAsAgent(
        attackerPayee,
        SUITE_DEFAULTS.stagedNear,
        SUITE_DEFAULTS.poisonedVendor,
      );
      const requestId = assertRequestId(result?.request_id);
      const { verdictTx, signatureBase58 } = await submitFixtureVerdict(requestId, false);
      const storedReq = await getRequest(provider, guardId, requestId);
      if (storedReq.status !== "held") {
        throw new Error(`Gate purpose-mismatch failed: request ${requestId} is ${storedReq.status}.`);
      }
      console.log(
        formatGateLine(def, {
          requestId,
          tx,
          verdictTx,
          extra: attestationExtra(signatureBase58),
        }),
      );
    }

    // Gate 4: clean transit stages, then the fixture verdict
    // (consistent=true) pays it.
    {
      const def = GATE_DEFS[3];
      const { tx, result } = await requestAsAgent(
        goodPayee,
        SUITE_DEFAULTS.stagedNear,
        SUITE_DEFAULTS.cleanVendor,
      );
      const requestId = assertRequestId(result?.request_id);
      const { verdictTx, signatureBase58 } = await submitFixtureVerdict(requestId, true);
      const storedReq = await getRequest(provider, guardId, requestId);
      if (storedReq.status !== "paid") {
        throw new Error(`Gate clean-transit failed: request ${requestId} is ${storedReq.status}.`);
      }
      console.log(
        formatGateLine(def, {
          requestId,
          tx,
          verdictTx,
          extra: attestationExtra(signatureBase58),
        }),
      );
    }
  } catch (err) {
    console.error(err.message ?? String(err));
    process.exit(1);
  }
}

await main();
