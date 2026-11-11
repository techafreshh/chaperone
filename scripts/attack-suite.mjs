#!/usr/bin/env node
// Attack suite: builds/starts the real app and asserts the live HTTP gates
// (health, fleet, requests, queue, receipts, CSV export) plus the guard
// contract unit tests on every run — then, when testnet credentials are
// present, fires 3 blocked attacks plus 1 clean transit against the guard
// and prints per-gate pass/fail. Fixture verdicts are signed with the
// local suite Ed25519 key registered by scripts/fixtures.mjs — an operator
// fixture, never a TEE attestation (live judgment stays
// `node scripts/verifier-live-smoke.mjs --judge`).
// Usage: scripts/attack-suite.sh [--contract <guard-id>] [options]
// Env: GUARD_CONTRACT_ID (or NEAR_CONTRACT_ID), NEAR_ACCOUNT_ID,
// NEAR_PRIVATE_KEY. Without credentials the chain gates print SKIP and the
// suite exits 0 when the offline gates pass.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  APP_GATE_PAGES,
  GATE_DEFS,
  RECEIPTS_CSV_HEADER,
  SUITE_DEFAULTS,
  buildVerdictPayload,
  createPurposeRefLedger,
  evaluatePurposeRefRequest,
  formatGateLine,
  resolveGuardId,
  txHashOf,
  waitForRequestStatus,
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
    "  --port <n>           App server port (default: $PORT or 3107; a healthy server already",
    "                       on it is reused, otherwise the suite builds/starts/stops its own)",
    "  --skip-app           Skip the app HTTP gates (health/fleet/requests/queue/receipts/CSV)",
    "  --skip-build         Skip `npm run build` (reuse the existing .next production build)",
    "  --skip-chain         Skip the on-chain gates (no testnet credentials needed)",
    "  --skip-cargo         Skip `cargo test -p chaperone-guard`",
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
    } else if (arg === "--port" && i + 1 < argv.length) {
      out.port = argv[(i += 1)];
    } else if (arg === "--skip-app") {
      out.skipApp = true;
    } else if (arg === "--skip-build") {
      out.skipBuild = true;
    } else if (arg === "--skip-chain") {
      out.skipChain = true;
    } else if (arg === "--skip-cargo") {
      out.skipCargo = true;
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

// Native balance of an existing account, as yoctoNEAR bigint. Throws a
// labeled gate-setup error when the account does not exist — a real
// transfer needs a real payee.
async function viewAccountBalance(provider, accountId) {
  let res;
  try {
    res = await provider.query({
      request_type: "view_account",
      account_id: accountId,
      finality: "final",
    });
  } catch (err) {
    throw new Error(
      `Gate clean-transit failed: payee ${accountId} does not exist ` +
        `(pass --good-payee with an existing account): ${err?.message ?? err}.`,
    );
  }
  return BigInt(res.amount);
}

// Logical treasury balance (`treasury()` view), normalized from the
// contract's U128 string shape to bigint.
async function viewTreasury(provider, contractId) {
  const raw = await viewFunction(provider, contractId, "treasury", {});
  const text =
    typeof raw === "string" ? raw : (raw?.U128 ?? raw?.u128 ?? String(raw));
  if (!/^\d+$/.test(text)) {
    throw new Error(`Gate clean-transit failed: bad treasury shape ${JSON.stringify(raw)}.`);
  }
  return BigInt(text);
}

function assertRequestId(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Bad request_payment shape: request_id is ${JSON.stringify(value)}.`);
  }
  return value;
}

// Offline fixture replay of the two purpose-ref gates (issue #61): no
// network, no credentials. Mirrors the contract intake order
// (payee -> vendor -> remaining) via the pure ledger in
// `lib/attack-gates.mjs`. Runs on every invocation so
// `scripts/attack-suite.sh` offline reports both gates as PASS with
// their reason codes.
function runOfflinePurposeRefGates() {
  const NEAR = 10n ** 24n;
  // Gate wrong-payee: second allowlisted payee cites a ref bound to the first.
  {
    const ledger = createPurposeRefLedger({
      refId: "invoice-114",
      vendor: "CoreWeave",
      payee: "a.near",
      maxYocto: (50n * NEAR).toString(),
    });
    const out = evaluatePurposeRefRequest(ledger, {
      payee: "b.near",
      vendor: "CoreWeave",
      amountYocto: (30n * NEAR).toString(),
    });
    if (out.status !== "rejected" || out.reason !== "PurposeRefPayeeMismatch") {
      throw new Error(`Offline gate wrong-payee failed: got ${out.status}/${out.reason ?? null}.`);
    }
    console.log(`GATE wrong-payee: PASS reason=${out.reason} payee=b.near ref=invoice-114`);
  }
  // Gate same-invoice-twice: the second payment is above what is left.
  {
    const ledger = createPurposeRefLedger({
      refId: "invoice-114",
      vendor: "CoreWeave",
      payee: "a.near",
      maxYocto: (50n * NEAR).toString(),
    });
    const first = evaluatePurposeRefRequest(ledger, {
      payee: "a.near",
      vendor: "CoreWeave",
      amountYocto: (30n * NEAR).toString(),
    });
    if (first.status !== "staged") {
      throw new Error(`Offline gate same-invoice-twice setup failed: first is ${first.status}.`);
    }
    const second = evaluatePurposeRefRequest(ledger, {
      payee: "a.near",
      vendor: "CoreWeave",
      amountYocto: (30n * NEAR).toString(),
    });
    if (second.status !== "rejected" || second.reason !== "ExceedsPurposeRefRemaining") {
      throw new Error(`Offline gate same-invoice-twice failed: got ${second.status}/${second.reason ?? null}.`);
    }
    console.log(`GATE same-invoice-twice: PASS reason=${second.reason} remaining=20000000000000000000000000`);
  }
}

// ---- App HTTP gates (issue #21, offline, fixture-backed) ----
// These run on every invocation unless `--skip-app`: they build the real
// production bundle, start the real Next.js server, and assert the live
// HTTP responses the acceptance probes check — health, the four fleet
// agents, a TEE-verified row, and the CSV audit header.

const APP_HEALTH_TIMEOUT_MS = 120000;
const APP_POLL_MS = 1000;

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid --port ${JSON.stringify(raw)}: expected 1-65535.`);
    process.exit(2);
  }
  return port;
}

async function probeHealth(base) {
  try {
    const res = await fetch(`${base}/api/health`);
    if (res.status !== 200) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealth(base, server) {
  const deadline = Date.now() + APP_HEALTH_TIMEOUT_MS;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(`app gate: server exited with code ${server.exitCode} before becoming healthy.`);
    }
    if (await probeHealth(base)) return;
    if (Date.now() >= deadline) {
      throw new Error(`app gate: server on ${base} unhealthy after ${APP_HEALTH_TIMEOUT_MS}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, APP_POLL_MS));
  }
}

async function assertPage(base, path, mustContain = []) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`app gate ${path}: HTTP ${res.status}, expected 200.`);
  }
  for (const needle of mustContain) {
    if (!text.includes(needle)) {
      throw new Error(`app gate ${path}: missing ${JSON.stringify(needle)}.`);
    }
  }
  console.log(`app gate ${path}: 200 + probe strings ok`);
  return text;
}

async function runAppGates({ port, skipBuild, appDir }) {
  const base = `http://127.0.0.1:${port}`;
  let server = null;
  const stopServer = () => {
    // The server is spawned detached so one signal takes down the whole
    // `npm run start` -> `next-server` group: killing only the npm parent
    // orphans next-server and leaks the port.
    if (server && server.exitCode === null && server.pid !== undefined) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        try {
          server.kill("SIGTERM");
        } catch {
          // Already gone; teardown is best-effort.
        }
      }
    }
  };
  process.once("exit", stopServer);
  try {
    if (await probeHealth(base)) {
      console.log(`app gate: reusing healthy server on ${base}`);
    } else {
      if (!skipBuild) {
        console.log("app gate: building production bundle (npm run build)...");
        const build = spawnSync("npm", ["--prefix", appDir, "run", "build"], {
          stdio: "inherit",
        });
        if (build.error) {
          throw build.error;
        }
        if (build.status !== 0) {
          console.error(`app gate: npm run build failed with exit ${build.status}.`);
          process.exit(1);
        }
      } else if (!existsSync(join(appDir, ".next"))) {
        console.log("app gate: --skip-build with no .next directory; `next start` will fail fast.");
      }
      console.log(`app gate: starting production server on ${base}...`);
      server = spawn("npm", ["--prefix", appDir, "run", "start", "--", "-p", String(port)], {
        stdio: "ignore",
        detached: true,
      });
      server.on("error", () => {});
      await waitForHealth(base, server);
      console.log(`app gate: server healthy on ${base}`);
    }

    await assertPage(base, "/api/health", ['"ok":true']);
    await assertPage(base, "/fleet", ["agent-1", "agent-2", "agent-3", "agent-4"]);
    for (const page of APP_GATE_PAGES.filter((page) => page !== "/fleet")) {
      await assertPage(base, page);
    }
    const requests = await assertPage(base, "/requests", ["TEE-verified"]);
    void requests;
    const csvRes = await fetch(`${base}/api/audit/export?format=csv`);
    const csv = await csvRes.text();
    if (csvRes.status !== 200) {
      throw new Error(`app gate /api/audit/export?format=csv: HTTP ${csvRes.status}, expected 200.`);
    }
    if (!csv.startsWith(RECEIPTS_CSV_HEADER)) {
      throw new Error(
        `app gate /api/audit/export?format=csv: missing header ${RECEIPTS_CSV_HEADER}.`,
      );
    }
    console.log(`app gate /api/audit/export?format=csv: 200 + header ${RECEIPTS_CSV_HEADER}`);
  } finally {
    process.removeListener("exit", stopServer);
    stopServer();
  }
}

function runCargoTests(repoRoot) {
  console.log("contract gate: cargo test -p chaperone-guard...");
  const res = spawnSync("cargo", ["test", "-p", "chaperone-guard"], {
    cwd: join(repoRoot, "contract"),
    stdio: "inherit",
  });
  if (res.error) {
    console.log(`SKIP: cargo unavailable (${res.error.message}).`);
    return;
  }
  if (res.status !== 0) {
    console.error(`contract gate: cargo test failed with exit ${res.status}.`);
    process.exit(1);
  }
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

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const appDir = join(repoRoot, "app");
  const port = parsePort(args.port ?? process.env.PORT ?? "3107");

  // Purpose-ref offline gates run on every invocation (no network):
  // both print PASS with their reason codes even without credentials.
  try {
    runOfflinePurposeRefGates();
  } catch (err) {
    console.error(err.message ?? String(err));
    process.exit(1);
  }

  // App HTTP gates run on every invocation (offline, fixture-backed)
  // unless skipped; they tear their server down before the chain gates.
  if (!args.skipApp) {
    try {
      await runAppGates({ port, skipBuild: Boolean(args.skipBuild), appDir });
    } catch (err) {
      console.error(err.message ?? String(err));
      process.exit(1);
    }
  }
  if (!args.skipCargo) {
    runCargoTests(repoRoot);
  }

  // Chain gates need the guard id plus signer credentials; without them
  // print SKIP and exit 0 when the offline gates already passed (merge
  // tier needs no live secrets). `--skip-chain` forces the same path.
  let guardId = null;
  try {
    guardId = resolveGuardId(process.env, args.contract);
  } catch {
    guardId = null;
  }
  const signerId = args.accountId ?? process.env.NEAR_ACCOUNT_ID;
  const signerKey = args.privateKey ?? process.env.NEAR_PRIVATE_KEY;
  if (args.skipChain || !guardId || !signerId || !signerKey) {
    if (!args.skipChain) {
      console.log(
        "SKIP: chain gates need --contract (or $GUARD_CONTRACT_ID/$NEAR_CONTRACT_ID) plus " +
          "NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY; app gates passed, exiting 0.",
      );
    } else {
      console.log("SKIP: chain gates skipped by --skip-chain; exiting 0.");
    }
    return;
  }
  const rpcUrl = args.rpcUrl ?? process.env.NEAR_RPC_URL ?? TESTNET_RPC_URL;
  const goodPayee = args.goodPayee ?? process.env.SUITE_GOOD_PAYEE ?? SUITE_DEFAULTS.goodPayee;
  const attackerPayee =
    args.attackerPayee ?? process.env.SUITE_ATTACKER_PAYEE ?? SUITE_DEFAULTS.attackerPayee;
  const evilPayee = args.evilPayee ?? process.env.SUITE_EVIL_PAYEE ?? SUITE_DEFAULTS.evilPayee;

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

  async function requestAsAgent(payee, amountNear, vendor, purposeRef = SUITE_DEFAULTS.purposeRef) {
    const outcome = await agent.callFunctionRaw({
      contractId: guardId,
      methodName: "request_payment",
      args: {
        payee,
        amount_yocto: nearToYoctoString(amountNear, "amount"),
        purpose_ref: purposeRef,
        vendor,
      },
      gas: CALL_GAS,
    });
    return { tx: txHashOf(outcome), result: getTransactionLastResult(outcome) };
  }

  async function registerEphemeralRef(refId, vendor, payee, maxNear) {
    const outcome = await owner.callFunctionRaw({
      contractId: guardId,
      methodName: "register_purpose_ref",
      args: {
        ref_id: refId,
        vendor,
        payee,
        max_amount_yocto: nearToYoctoString(maxNear, "max"),
      },
      gas: CALL_GAS,
    });
    return txHashOf(outcome);
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
    // Ephemeral refs isolate the new purpose-ref live gates from the
    // seeded book state (prior runs commit/paid amounts on invoice-114):
    // a held ref bound to the attacker payee with the poisoned vendor,
    // and a twice ref bound to the good payee for the double-spend.
    const runTag = Date.now().toString(36);
    const heldRefId = `suite-held-${runTag}`;
    const twiceRefId = `suite-twice-${runTag}`;
    await registerEphemeralRef(heldRefId, SUITE_DEFAULTS.poisonedVendor, attackerPayee, "30");
    console.log(`fixture ephemeral ref: ${heldRefId} vendor=${SUITE_DEFAULTS.poisonedVendor} payee=${attackerPayee}`);
    await registerEphemeralRef(twiceRefId, SUITE_DEFAULTS.cleanVendor, goodPayee, "5");
    console.log(`fixture ephemeral ref: ${twiceRefId} vendor=${SUITE_DEFAULTS.cleanVendor} payee=${goodPayee}`);

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
    // the fixture verdict (consistent=false) holds it. The held ref is
    // bound to the attacker payee with the poisoned vendor so the new
    // payee/vendor checks pass and the judge path still holds.
    {
      const def = GATE_DEFS[2];
      const { tx, result } = await requestAsAgent(
        attackerPayee,
        SUITE_DEFAULTS.stagedNear,
        SUITE_DEFAULTS.poisonedVendor,
        heldRefId,
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
    // (consistent=true) pays it for real. The transfer settles in a
    // later receipt than the verdict transaction, so the gate polls to
    // `paid` and then asserts the money moved: the payee gains exactly
    // the requested amount and the treasury falls by the same.
    {
      const def = GATE_DEFS[3];
      const expectedDelta = BigInt(nearToYoctoString(SUITE_DEFAULTS.stagedNear, "staged amount"));
      const payeeBefore = await viewAccountBalance(provider, goodPayee);
      const treasuryBefore = await viewTreasury(provider, guardId);
      const { tx, result } = await requestAsAgent(
        goodPayee,
        SUITE_DEFAULTS.stagedNear,
        SUITE_DEFAULTS.cleanVendor,
      );
      const requestId = assertRequestId(result?.request_id);
      const { verdictTx, signatureBase58 } = await submitFixtureVerdict(requestId, true);
      const storedReq = await waitForRequestStatus(
        (id) => getRequest(provider, guardId, id),
        requestId,
        ["paid"],
      );
      if (storedReq.status !== "paid") {
        throw new Error(`Gate clean-transit failed: request ${requestId} is ${storedReq.status}.`);
      }
      const payeeAfter = await viewAccountBalance(provider, goodPayee);
      const treasuryAfter = await viewTreasury(provider, guardId);
      const payeeDelta = payeeAfter - payeeBefore;
      const treasuryDelta = treasuryBefore - treasuryAfter;
      if (payeeDelta !== expectedDelta) {
        throw new Error(
          `Gate clean-transit failed: payee balance moved by ${payeeDelta} yocto, expected ${expectedDelta}.`,
        );
      }
      if (treasuryDelta !== expectedDelta) {
        throw new Error(
          `Gate clean-transit failed: treasury moved by ${treasuryDelta} yocto, expected ${expectedDelta}.`,
        );
      }
      console.log(
        formatGateLine(def, {
          requestId,
          tx,
          verdictTx,
          extra: `${attestationExtra(signatureBase58)} balance_delta=${payeeDelta}`,
        }),
      );
    }

    // Gate 5: right invoice, wrong payee — an allowlisted attacker payee
    // cites invoice-114 bound to the good payee.
    {
      const wrongDef = GATE_DEFS[5];
      const { tx, result } = await requestAsAgent(
        attackerPayee,
        SUITE_DEFAULTS.allowlistProbeNear,
        SUITE_DEFAULTS.cleanVendor,
      );
      const requestId = assertRequestId(result?.request_id);
      const storedReq = await getRequest(provider, guardId, requestId);
      if (storedReq.status !== "rejected" || storedReq.reason !== "PurposeRefPayeeMismatch") {
        throw new Error(
          `Gate wrong-payee failed: request ${requestId} is ${storedReq.status}/${storedReq.reason}.`,
        );
      }
      console.log(
        `${formatGateLine(wrongDef, { requestId, tx })} reason=PurposeRefPayeeMismatch PASS`,
      );
    }

    // Gate 6: same invoice twice — the second payment is above what is
    // left of the twice ref (5 max, 3 committed, 3 requested).
    {
      const def = GATE_DEFS[4];
      const first = await requestAsAgent(goodPayee, "3", SUITE_DEFAULTS.cleanVendor, twiceRefId);
      const firstId = assertRequestId(first.result?.request_id);
      const firstStored = await getRequest(provider, guardId, firstId);
      if (firstStored.status !== "staged") {
        throw new Error(`Gate same-invoice-twice setup failed: request ${firstId} is ${firstStored.status}.`);
      }
      const { tx, result } = await requestAsAgent(goodPayee, "3", SUITE_DEFAULTS.cleanVendor, twiceRefId);
      const requestId = assertRequestId(result?.request_id);
      const storedReq = await getRequest(provider, guardId, requestId);
      if (storedReq.status !== "rejected" || storedReq.reason !== "ExceedsPurposeRefRemaining") {
        throw new Error(
          `Gate same-invoice-twice failed: request ${requestId} is ${storedReq.status}/${storedReq.reason}.`,
        );
      }
      console.log(
        `${formatGateLine(def, { requestId, tx })} reason=ExceedsPurposeRefRemaining PASS`,
      );
    }
  } catch (err) {
    console.error(err.message ?? String(err));
    process.exit(1);
  }
}

await main();
