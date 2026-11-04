// near-workspaces sandbox round trip (issue #21): deploy the locally built
// guard WASM to a sandbox worker, register 4 agents, replay the three
// deterministic on-chain blocks plus one staged clean transit, then run
// the kill-switch + function-call-key revoke round trip — the exact live
// deploy/attack sequence against a local mini-chain instead of testnet.
//
// Merge tier needs no live secrets and never touches testnet or the
// faucet: without the built WASM (or without `near-workspaces`/the sandbox
// binary, which needs network on first use) the CLI prints SKIP and
// exits 0. Only `--live` (implied: this script always runs live against
// the sandbox when it can) fails closed on assertion mismatches.
// Usage: node scripts/sandbox-verify.mjs [--wasm <path>]
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DAILY_ALLOWANCE_YOCTO,
  DEFAULT_PER_PAYMENT_CAP_YOCTO,
  FC_ALLOWANCE_YOCTO,
  FC_METHOD_NAMES,
} from "./lib/agent-keys.mjs";
import { DEFAULT_WASM_PATH } from "./lib/deploy-plan.mjs";

// Rejection reasons asserted per gate, mirroring
// `REASON_*` in `contract/src/request.rs`. The mapping (not the strings)
// is the contract under test: each gate must reject with its own reason.
export const REJECT_REASONS = {
  overAllowance: "ExceedsPerPaymentCap",
  allowlist: "PayeeNotAllowlisted",
  purposeRef: "PurposeRefNotFound",
  inactive: "AgentInactive",
};

export function expectedRejectReason(gateKey) {
  const reason = REJECT_REASONS[gateKey];
  if (typeof reason !== "string") {
    throw new Error(`Unknown sandbox gate: ${JSON.stringify(gateKey)}`);
  }
  return reason;
}

// Pure predicate over an RPC `view_access_keys` entry: true only when the
// key is function-call-scoped to the guard with the exact agent method
// set and an explicit non-zero allowance (the `agent-keys.mjs` lock rule).
export function isGuardScopedKeyShape(key, guardId) {
  const permission = key?.access_key?.permission?.FunctionCall ?? null;
  if (!permission || permission.receiver_id !== guardId) {
    return false;
  }
  const allowance = String(permission.allowance ?? "");
  if (!/^\d+$/.test(allowance) || !/[1-9]/.test(allowance)) {
    return false;
  }
  const methods = permission.method_names ?? [];
  return FC_METHOD_NAMES.every((method) => methods.includes(method));
}

export function sandboxUsage() {
  return [
    "Usage: node scripts/sandbox-verify.mjs [options]",
    "",
    "Options:",
    "  --wasm <path>  Guard WASM to deploy (default: contract/target/.../chaperone_guard.wasm)",
    "  --help         Print this help and exit 0",
    "",
    "Without the built WASM (or without near-workspaces/the sandbox binary)",
    "the script prints SKIP and exits 0. With them, it runs the full",
    "deploy -> 4 agents -> 3 blocks + 1 staged transit -> kill-switch +",
    "key-revoke round trip and exits non-zero on any mismatch.",
  ].join("\n");
}

export function parseSandboxArgs(argv) {
  const out = { help: false, wasm: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--wasm" && i + 1 < argv.length) {
      out.wasm = argv[(i += 1)];
    } else {
      throw new Error(`Unknown argument: ${arg}\n${sandboxUsage()}`);
    }
  }
  return out;
}

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function assertOutcome(outcome, { status, reason }, gate) {
  if (outcome?.status !== status || (reason ?? null) !== (outcome?.reason ?? null)) {
    throw new Error(
      `Sandbox gate ${gate} failed: got ${outcome?.status}/${outcome?.reason ?? null}, ` +
        `expected ${status}/${reason ?? null}.`,
    );
  }
  console.log(`sandbox gate ${gate}: ${status}${reason ? `/${reason}` : ""} request_id=${outcome.request_id}`);
}

async function main() {
  let args;
  try {
    args = parseSandboxArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    console.log(sandboxUsage());
    return;
  }

  const wasmAbs = resolve(repoRoot(), args.wasm ?? DEFAULT_WASM_PATH);
  if (!existsSync(wasmAbs)) {
    console.log(
      `SKIP: guard WASM not built at ${wasmAbs} — run cargo build -p chaperone-guard --target wasm32-unknown-unknown --release to enable the sandbox round trip.`,
    );
    return;
  }

  let Worker;
  try {
    ({ Worker } = await import("near-workspaces"));
  } catch (err) {
    console.log(`SKIP: near-workspaces unavailable (${err?.message ?? err}).`);
    return;
  }
  let nearApi;
  try {
    nearApi = await import("near-api-js");
  } catch (err) {
    console.log(`SKIP: near-api-js unavailable (${err?.message ?? err}).`);
    return;
  }
  // NB: functionCallAccessKey lives under the `actions` namespace, not
  // the package root (verified against the installed near-api-js).
  const { KeyPair } = nearApi;
  const { functionCallAccessKey } = nearApi.actions ?? {};
  if (typeof functionCallAccessKey !== "function") {
    console.log("SKIP: near-api-js actions.functionCallAccessKey unavailable.");
    return;
  }

  let worker;
  try {
    worker = await Worker.init();
  } catch (err) {
    console.log(`SKIP: sandbox worker unavailable (${err?.message ?? err}).`);
    return;
  }

  try {
    const root = worker.rootAccount;
    const contract = await root.devDeploy(wasmAbs, {
      method: "new",
      args: { owner_id: root.accountId },
    });
    const contractId = contract.accountId;
    console.log(`sandbox contract: ${contractId}`);

    const GOOD_PAYEE = "good.test.near";
    const EVIL_PAYEE = "evil-probe.test.near";
    const PURPOSE_REF = "invoice-114";

    // Four agents with the same policy the live scripts apply.
    const agents = [];
    for (let i = 1; i <= 4; i += 1) {
      const agent = await root.createSubAccount(`agent-${i}`);
      await root.call(contract, "register_agent", {
        agent_id: agent.accountId,
        daily_allowance_yocto: DEFAULT_DAILY_ALLOWANCE_YOCTO,
        per_payment_cap_yocto: DEFAULT_PER_PAYMENT_CAP_YOCTO,
        payee_allowlist: [GOOD_PAYEE],
      });
      agents.push(agent);
    }
    const listed = await contract.view("list_agents", {});
    if (!Array.isArray(listed) || listed.length !== 4) {
      throw new Error(`Sandbox setup failed: list_agents has ${listed?.length ?? "?"} agents, expected 4.`);
    }
    console.log(`sandbox agents: list_agents contains 4 agents`);

    await root.call(contract, "register_purpose_ref", {
      ref_id: PURPOSE_REF,
      vendor: "CoreWeave",
      max_amount_yocto: "30000000000000000000000000",
    });

    const [agent1, agent2] = agents;

    // Gate 1: 20 NEAR clears the 10 NEAR per-payment cap.
    assertOutcome(
      await agent1.call(contract, "request_payment", {
        payee: GOOD_PAYEE,
        amount_yocto: "20000000000000000000000000",
        purpose_ref: PURPOSE_REF,
        vendor: "CoreWeave",
      }),
      { status: "rejected", reason: expectedRejectReason("overAllowance") },
      "over-allowance",
    );

    // Gate 2: the evil probe payee is never allowlisted.
    assertOutcome(
      await agent1.call(contract, "request_payment", {
        payee: EVIL_PAYEE,
        amount_yocto: "1000000000000000000000000",
        purpose_ref: PURPOSE_REF,
        vendor: "CoreWeave",
      }),
      { status: "rejected", reason: expectedRejectReason("allowlist") },
      "allowlist",
    );

    // Gate 3: unknown purpose ref.
    assertOutcome(
      await agent1.call(contract, "request_payment", {
        payee: GOOD_PAYEE,
        amount_yocto: "1000000000000000000000000",
        purpose_ref: "invoice-999",
        vendor: "CoreWeave",
      }),
      { status: "rejected", reason: expectedRejectReason("purposeRef") },
      "unknown-purpose-ref",
    );

    // Clean transit stages (no verdict submitted in the sandbox path).
    const staged = await agent1.call(contract, "request_payment", {
      payee: GOOD_PAYEE,
      amount_yocto: "5000000000000000000000000",
      purpose_ref: PURPOSE_REF,
      vendor: "CoreWeave",
    });
    assertOutcome(staged, { status: "staged", reason: null }, "clean-transit");
    const stored = await contract.view("get_request", { request_id: staged.request_id });
    if (stored?.status !== "staged") {
      throw new Error(`Sandbox clean-transit failed: get_request(${staged.request_id}) is ${stored?.status}.`);
    }

    // Kill-switch: freeze agent-1 on-chain, then prove intake stops.
    await root.call(contract, "set_agent_active", { agent_id: agent1.accountId, active: false });
    const frozen = await contract.view("get_agent", { agent_id: agent1.accountId });
    if (frozen?.active !== false) {
      throw new Error(`Sandbox kill-switch failed: agent ${agent1.accountId} still active.`);
    }
    assertOutcome(
      await agent1.call(contract, "request_payment", {
        payee: GOOD_PAYEE,
        amount_yocto: "1000000000000000000000000",
        purpose_ref: PURPOSE_REF,
        vendor: "CoreWeave",
      }),
      { status: "rejected", reason: expectedRejectReason("inactive") },
      "kill-switch",
    );
    console.log(`sandbox kill-switch: ${agent1.accountId} frozen on-chain`);

    // Function-call-key revoke round trip on agent-2 (still active):
    // add a guard-scoped key, assert the lock shape, delete it, assert gone.
    const { functionCallAccessKey } = nearApi;
    const scopedPair = KeyPair.fromRandom("ed25519");
    const scopedPub = scopedPair.getPublicKey().toString();
    await agent2
      .batch(agent2)
      .addKey(
        scopedPub,
        functionCallAccessKey(contractId, [...FC_METHOD_NAMES], BigInt(FC_ALLOWANCE_YOCTO)),
      )
      .transact();
    const afterAdd = await root.viewAccessKeys(agent2.accountId);
    const added = (afterAdd?.keys ?? []).find((key) => key.public_key === scopedPub);
    if (!isGuardScopedKeyShape(added, contractId)) {
      throw new Error(`Sandbox key-scope failed: added key on ${agent2.accountId} is not guard-scoped.`);
    }
    console.log(`sandbox key-scope: guard-scoped key verified on ${agent2.accountId}`);
    await agent2.batch(agent2).deleteKey(scopedPub).transact();
    const afterDel = await root.viewAccessKeys(agent2.accountId);
    if ((afterDel?.keys ?? []).some((key) => key.public_key === scopedPub)) {
      throw new Error(`Sandbox key-revoke failed: key still present on ${agent2.accountId}.`);
    }
    console.log(`sandbox key-revoke: key deleted on ${agent2.accountId}`);

    console.log("sandbox verify: all gates passed");
  } finally {
    await worker.tearDown();
  }
}

// Side-effect free on import: attack-suite/tests reuse the pure helpers
// without running the sandbox. Only run when executed.
const invokedAsScript =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  try {
    await main();
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}
