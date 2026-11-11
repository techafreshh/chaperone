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
import { buildVerdictPayload, waitForRequestStatus } from "./lib/attack-gates.mjs";

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
    "deploy -> 4 agents -> 3 blocks + 1 staged transit -> real-NEAR payout",
    "round trip (paid balances, underfunded hold + approve, failed-transfer",
    "refund, reject spend release) -> kill-switch + key-revoke round trip",
    "and exits non-zero on any mismatch.",
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

const YOCTO_PER_NEAR = 10n ** 24n;

export function nearToYocto(near) {
  return (BigInt(near) * YOCTO_PER_NEAR).toString();
}

// Normalize a U128 view value (decimal string or `{ U128 }` wrapper) to
// bigint for exact balance math.
export function u128ToBigInt(raw, what) {
  const text =
    typeof raw === "string" ? raw : (raw?.U128 ?? raw?.u128 ?? String(raw));
  if (!/^\d+$/.test(text)) {
    throw new Error(`Sandbox ${what} failed: bad U128 shape ${JSON.stringify(raw)}.`);
  }
  return BigInt(text);
}

async function viewTreasury(contract) {
  return u128ToBigInt(await contract.view("treasury", {}), "treasury");
}

async function viewSpentToday(contract, agentId) {
  const view = await contract.view("get_agent", { agent_id: agentId });
  if (!view) {
    throw new Error(`Sandbox spend read failed: ${agentId} is not registered.`);
  }
  return u128ToBigInt(view.spent_today_yocto, "spend");
}

async function viewNativeBalance(account) {
  return BigInt((await account.balance()).available);
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

    // Payout round trip (issue #60): consistent verdicts and hold
    // approvals move real NEAR. The transfer settles in a later receipt
    // than the verdict transaction, so every paid assertion polls to the
    // terminal state first. `paid` can only be written by the private
    // `on_payout` callback in the same execution that emits
    // `request_paid`, so reaching `paid` proves the receipt log too.
    const { resolveSuiteKey, signWithSuiteKey } = await import("./fixtures.mjs");
    const suiteKey = resolveSuiteKey(repoRoot());
    await root.call(contract, "set_verifier", {
      public_key_base58: suiteKey.publicKeyBase58,
    });
    console.log("sandbox payout: verifier key registered");

    // Fund the logical treasury: 10 NEAR covers every payout below.
    await root.call(
      contract,
      "deposit_fleet_funds",
      {},
      { attachedDeposit: 10n * YOCTO_PER_NEAR },
    );
    if ((await viewTreasury(contract)) !== 10n * YOCTO_PER_NEAR) {
      throw new Error("Sandbox payout setup failed: treasury is not 10 NEAR.");
    }

    // A payee that really exists: the transfer must land somewhere.
    const payee = await root.createSubAccount("payee");
    await root.call(contract, "add_payees", {
      agent_id: agents[1].accountId,
      payees: [payee.accountId],
    });

    async function submitPayoutVerdict(requestId, consistent) {
      const record = await contract.view("get_request", { request_id: requestId });
      if (record?.status !== "staged") {
        throw new Error(
          `Sandbox payout setup failed: request ${requestId} is ${record?.status}, expected staged.`,
        );
      }
      const signatureBase58 = signWithSuiteKey(
        buildVerdictPayload(record, consistent),
        suiteKey,
      );
      await root.call(contract, "submit_verdict", {
        request_id: requestId,
        consistent,
        signature_base58: signatureBase58,
      });
    }

    async function waitSettled(requestId, want) {
      return waitForRequestStatus(
        (id) => contract.view("get_request", { request_id: id }),
        requestId,
        want,
        { tries: 40, delayMs: 500 },
      );
    }

    // Gate A: consistent verdict pays 2 NEAR for real.
    {
      const payeeBefore = await viewNativeBalance(payee);
      const treasuryBefore = await viewTreasury(contract);
      const outcome = await agents[1].call(contract, "request_payment", {
        payee: payee.accountId,
        amount_yocto: nearToYocto(2),
        purpose_ref: PURPOSE_REF,
        vendor: "CoreWeave",
      });
      assertOutcome(outcome, { status: "staged", reason: null }, "payout-request");
      await submitPayoutVerdict(outcome.request_id, true);
      const settled = await waitSettled(outcome.request_id, ["paid"]);
      if (settled.status !== "paid") {
        throw new Error(`Sandbox payout failed: request ${outcome.request_id} is ${settled.status}.`);
      }
      const payeeDelta = (await viewNativeBalance(payee)) - payeeBefore;
      const treasuryDelta = treasuryBefore - (await viewTreasury(contract));
      if (payeeDelta !== 2n * YOCTO_PER_NEAR) {
        throw new Error(`Sandbox payout failed: payee gained ${payeeDelta} yocto, expected 2 NEAR.`);
      }
      if (treasuryDelta !== 2n * YOCTO_PER_NEAR) {
        throw new Error(`Sandbox payout failed: treasury fell by ${treasuryDelta} yocto, expected 2 NEAR.`);
      }
      console.log(
        `sandbox payout: paid request=${outcome.request_id} balance_delta=${payeeDelta} treasury_delta=${treasuryDelta}`,
      );
    }

    // Gate B: 2 NEAR against a 1 NEAR treasury holds with
    // InsufficientTreasury (no money moves); topping up to 6 NEAR and
    // approving the hold then pays.
    {
      const treasuryAfterA = await viewTreasury(contract);
      await root.call(contract, "withdraw_fleet_funds", {
        to: root.accountId,
        amount: (treasuryAfterA - YOCTO_PER_NEAR).toString(),
      });
      if ((await viewTreasury(contract)) !== YOCTO_PER_NEAR) {
        throw new Error("Sandbox underfunded setup failed: treasury is not 1 NEAR.");
      }
      const payeeBefore = await viewNativeBalance(payee);
      const outcome = await agents[1].call(contract, "request_payment", {
        payee: payee.accountId,
        amount_yocto: nearToYocto(2),
        purpose_ref: PURPOSE_REF,
        vendor: "CoreWeave",
      });
      assertOutcome(outcome, { status: "staged", reason: null }, "underfunded-request");
      await submitPayoutVerdict(outcome.request_id, true);
      const held = await contract.view("get_request", { request_id: outcome.request_id });
      if (held?.status !== "held" || held?.reason !== "InsufficientTreasury") {
        throw new Error(
          `Sandbox underfunded failed: request ${outcome.request_id} is ${held?.status}/${held?.reason ?? null}.`,
        );
      }
      if ((await viewNativeBalance(payee)) !== payeeBefore) {
        throw new Error("Sandbox underfunded failed: payee balance moved without payment.");
      }
      if ((await viewTreasury(contract)) !== YOCTO_PER_NEAR) {
        throw new Error("Sandbox underfunded failed: treasury moved without payment.");
      }
      console.log(
        `sandbox payout-underfunded: held request=${outcome.request_id} reason=InsufficientTreasury`,
      );

      await root.call(
        contract,
        "deposit_fleet_funds",
        {},
        { attachedDeposit: 5n * YOCTO_PER_NEAR },
      );
      const treasuryBeforeApprove = await viewTreasury(contract);
      await root.call(contract, "approve_hold", { request_id: outcome.request_id });
      const settled = await waitSettled(outcome.request_id, ["paid"]);
      if (settled.status !== "paid") {
        throw new Error(`Sandbox approve failed: request ${outcome.request_id} is ${settled.status}.`);
      }
      const payeeDelta = (await viewNativeBalance(payee)) - payeeBefore;
      const treasuryDelta = treasuryBeforeApprove - (await viewTreasury(contract));
      if (payeeDelta !== 2n * YOCTO_PER_NEAR || treasuryDelta !== 2n * YOCTO_PER_NEAR) {
        throw new Error(
          `Sandbox approve failed: payee_delta=${payeeDelta} treasury_delta=${treasuryDelta}, expected 2 NEAR each.`,
        );
      }
      console.log(
        `sandbox payout-approve: paid request=${outcome.request_id} balance_delta=${payeeDelta} treasury_delta=${treasuryDelta}`,
      );
    }

    // Gate C: a transfer to an account id that does not exist settles
    // `failed` with reason TransferFailed; the treasury debit and the
    // agent's spent-today are both restored.
    {
      const ghostPayee = `no-such-payee.${root.accountId}`;
      await root.call(contract, "add_payees", {
        agent_id: agents[1].accountId,
        payees: [ghostPayee],
      });
      const treasuryBefore = await viewTreasury(contract);
      const spentBefore = await viewSpentToday(contract, agents[1].accountId);
      const outcome = await agents[1].call(contract, "request_payment", {
        payee: ghostPayee,
        amount_yocto: nearToYocto(1),
        purpose_ref: PURPOSE_REF,
        vendor: "CoreWeave",
      });
      assertOutcome(outcome, { status: "staged", reason: null }, "ghost-request");
      await submitPayoutVerdict(outcome.request_id, true);
      const settled = await waitSettled(outcome.request_id, ["paid", "failed"]);
      if (settled.status !== "failed" || settled.reason !== "TransferFailed") {
        throw new Error(
          `Sandbox ghost-payee failed: request ${outcome.request_id} is ${settled.status}/${settled.reason ?? null}.`,
        );
      }
      if ((await viewTreasury(contract)) !== treasuryBefore) {
        throw new Error("Sandbox ghost-payee failed: treasury was not restored.");
      }
      if ((await viewSpentToday(contract, agents[1].accountId)) !== spentBefore) {
        throw new Error("Sandbox ghost-payee failed: agent spent-today was not restored.");
      }
      console.log(
        `sandbox payout-failed: request=${outcome.request_id} reason=TransferFailed treasury_restored spent_restored`,
      );
    }

    // Gate D: rejecting a held request releases the amount from the
    // agent's spent-today and never transfers.
    {
      const treasuryBefore = await viewTreasury(contract);
      const spentBefore = await viewSpentToday(contract, agents[1].accountId);
      const outcome = await agents[1].call(contract, "request_payment", {
        payee: payee.accountId,
        amount_yocto: nearToYocto(1),
        purpose_ref: PURPOSE_REF,
        vendor: "CoreWeave",
      });
      assertOutcome(outcome, { status: "staged", reason: null }, "reject-request");
      await submitPayoutVerdict(outcome.request_id, false);
      const held = await contract.view("get_request", { request_id: outcome.request_id });
      if (held?.status !== "held") {
        throw new Error(`Sandbox reject setup failed: request ${outcome.request_id} is ${held?.status}.`);
      }
      await root.call(contract, "reject_hold", { request_id: outcome.request_id });
      const rejected = await contract.view("get_request", { request_id: outcome.request_id });
      if (rejected?.status !== "rejected" || rejected?.reason !== "HoldRejected") {
        throw new Error(
          `Sandbox reject failed: request ${outcome.request_id} is ${rejected?.status}/${rejected?.reason ?? null}.`,
        );
      }
      const spentAfter = await viewSpentToday(contract, agents[1].accountId);
      if (spentAfter !== spentBefore) {
        throw new Error(
          `Sandbox reject failed: spent-today is ${spentAfter}, expected release back to ${spentBefore}.`,
        );
      }
      if ((await viewTreasury(contract)) !== treasuryBefore) {
        throw new Error("Sandbox reject failed: treasury moved without payment.");
      }
      console.log(
        `sandbox payout-reject: request=${outcome.request_id} reason=HoldRejected spent_released`,
      );
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
    // Add a guard-scoped key, assert the lock shape, delete it, assert gone.
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
