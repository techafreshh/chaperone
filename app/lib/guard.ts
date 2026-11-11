import { NextResponse } from "next/server";
import type { Env } from "./env";

// Live-tier write gate (issue #62). Owner methods (`approve_hold`,
// `reject_hold`, `set_agent_active`, `set_verifier`, `register_agent`,
// `set_agent_policy`, payee edits, `register_purpose_ref`) are signed by
// the operator's NEAR wallet in the browser; the contract's owner check is
// the only authorization. The app server holds no owner key and sends
// nothing on the live tier.

// Live when a guard contract id is configured (either env name). Trimmed
// so whitespace-only values stay on the fixture tier.
export function isLiveTier(env: Env = process.env): boolean {
  const contractId = (
    env.GUARD_CONTRACT_ID ??
    env.NEAR_CONTRACT_ID ??
    ""
  ).trim();
  return contractId !== "";
}

// Exact 403 body every owner-write route answers on the live tier.
export function liveWriteBlocked(): NextResponse {
  return NextResponse.json(
    { error: "sign with the owner wallet" },
    { status: 403 },
  );
}
