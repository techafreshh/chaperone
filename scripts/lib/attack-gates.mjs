// Pure, import-free helpers shared by the attack-suite fixture and gate
// runners. This module must stay import-free (no imports at all, not even
// Node builtins) so the offline `node:test` suite runs without `npm
// install`. Base58 and Ed25519 live in the `.mjs` runners, which run only
// with root dependencies installed.

// Verdict domain separator (PRD §10.1), byte-identical to
// `VERDICT_DOMAIN` in `contract/src/verifier.rs` and the `domain` buffer
// in `buildVerdictPayload` (`verifier/src/server.ts`).
export const VERDICT_DOMAIN = "chaperone-verdict-v1";

// Guard id resolution precedence for both runners: explicit `--contract`
// flag first, then `$GUARD_CONTRACT_ID`, then the legacy
// `$NEAR_CONTRACT_ID` fallback.
export function resolveGuardId(env, flag) {
  const guardId = flag ?? env?.GUARD_CONTRACT_ID ?? env?.NEAR_CONTRACT_ID;
  if (typeof guardId !== "string" || guardId.trim() === "") {
    throw new Error(
      "Missing guard contract id: pass --contract or set GUARD_CONTRACT_ID (NEAR_CONTRACT_ID also works).",
    );
  }
  return guardId;
}

// The four suite gates and their exact stdout line prefixes. The
// acceptance contract matches these substrings verbatim, so keep them
// byte-stable: `GATE over-allowance: BLOCKED`, `GATE allowlist: BLOCKED`,
// `GATE purpose-mismatch: HELD`, `GATE clean-transit: PAID`.
export const GATE_DEFS = [
  { key: "over-allowance", label: "over-allowance", verdict: "BLOCKED" },
  { key: "allowlist", label: "allowlist", verdict: "BLOCKED" },
  { key: "purpose-mismatch", label: "purpose-mismatch", verdict: "HELD" },
  { key: "clean-transit", label: "clean-transit", verdict: "PAID" },
];

export function gatePrefix(def) {
  return `GATE ${def.label}: ${def.verdict}`;
}

// One-line gate result. Always carries `request_id=` and `tx=`; held/paid
// lines append `verdict_tx=` plus the fixture attestation extras. Stays on
// a single line so `grep` probes match per gate.
export function formatGateLine(def, result) {
  const parts = [
    gatePrefix(def),
    `request_id=${result.requestId}`,
    `tx=${result.tx}`,
  ];
  if (result.verdictTx !== undefined && result.verdictTx !== null && result.verdictTx !== "") {
    parts.push(`verdict_tx=${result.verdictTx}`);
  }
  if (result.extra !== undefined && result.extra !== null && result.extra !== "") {
    parts.push(String(result.extra).replace(/\s+/g, " ").trim());
  }
  return parts.join(" ");
}

// Extract the transaction hash from a near-api-js change-call outcome.
// `callFunctionRaw`/`signAndSendTransaction` resolve to a
// FinalExecutionOutcome (`transaction_outcome.id`); older shapes surface
// `transaction.hash` or a bare `hash`.
export function txHashOf(outcome) {
  const hash =
    outcome?.transaction_outcome?.id ?? outcome?.transaction?.hash ?? outcome?.hash;
  if (typeof hash !== "string" || hash === "") {
    throw new Error("Cannot extract transaction hash from call outcome.");
  }
  return hash;
}

// Canonical verdict payload, byte-identical to `canonical_verdict_payload`
// (`contract/src/verifier.rs`) and `buildVerdictPayload`
// (`verifier/src/server.ts`):
// `domain || le_u64(id) || agent || payee || le_u128(amount) || ref ||
// byte` with verdict byte 1 for consistent, 0 for inconsistent.
export function buildVerdictPayload(request, consistent) {
  if (!Number.isInteger(request?.request_id) || request.request_id <= 0) {
    throw new Error("buildVerdictPayload needs a positive integer request_id.");
  }
  for (const field of ["agent_id", "payee", "purpose_ref"]) {
    if (typeof request[field] !== "string" || request[field] === "") {
      throw new Error(`buildVerdictPayload needs a non-empty ${field}.`);
    }
  }
  if (typeof request.amount_yocto !== "string" || !/^\d+$/.test(request.amount_yocto)) {
    throw new Error("buildVerdictPayload needs amount_yocto as a decimal string.");
  }
  const amount = BigInt(request.amount_yocto);
  if (amount >= 1n << 128n) {
    throw new Error("amount_yocto out of range for le_u128.");
  }

  const encode = new TextEncoder();
  const domain = encode.encode(VERDICT_DOMAIN);
  const agent = encode.encode(request.agent_id);
  const payee = encode.encode(request.payee);
  const ref = encode.encode(request.purpose_ref);

  const out = new Uint8Array(domain.length + 8 + agent.length + payee.length + 16 + ref.length + 1);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let at = 0;
  out.set(domain, at);
  at += domain.length;
  view.setBigUint64(at, BigInt(request.request_id), true);
  at += 8;
  out.set(agent, at);
  at += agent.length;
  out.set(payee, at);
  at += payee.length;
  view.setBigUint64(at, amount & 0xffffffffffffffffn, true);
  view.setBigUint64(at + 8, (amount >> 64n) & 0xffffffffffffffffn, true);
  at += 16;
  out.set(ref, at);
  at += ref.length;
  out[at] = consistent ? 1 : 0;
  return out;
}

// Idempotency skip idiom shared with `seed-books.mjs`: entries whose
// register fails with "already registered" are skipped, never re-created.
export function isAlreadyRegisteredMessage(message) {
  return typeof message === "string" && message.includes("already registered");
}

// Audit-pack CSV header the app gates assert, byte-identical to
// `RECEIPTS_CSV_HEADER` in `app/lib/receipts.ts` (that module is the
// source of truth; this copy exists because a `.mjs` runner cannot import
// TypeScript, and the app's own `receipts.test.ts` guards drift).
export const RECEIPTS_CSV_HEADER = "request_id,status,verdict_signature,chain_tx";

// App-gate pages every run probes (issue #21): each must answer 200, and
// `/requests` must carry a `TEE-verified` row from the fixture tier.
export const APP_GATE_PAGES = ["/fleet", "/requests", "/queue", "/receipts"];

// Suite defaults: the guard agent under test, its per-payment cap headroom
// probes, and the fixture payees. Nonexistent payees are fine — the
// contract only compares allowlist strings.
export const SUITE_DEFAULTS = {
  agentRef: "agent-1",
  goodPayee: "good.testnet",
  attackerPayee: "attacker.testnet",
  evilPayee: "evil.testnet",
  purposeRef: "invoice-114",
  cleanVendor: "CoreWeave",
  poisonedVendor: "AttackerCo",
  overAllowanceNear: "20",
  allowlistProbeNear: "1",
  stagedNear: "5",
  dailyAllowanceNear: "1000",
  perPaymentCapNear: "10",
};
