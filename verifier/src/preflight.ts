import { randomBytes } from "node:crypto";
import { fixtureReport } from "./fixtures.js";
import {
  verifyReport,
  type NearReport,
  type NrasFetchFn,
  type VerifyQuoteFn,
} from "./verify.js";

// Fresh-nonce preflight against the NEAR AI attestation report endpoint,
// fixture-first: without `NEAR_AI_API_KEY` the full verifyReport pipeline
// runs over canned fixture material (never TEE-verified upstream). The live
// path fetches gateway + every model_attestations[] candidate with the
// documented params and headers.

export const NEAR_ATTESTATION_URL =
  "https://cloud-api.near.ai/v1/attestation/report";

// Sentinel model echoed when fixture mode has no model configured. Model
// ids come from the request body or NEAR_AI_MODEL and are never hardcoded
// (catalogs change).
export const FIXTURE_MODEL_SENTINEL = "fixture-model";

export interface PreflightOptions {
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  verifyQuote?: VerifyQuoteFn;
  nrasFetch?: NrasFetchFn;
}

export interface PreflightResult {
  verified: boolean;
  signing_address?: string;
  reason?: string;
  request_nonce: string;
  model: string;
  fixture: boolean;
  // Internal routing hint: true when the upstream transport failed (the
  // route maps this to 502). Stripped from the wire body.
  transportError?: boolean;
}

export interface StoredVerification {
  verified: boolean;
  fixture: boolean;
  model: string;
  signingAddress?: string;
  reason?: string;
  at: number;
}

let lastVerified: StoredVerification | null = null;

export function getLastVerified(): StoredVerification | null {
  return lastVerified;
}

// Test seam: clear the module-level last-verified store.
export function resetLastVerified(): void {
  lastVerified = null;
}

function storeResult(
  result: PreflightResult,
  signingAddress?: string,
): void {
  lastVerified = {
    verified: result.verified,
    fixture: result.fixture,
    model: result.model,
    signingAddress: signingAddress ?? result.signing_address,
    reason: result.reason,
    at: Date.now(),
  };
}

// Badge mapping for GET /attestation/status. A fixture-mode result is
// `unverifiable`, never `verified` (honesty rule).
export function getStatus(): {
  badge: "verified" | "unverifiable" | "deterministic-only";
  details: Record<string, unknown>;
} {
  const last = lastVerified;
  if (last === null) return { badge: "deterministic-only", details: {} };
  if (last.verified && !last.fixture)
    return {
      badge: "verified",
      details: { model: last.model, signing_address: last.signingAddress },
    };
  return {
    badge: "unverifiable",
    details: {
      fixture: last.fixture,
      model: last.model,
      ...(last.reason !== undefined ? { reason: last.reason } : {}),
    },
  };
}

interface UpstreamBody {
  gateway_attestation?: NearReport;
  model_attestations?: NearReport[];
}

async function verifyUpstreamBody(
  body: UpstreamBody,
  nonceHex: string,
  opts?: { verifyQuote?: VerifyQuoteFn; nrasFetch?: NrasFetchFn; fixture?: boolean },
): Promise<{ verified: boolean; reason?: string; signingAddress?: string }> {
  const gateway = body.gateway_attestation;
  if (gateway === undefined || gateway === null)
    return { verified: false, reason: "missing gateway_attestation" };
  const gatewayResult = await verifyReport(gateway, nonceHex, {
    verifyQuote: opts?.verifyQuote,
    nrasFetch: opts?.nrasFetch,
    fixture: opts?.fixture,
  });
  if (!gatewayResult.verified) return gatewayResult;
  const candidates = body.model_attestations ?? [];
  if (candidates.length === 0)
    return { verified: false, reason: "no NEAR model evidence returned" };
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = await verifyReport(candidates[i], nonceHex, {
      verifyQuote: opts?.verifyQuote,
      nrasFetch: opts?.nrasFetch,
      fixture: opts?.fixture,
    });
    if (!candidate.verified)
      return {
        verified: false,
        reason: `model attestation ${i} invalid: ${candidate.reason ?? "unknown"}`,
      };
  }
  return { verified: true, signingAddress: gatewayResult.signingAddress };
}

export async function runPreflight(
  opts?: PreflightOptions,
): Promise<PreflightResult> {
  const apiKey = opts?.apiKey ?? process.env.NEAR_AI_API_KEY ?? "";
  const fixtureMode = apiKey === "";
  const requestNonce = randomBytes(32).toString("hex");

  if (fixtureMode) {
    const model =
      opts?.model ?? process.env.NEAR_AI_MODEL ?? FIXTURE_MODEL_SENTINEL;
    const report = fixtureReport(requestNonce);
    const result = await verifyUpstreamBody(
      { gateway_attestation: report, model_attestations: [report] },
      requestNonce,
      {
        verifyQuote: opts?.verifyQuote,
        nrasFetch: opts?.nrasFetch,
        fixture: true,
      },
    );
    const wire: PreflightResult = result.verified
      ? {
          verified: true,
          signing_address: result.signingAddress,
          request_nonce: requestNonce,
          model,
          fixture: true,
        }
      : {
          verified: false,
          reason: result.reason ?? "fixture verification failed",
          request_nonce: requestNonce,
          model,
          fixture: true,
        };
    storeResult(wire);
    return wire;
  }

  const model = opts?.model ?? process.env.NEAR_AI_MODEL ?? "";
  if (model === "") {
    return {
      verified: false,
      reason: "model is required for live preflight",
      request_nonce: requestNonce,
      model: "",
      fixture: false,
    };
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    model,
    provider: "near",
    signing_algo: "ecdsa",
    nonce: requestNonce,
  });
  let body: UpstreamBody;
  try {
    const response = await fetchImpl(`${NEAR_ATTESTATION_URL}?${params}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "x-no-aliasing": "true",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      return {
        verified: false,
        reason: `upstream attestation request failed: status ${response.status}`,
        request_nonce: requestNonce,
        model,
        fixture: false,
        transportError: true,
      };
    body = (await response.json()) as UpstreamBody;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      verified: false,
      reason: `attestation fetch failed: ${reason}`,
      request_nonce: requestNonce,
      model,
      fixture: false,
      transportError: true,
    };
  }

  const result = await verifyUpstreamBody(body, requestNonce, {
    verifyQuote: opts?.verifyQuote,
    nrasFetch: opts?.nrasFetch,
  });
  const wire: PreflightResult = result.verified
    ? {
        verified: true,
        signing_address: result.signingAddress,
        request_nonce: requestNonce,
        model,
        fixture: false,
      }
    : {
        verified: false,
        reason: result.reason ?? "attestation verification failed",
        request_nonce: requestNonce,
        model,
        fixture: false,
      };
  storeResult(wire);
  return wire;
}
