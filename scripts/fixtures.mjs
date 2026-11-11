#!/usr/bin/env node
// Idempotent attack-suite fixture setup: provisions the suite agent,
// seeds purpose refs, tops up the agent allowlist/policy, and registers
// the local suite Ed25519 verifier key — every step safe to run twice.
// Usage: scripts/fixtures.sh --contract <guard-id> [options]
// Env fallbacks: GUARD_CONTRACT_ID (or NEAR_CONTRACT_ID), NEAR_ACCOUNT_ID,
// NEAR_PRIVATE_KEY. Default RPC: testnet.
import { spawnSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, getTransactionLastResult } from "near-api-js";
import bs58 from "bs58";
import {
  agentAccountId,
  keystoreDir,
  nearToYoctoString,
  readKeystore,
  writeKeystore,
} from "./lib/agent-keys.mjs";
import {
  SUITE_DEFAULTS,
  isAlreadyRegisteredMessage,
  resolveGuardId,
} from "./lib/attack-gates.mjs";

const TESTNET_RPC_URL = "https://rpc.testnet.near.org";
const TERA_GAS = 10n ** 12n;
const CALL_GAS = 30n * TERA_GAS;
const VERIFIER_KEY_FILE = "verifier.json";

function usage() {
  return [
    "Usage: scripts/fixtures.sh --contract <guard-id> [options]",
    "",
    "Options:",
    "  --contract <id>      Guard contract account id (required; or $GUARD_CONTRACT_ID / $NEAR_CONTRACT_ID)",
    "  --rpc-url <url>      NEAR RPC endpoint (default: $NEAR_RPC_URL or testnet)",
    "  --account-id <id>    Signer account id: guard owner and agent parent",
    "                       (default: $NEAR_ACCOUNT_ID)",
    "  --private-key <key>  Signer private key ed25519:... (default: $NEAR_PRIVATE_KEY)",
    "  --good-payee <id>    Clean-transit payee (default: $SUITE_GOOD_PAYEE or good.testnet)",
    "  --attacker-payee <id> Held-transit payee (default: $SUITE_ATTACKER_PAYEE or attacker.testnet)",
    "  --help               Print this help and exit 0",
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
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return out;
}

function scriptDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function runHelper(script, args) {
  const res = spawnSync(process.execPath, [join(scriptDir(), script), ...args], {
    stdio: "inherit",
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    console.error(`${script} failed with exit ${res.status}.`);
    process.exit(res.status ?? 1);
  }
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

async function changeAs(owner, contractId, methodName, args) {
  const outcome = await owner.callFunctionRaw({
    contractId,
    methodName,
    args,
    gas: CALL_GAS,
  });
  return { outcome, result: getTransactionLastResult(outcome) };
}

// PKCS#8 DER prefix for an Ed25519 seed (RFC 8410), same bytes as
// `pkcs8Der` in `verifier/src/server.ts`.
function pkcs8Der(seed) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return Buffer.concat([prefix, Buffer.from(seed)]);
}

function spkiDer(publicKey) {
  // SubjectPublicKeyInfo for Ed25519 (RFC 8410).
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return Buffer.concat([prefix, Buffer.from(publicKey)]);
}

// Generate-or-reuse the local suite Ed25519 keypair kept at
// scripts/.agent-keys/verifier.json (0600, git-ignored). The suite signs
// fixture verdicts with this key — never a TEE key — and registers the
// public half via the owner-gated `set_verifier`.
export function resolveSuiteKey(repoRoot) {
  const path = join(keystoreDir(repoRoot), VERIFIER_KEY_FILE);
  const stored = readKeystore(path);
  if (stored?.seedHex) {
    let seed;
    try {
      seed = Buffer.from(stored.seedHex, "hex");
    } catch {
      throw new Error(`Malformed suite key file at ${path}: bad seedHex.`);
    }
    if (seed.length !== 32) {
      throw new Error(`Malformed suite key file at ${path}: seed must be 32 bytes.`);
    }
    const privateKey = createPrivateKey({ key: pkcs8Der(seed), format: "der", type: "pkcs8" });
    const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    const publicBytes = new Uint8Array(publicDer.subarray(publicDer.length - 32));
    const publicKeyBase58 = bs58.encode(publicBytes);
    if (stored.publicKeyBase58 && stored.publicKeyBase58 !== publicKeyBase58) {
      throw new Error(`Suite key file at ${path} is inconsistent: refusing to overwrite.`);
    }
    return { privateKey, publicKeyBytes: publicBytes, publicKeyBase58, path, generated: false };
  }
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({ key: pkcs8Der(seed), format: "der", type: "pkcs8" });
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicBytes = new Uint8Array(publicDer.subarray(publicDer.length - 32));
  const publicKeyBase58 = bs58.encode(publicBytes);
  writeKeystore(path, { publicKeyBase58, seedHex: seed.toString("hex") });
  return { privateKey, publicKeyBytes: publicBytes, publicKeyBase58, path, generated: true };
}

export function signWithSuiteKey(payload, suiteKey) {
  return bs58.encode(new Uint8Array(cryptoSign(null, Buffer.from(payload), suiteKey.privateKey)));
}

export { spkiDer };

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

  const agentId = agentAccountId(SUITE_DEFAULTS.agentRef, signerId);
  const shared = [
    "--contract", guardId,
    "--rpc-url", rpcUrl,
    "--account-id", signerId,
    "--private-key", signerKey,
  ];

  // 1. Provision agent-1 (skips when already provisioned) with both suite
  // payees, then seed the purpose refs (skips "already registered").
  runHelper("provision-agents.mjs", [
    ...shared,
    "--count", "1",
    "--payee", goodPayee,
    "--payee", attackerPayee,
  ]);
  process.env.SUITE_GOOD_PAYEE = goodPayee;
  runHelper("seed-books.mjs", [...shared]);

  const here = scriptDir();
  const repoRoot = join(here, "..");
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const owner = new Account(signerId, provider, KeyPair.fromString(signerKey));

  // 2. Top up the allowlist with suite payees the agent may still miss
  // (the evil probe payee is never allowlisted, by design).
  const agent = await viewFunction(provider, guardId, "get_agent", { agent_id: agentId });
  if (!agent) {
    console.error(`Verification failed: ${agentId} is not registered on ${guardId}.`);
    process.exit(1);
  }
  const allowlist = Array.isArray(agent.payee_allowlist) ? agent.payee_allowlist : [];
  const missing = [goodPayee, attackerPayee].filter((payee) => !allowlist.includes(payee));
  if (missing.length > 0) {
    try {
      await changeAs(owner, guardId, "add_payees", { agent_id: agentId, payees: missing });
      console.log(`fixture payees: added ${missing.join(",")} to ${agentId}`);
    } catch (err) {
      const message = err?.message ?? String(err);
      if (!isAlreadyRegisteredMessage(message)) {
        throw err;
      }
      console.log(`fixture payees: already allowlisted ${missing.join(",")}`);
    }
  } else {
    console.log(`fixture payees: already allowlisted ${goodPayee},${attackerPayee}`);
  }

  // 2b. Verify the purpose-ref book binds invoice-114 to the suite good
  // payee (issue #61): the wrong-payee gate cites it with the attacker
  // payee and expects PurposeRefPayeeMismatch. Seeded once via
  // seed-books.mjs; an older deployment without the payee binding fails
  // closed here with a re-deploy hint.
  try {
    const refs = await viewFunction(provider, guardId, "list_purpose_refs", {});
    const bound = Array.isArray(refs) ? refs.find((ref) => ref?.ref_id === "invoice-114") : undefined;
    if (!bound) {
      console.error("Verification failed: invoice-114 is not registered on-chain.");
      process.exit(1);
    }
    if (bound.payee !== goodPayee) {
      console.error(
        `Verification failed: invoice-114 payee is ${JSON.stringify(bound.payee)}, expected ${JSON.stringify(goodPayee)} (re-deploy the guard so register_purpose_ref binds the payee).`,
      );
      process.exit(1);
    }
    console.log(`fixture purpose ref: invoice-114 bound to ${bound.payee} vendor=${bound.vendor}`);
  } catch (err) {
    if (err?.message?.includes?.("Verification failed")) throw err;
    console.error(`Verification failed: list_purpose_refs unreachable: ${err?.message ?? err}.`);
    process.exit(1);
  }

  // 3. Raise the daily allowance for re-run headroom (staged gates draw
  // down the day on every run); the per-payment cap stays at 10 NEAR so
  // the over-allowance gate keeps firing. Idempotent overwrite.
  const dailyAllowanceYocto = nearToYoctoString(SUITE_DEFAULTS.dailyAllowanceNear, "--daily-allowance");
  const perPaymentCapYocto = nearToYoctoString(SUITE_DEFAULTS.perPaymentCapNear, "--per-payment-cap");
  await changeAs(owner, guardId, "set_agent_policy", {
    agent_id: agentId,
    daily_allowance_yocto: dailyAllowanceYocto,
    per_payment_cap_yocto: perPaymentCapYocto,
  });
  console.log(
    `fixture policy: agent=${agentId} daily=${SUITE_DEFAULTS.dailyAllowanceNear}NEAR cap=${SUITE_DEFAULTS.perPaymentCapNear}NEAR`,
  );

  // 3b. Top up the logical treasury so the clean-transit gate can pay:
  // consistent verdicts hold (no transfer) when the treasury does not
  // cover the amount. Bounded and idempotent: only tops up below a
  // 15 NEAR floor, in a single 20 NEAR owner deposit.
  const treasuryFloorYocto = BigInt(nearToYoctoString("15", "treasury floor"));
  const treasuryTopUpYocto = BigInt(nearToYoctoString("20", "treasury top-up"));
  const treasuryRaw = await viewFunction(provider, guardId, "treasury", {});
  const treasuryText =
    typeof treasuryRaw === "string"
      ? treasuryRaw
      : (treasuryRaw?.U128 ?? treasuryRaw?.u128 ?? String(treasuryRaw));
  const treasuryYocto = /^\d+$/.test(treasuryText) ? BigInt(treasuryText) : 0n;
  if (treasuryYocto < treasuryFloorYocto) {
    await owner.callFunction({
      contractId: guardId,
      methodName: "deposit_fleet_funds",
      args: {},
      gas: CALL_GAS,
      deposit: treasuryTopUpYocto,
    });
    console.log(`fixture treasury: topped up ${treasuryTopUpYocto} yocto`);
  } else {
    console.log(`fixture treasury: already funded (${treasuryYocto} yocto)`);
  }

  // 4. Register the local suite verifier key (generate-or-reuse), then
  // assert the terminal view shows it.
  const suiteKey = resolveSuiteKey(repoRoot);
  console.log(
    `fixture verifier key: ${suiteKey.generated ? "generated" : "reused"} ${suiteKey.path}`,
  );
  await changeAs(owner, guardId, "set_verifier", { public_key_base58: suiteKey.publicKeyBase58 });
  const onChainVerifier = await viewFunction(provider, guardId, "get_verifier", {});
  if (onChainVerifier !== suiteKey.publicKeyBase58) {
    console.error("Verification failed: get_verifier does not show the suite key.");
    process.exit(1);
  }

  console.log(`fixture ready: agent=${agentId} guard=${guardId}`);
  console.log(
    `fixture ready: payees=${[goodPayee, attackerPayee].join(",")} policy daily=${SUITE_DEFAULTS.dailyAllowanceNear}NEAR cap=${SUITE_DEFAULTS.perPaymentCapNear}NEAR`,
  );
  console.log(`fixture ready: verifier=${suiteKey.publicKeyBase58}`);
}

// Side-effect free on import: attack-suite.mjs reuses resolveSuiteKey
// and signWithSuiteKey without provisioning. Only run when executed.
const invokedAsScript =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  await main();
}
