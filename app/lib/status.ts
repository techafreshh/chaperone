// Shared status/reason vocabulary (issue #65). One mapping covers every
// status and every `REASON_*` value the guard contract emits
// (`contract/src/request.rs`), so every page renders the same chip colors
// and the same plain-language reason sentences. `app/lib/status.test.ts`
// parses the contract source and fails when any `REASON_*` value lacks a
// sentence here.

export type RequestStatus =
  | "staged"
  | "paying"
  | "paid"
  | "held"
  | "rejected"
  | "failed";

export interface StatusMeta {
  label: string;
  chipClass: string;
}

function chip(base: string): string {
  return `inline-block rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${base}`;
}

// One entry per status string in `contract/src/request.rs`: distinct color
// plus distinct text per state.
export const STATUS_META: Record<RequestStatus, StatusMeta> = {
  staged: {
    label: "staged",
    chipClass: chip("border-slate-500 bg-slate-800 text-slate-200"),
  },
  paying: {
    label: "paying",
    chipClass: chip("border-sky-500 bg-sky-950 text-sky-200"),
  },
  paid: {
    label: "paid",
    chipClass: chip("border-emerald-500 bg-emerald-950 text-emerald-200"),
  },
  held: {
    label: "held",
    chipClass: chip("border-amber-500 bg-amber-950 text-amber-200"),
  },
  rejected: {
    label: "rejected",
    chipClass: chip("border-red-500 bg-red-950 text-red-200"),
  },
  failed: {
    label: "failed",
    chipClass: chip("border-fuchsia-500 bg-fuchsia-950 text-fuchsia-200"),
  },
};

export function isRequestStatus(value: unknown): value is RequestStatus {
  return (
    value === "staged" ||
    value === "paying" ||
    value === "paid" ||
    value === "held" ||
    value === "rejected" ||
    value === "failed"
  );
}

export function statusMeta(status: string): StatusMeta {
  if (isRequestStatus(status)) return STATUS_META[status];
  return {
    label: status === "" ? "unknown" : status,
    chipClass: chip("border-slate-500 bg-slate-800 text-slate-200"),
  };
}

// Plain-language sentence per exact `REASON_*` contract string, keyed by
// the value (not the constant name). Same short-form → literal-string
// mapping style as `badgeToLabel` in `app/lib/supabase.ts`.
export const REASON_DESCRIPTIONS: Record<string, string> = {
  InsufficientTreasury:
    "The fleet treasury cannot cover this payment, so the request waits until the owner tops up and approves.",
  TransferFailed:
    "The on-chain transfer bounced, so the treasury debit and the day's spend were restored.",
  HoldRejected: "The owner reviewed this held request and declined to release it.",
  AgentInactive: "The agent is frozen, so none of its payment requests can proceed.",
  ExceedsDailyAllowance:
    "This payment would spend more than the agent's remaining allowance for today.",
  ExceedsPerPaymentCap:
    "This payment is larger than the agent's per-payment cap.",
  PayeeNotAllowlisted:
    "The payee is not on this agent's allowlist, so the payment was blocked.",
  PurposeRefNotFound:
    "The cited purpose reference is not registered, so there is nothing to check the payment against.",
  PurposeRefClosed:
    "The cited purpose reference is closed, so it can no longer back payments.",
  "Invalid memo":
    "The payment memo is missing or outside the 1 to 280 byte limit.",
  PurposeRefPayeeMismatch:
    "The purpose reference is bound to a different payee than the one named here.",
  PurposeRefVendorMismatch:
    "The vendor named here does not match the vendor on the purpose reference.",
  ExceedsPurposeRefRemaining:
    "This payment is larger than what is left on the cited purpose reference.",
};

export const UNKNOWN_REASON_SENTENCE =
  "No plain-language explanation is registered for this reason code.";

// Never-empty fallback for unknown codes: the raw code still renders in
// monospace next to this sentence.
export function describeReason(code: unknown): string {
  if (typeof code === "string" && code !== "") {
    const exact = REASON_DESCRIPTIONS[code];
    if (exact !== undefined) return exact;
    // Fixture and mirror rows sometimes carry a suffixed sentence
    // (`PayeeNotAllowlisted: ...`): match the leading known code.
    for (const [key, sentence] of Object.entries(REASON_DESCRIPTIONS)) {
      if (code === key || code.startsWith(`${key}:`) || code.startsWith(`${key} `)) {
        return sentence;
      }
    }
  }
  return UNKNOWN_REASON_SENTENCE;
}

// Extract the contract reason code from a free-form reason string: the
// first known `REASON_*` value contained in the text, else the trimmed
// text itself (or "" when there is none).
export function extractReasonCode(reason: unknown): string {
  if (typeof reason !== "string") return "";
  const trimmed = reason.trim();
  if (trimmed === "") return "";
  for (const key of Object.keys(REASON_DESCRIPTIONS)) {
    if (trimmed === key || trimmed.includes(key)) return key;
  }
  return trimmed;
}
