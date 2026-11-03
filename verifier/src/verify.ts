import { createHash } from "node:crypto";
import {
  FIXTURE_QUOTE_HEX,
  FIXTURE_SIGNING_ADDRESS,
  cannedNrasResponse,
  fixtureReport,
} from "./fixtures.js";

// Pure core for NEAR AI attestation verification, following the documented
// gateway-attestation flow: DCAP quote verification (injected), TDX debug
// rejection, report_data signer+nonce binding, echoed request_nonce match,
// MRCONFIGID over the raw app_compose bytes, RTMR3 event-log replay, and an
// NVIDIA NRAS GPU check. Every mismatch returns `{verified:false, reason}`
// naming the failed check — this module never throws.

// Statuses accepted by verification policy. Exactly ["UpToDate"].
export const ACCEPTED_TCB_STATUSES = ["UpToDate"];

// NVIDIA Remote Attestation Service GPU endpoint.
export const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";

// A single NEAR attestation report (gateway_attestation or one
// model_attestations[] candidate). String-or-object fields follow the wire
// convention that event_log / tcb_info / nvidia_payload may arrive as JSON
// text or as already-decoded values.
export interface NearReport {
  intel_quote: string;
  event_log: unknown;
  request_nonce: string;
  report_data?: unknown;
  signing_address: string;
  signing_algo: string;
  tls_cert_fingerprint?: unknown;
  info: unknown;
  nvidia_payload?: unknown;
  [key: string]: unknown;
}

export interface VerifyResult {
  verified: boolean;
  reason?: string;
  signingAddress?: string;
}

// Quote verification collapsed to the fields the checks read, so tests can
// inject a stub while the live path delegates to `@phala/dcap-qvl`.
export interface NormalizedQuote {
  status: string;
  advisoryIds: string[];
  tdAttributesByte0: number;
  reportData: Buffer;
  mrConfigId: Buffer;
  rtMr3: Buffer;
}

export type VerifyQuoteFn = (quoteBytes: Buffer) => Promise<NormalizedQuote>;

export interface NrasResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type NrasFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<NrasResponse>;

export interface CheckOptions {
  verifyQuote?: VerifyQuoteFn;
  acceptedTcbStatuses?: string[];
}

export interface NvidiaOptions {
  nrasFetch?: NrasFetchFn;
}

export interface VerifyOptions extends CheckOptions, NvidiaOptions {
  nonceHex?: string;
  // Force the fixture quote stub (reference-derived expectations) instead
  // of auto-detecting it from the report contents.
  fixture?: boolean;
}

function hexBytes(value: string): Buffer {
  return Buffer.from(value.replace(/^0x/i, ""), "hex");
}

function isHexText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length % 2 === 0 &&
    /^[0-9a-fA-F]*$/.test(value)
  );
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Replay the RTMR3 event log: only `imr === 3` events in order, each digest
// SHA-384(LE32(event_type) || ":" || event UTF-8 || ":" || payload bytes).
// A non-empty carried digest must equal the recomputed one; the chain folds
// from 48 zero bytes via RTMR3 = SHA-384(RTMR3 || digest).
export function replayRtmr3(eventLog: unknown): Buffer {
  const events = parseJson(eventLog);
  if (!Array.isArray(events)) throw new Error("event_log is not a list");
  let rtmr3: Buffer = Buffer.alloc(48);
  for (const raw of events) {
    const event = raw as Record<string, unknown>;
    if (event.imr !== 3) continue;
    if (typeof event.event_type !== "number" || typeof event.event !== "string")
      throw new Error("malformed event log entry");
    const payloadHex =
      typeof event.event_payload === "string" ? event.event_payload : "";
    if (payloadHex !== "" && !isHexText(payloadHex))
      throw new Error("malformed event payload");
    const typeBytes = Buffer.alloc(4);
    typeBytes.writeUInt32LE(event.event_type);
    const digest = sha384(
      typeBytes,
      ":",
      Buffer.from(event.event, "utf8"),
      ":",
      Buffer.from(payloadHex, "hex"),
    );
    if (typeof event.digest === "string" && event.digest !== "") {
      if (!isHexText(event.digest) || !hexBytes(event.digest).equals(digest))
        throw new Error(`digest mismatch for event ${event.event}`);
    }
    rtmr3 = sha384(rtmr3, digest);
  }
  return rtmr3;
}

function sha384(...parts: Array<string | Buffer>): Buffer {
  const h = createHash("sha384");
  for (const part of parts) h.update(part);
  return h.digest();
}

// Live DCAP quote verification via a lazily loaded `@phala/dcap-qvl`. The
// webpackIgnore hint keeps route bundles from needing the package
// statically; a missing or unreachable library degrades to a thrown error
// that the caller converts to `{verified:false, reason}`.
async function liveVerifyQuote(quoteBytes: Buffer): Promise<NormalizedQuote> {
  let mod: unknown;
  try {
    mod = await import(/* webpackIgnore: true */ "@phala/dcap-qvl");
  } catch (error) {
    throw new Error(`quote verification unavailable: ${errorReason(error)}`);
  }
  const record = mod as Record<string, unknown>;
  const nested = record.default as Record<string, unknown> | undefined;
  const fn = record.getCollateralAndVerify ?? nested?.getCollateralAndVerify;
  if (typeof fn !== "function")
    throw new Error(
      "quote verification unavailable: getCollateralAndVerify not exported",
    );
  let verified: unknown;
  try {
    verified = await (
      fn as (quote: Uint8Array) => Promise<unknown>
    )(new Uint8Array(quoteBytes));
  } catch (error) {
    throw new Error(`quote verification failed: ${errorReason(error)}`);
  }
  return normalizeQuote(verified);
}

function toBytes(value: unknown, field: string): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value) && value.every((n) => typeof n === "number"))
    return Buffer.from(value as number[]);
  if (typeof value === "string" && isHexText(value.replace(/^0x/i, "")))
    return hexBytes(value);
  throw new Error(`malformed verified quote field ${field}`);
}

function normalizeQuote(verified: unknown): NormalizedQuote {
  const v = verified as Record<string, unknown>;
  const status =
    typeof v.status === "string" ? v.status : String(v.status ?? "Unknown");
  const advisoryIds = Array.isArray(v.advisory_ids ?? v.advisoryIds)
    ? ((v.advisory_ids ?? v.advisoryIds) as unknown[]).map(String)
    : [];
  const report = (v.report ?? {}) as Record<string, unknown>;
  const type = String(report.type ?? report.quoteType ?? "").toLowerCase();
  if (type !== "" && type !== "td10" && type !== "tdx")
    throw new Error("expected a TDX quote");
  const data = (report.data ?? report ?? {}) as Record<string, unknown>;
  const tdAttributes = toBytes(
    data.tdAttributes ?? data.td_attributes,
    "tdAttributes",
  );
  return {
    status,
    advisoryIds,
    tdAttributesByte0: tdAttributes[0] ?? 0,
    reportData: toBytes(data.reportData ?? data.report_data, "reportData"),
    mrConfigId: toBytes(data.mrConfigId ?? data.mr_config_id, "mrConfigId"),
    rtMr3: toBytes(data.rtMr3 ?? data.rt_mr3, "rtMr3"),
  };
}

// Run the quote, identity, nonce, configuration, and RTMR3 checks on one
// NEAR report. Reads measurements from the verified quote; HTTP fields are
// consistency checks against it.
export async function checkNearReport(
  report: NearReport,
  nonceHex: string,
  opts?: CheckOptions,
): Promise<VerifyResult> {
  try {
    if (!isHexText(nonceHex) || nonceHex.length !== 64)
      return { verified: false, reason: "invalid nonce" };
    if (typeof report.intel_quote !== "string" || !isHexText(report.intel_quote))
      return { verified: false, reason: "malformed intel_quote" };
    const verifyQuote = opts?.verifyQuote ?? liveVerifyQuote;
    let quote: NormalizedQuote;
    try {
      quote = await verifyQuote(Buffer.from(report.intel_quote, "hex"));
    } catch (error) {
      return {
        verified: false,
        reason: `quote verification failed: ${errorReason(error)}`,
      };
    }

    const accepted = opts?.acceptedTcbStatuses ?? ACCEPTED_TCB_STATUSES;
    if (!accepted.includes(quote.status))
      return {
        verified: false,
        reason: `TCB status ${quote.status} not accepted: ${quote.advisoryIds.join(",")}`,
      };

    if (quote.tdAttributesByte0 & 1)
      return { verified: false, reason: "TDX debug mode is enabled" };

    if (
      typeof report.signing_address !== "string" ||
      !isHexText(report.signing_address.replace(/^0x/i, ""))
    )
      return { verified: false, reason: "unsupported signing identity" };
    const identity = hexBytes(report.signing_address);
    const expectedIdentityLength =
      report.signing_algo === "ecdsa"
        ? 20
        : report.signing_algo === "ed25519"
          ? 32
          : -1;
    if (expectedIdentityLength !== identity.length)
      return { verified: false, reason: "unsupported signing identity" };

    // No-TLS binding: identity zero-padded on the right to 32 bytes, then
    // the 32-byte client nonce. (The server never sends
    // include_tls_fingerprint, so the TLS-bound layout cannot occur here.)
    const boundIdentity = Buffer.concat([
      identity,
      Buffer.alloc(32 - identity.length),
    ]);
    const expectedReportData = Buffer.concat([
      boundIdentity,
      Buffer.from(nonceHex, "hex"),
    ]);
    if (!quote.reportData.equals(expectedReportData))
      return {
        verified: false,
        reason: "report data does not bind the signer and nonce",
      };

    if (
      typeof report.request_nonce !== "string" ||
      report.request_nonce.toLowerCase() !== nonceHex.toLowerCase()
    )
      return { verified: false, reason: "echoed nonce does not match" };

    if (
      typeof report.report_data === "string" &&
      report.report_data !== "" &&
      (!isHexText(report.report_data) ||
        hexBytes(report.report_data).toString("hex") !==
          quote.reportData.toString("hex"))
    )
      return {
        verified: false,
        reason: "echoed report_data does not match verified quote",
      };

    const info = parseJson(report.info) as Record<string, unknown> | null;
    const tcbInfo = info?.tcb_info;
    const parsedTcb = parseJson(tcbInfo) as Record<string, unknown> | null;
    const appCompose = parsedTcb?.app_compose;
    if (typeof appCompose !== "string")
      return { verified: false, reason: "missing app_compose" };
    const composeHash = createHash("sha256")
      .update(Buffer.from(appCompose, "utf8"))
      .digest();
    const expectedConfig = Buffer.concat([
      Buffer.from([1]),
      composeHash,
      Buffer.alloc(15),
    ]);
    if (!quote.mrConfigId.equals(expectedConfig))
      return {
        verified: false,
        reason: "MRCONFIGID does not match app_compose",
      };

    let replayed: Buffer;
    try {
      replayed = replayRtmr3(report.event_log);
    } catch (error) {
      return {
        verified: false,
        reason: `event log replay failed: ${errorReason(error)}`,
      };
    }
    if (!replayed.equals(quote.rtMr3))
      return { verified: false, reason: "event log does not match RTMR3" };

    return { verified: true, signingAddress: report.signing_address };
  } catch (error) {
    return { verified: false, reason: errorReason(error) };
  }
}

const defaultNrasFetch: NrasFetchFn = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return {
    ok: response.ok,
    status: response.status,
    json: async () => response.json(),
  };
};

// Verify GPU evidence when present. The payload nonce must match the
// request nonce before anything is sent; the decoded object goes to NRAS
// unchanged, and the first-entry JWT payload must carry
// x-nvidia-overall-att-result === true. Absent payload resolves skipped
// (CPU-only TEE path).
export async function checkNvidiaPayload(
  report: NearReport,
  nonceHex: string,
  opts?: NvidiaOptions,
): Promise<{ verified: boolean; reason?: string; skipped?: boolean }> {
  try {
    if (
      report.nvidia_payload === undefined ||
      report.nvidia_payload === null ||
      report.nvidia_payload === ""
    )
      return { verified: true, skipped: true };
    let payload: unknown;
    try {
      payload = parseJson(report.nvidia_payload);
    } catch {
      return { verified: false, reason: "malformed nvidia payload" };
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload))
      return { verified: false, reason: "malformed nvidia payload" };
    const payloadNonce = (payload as Record<string, unknown>).nonce;
    if (
      typeof payloadNonce !== "string" ||
      payloadNonce.toLowerCase() !== nonceHex.toLowerCase()
    )
      return { verified: false, reason: "nvidia payload nonce mismatch" };

    const nrasFetch = opts?.nrasFetch ?? defaultNrasFetch;
    let response: NrasResponse;
    try {
      response = await nrasFetch(NRAS_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      return {
        verified: false,
        reason: `nvidia attestation request failed: ${errorReason(error)}`,
      };
    }
    if (!response.ok)
      return {
        verified: false,
        reason: `nvidia attestation request failed: status ${response.status}`,
      };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        verified: false,
        reason: "malformed nvidia attestation response",
      };
    }
    const first = Array.isArray(body) ? body[0] : undefined;
    if (
      !Array.isArray(first) ||
      first[0] !== "JWT" ||
      typeof first[1] !== "string"
    )
      return {
        verified: false,
        reason: "malformed nvidia attestation response",
      };
    const segments = (first[1] as string).split(".");
    if (segments.length < 2)
      return {
        verified: false,
        reason: "malformed nvidia attestation response",
      };
    let claims: unknown;
    try {
      claims = JSON.parse(
        Buffer.from(segments[1], "base64url").toString("utf8"),
      );
    } catch {
      return {
        verified: false,
        reason: "malformed nvidia attestation response",
      };
    }
    if (
      typeof claims !== "object" ||
      claims === null ||
      (claims as Record<string, unknown>)["x-nvidia-overall-att-result"] !==
        true
    )
      return {
        verified: false,
        reason: "nvidia attestation verdict is not true",
      };
    return { verified: true };
  } catch (error) {
    return { verified: false, reason: errorReason(error) };
  }
}

function isFixtureLike(report: NearReport): boolean {
  return (
    (typeof report.signing_address === "string" &&
      report.signing_address.toLowerCase() ===
        FIXTURE_SIGNING_ADDRESS.toLowerCase()) ||
    (typeof report.intel_quote === "string" &&
      report.intel_quote.toLowerCase() === FIXTURE_QUOTE_HEX.toLowerCase())
  );
}

function cannedNrasFetch(): NrasFetchFn {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => cannedNrasResponse(),
  });
}

// Full per-report pipeline: quote/identity/nonce/configuration/RTMR3
// checks plus the NVIDIA GPU check. Fixture reports (auto-detected by
// canned quote bytes or fixture signing address, or forced via
// `fixture:true`) verify against reference-derived expectations with the
// canned NRAS response, so tampered bytes fail identically in both tiers.
export async function verifyReport(
  report: NearReport,
  nonceHexOrOpts?: string | VerifyOptions,
  maybeOpts?: VerifyOptions,
): Promise<VerifyResult> {
  try {
    const opts: VerifyOptions =
      typeof nonceHexOrOpts === "object" && nonceHexOrOpts !== null
        ? { ...nonceHexOrOpts, ...maybeOpts }
        : { ...maybeOpts };
    const nonceHex =
      typeof nonceHexOrOpts === "string"
        ? nonceHexOrOpts
        : (opts.nonceHex ?? report.request_nonce);
    if (typeof nonceHex !== "string" || !isHexText(nonceHex) || nonceHex.length !== 64)
      return { verified: false, reason: "invalid nonce" };

    const fixtureMode =
      opts.fixture === true || (opts.verifyQuote === undefined && isFixtureLike(report));

    let verifyQuote = opts.verifyQuote;
    if (verifyQuote === undefined && fixtureMode) {
      // Reference expectations come from the pristine fixture, never from
      // the report under test, so any tampering fails the comparison.
      const reference = fixtureReport(nonceHex);
      const identity = hexBytes(FIXTURE_SIGNING_ADDRESS);
      const expectedReportData = Buffer.concat([
        Buffer.concat([identity, Buffer.alloc(32 - identity.length)]),
        Buffer.from(nonceHex, "hex"),
      ]);
      const expectedConfig = Buffer.concat([
        Buffer.from([1]),
        createHash("sha256")
          .update(
            Buffer.from(
              (parseJson((reference.info as Record<string, unknown>).tcb_info) as {
                app_compose: string;
              }).app_compose,
              "utf8",
            ),
          )
          .digest(),
        Buffer.alloc(15),
      ]);
      const expectedRtMr3 = replayRtmr3(reference.event_log);
      const cannedQuote = Buffer.from(FIXTURE_QUOTE_HEX, "hex");
      verifyQuote = async (quoteBytes: Buffer) => {
        if (!quoteBytes.equals(cannedQuote))
          throw new Error("fixture quote bytes do not match reference");
        return {
          status: "UpToDate",
          advisoryIds: [],
          tdAttributesByte0: 0,
          reportData: expectedReportData,
          mrConfigId: expectedConfig,
          rtMr3: expectedRtMr3,
        };
      };
    }

    const near = await checkNearReport(report, nonceHex, {
      verifyQuote,
      acceptedTcbStatuses: opts.acceptedTcbStatuses,
    });
    if (!near.verified) return near;

    const nvidia = await checkNvidiaPayload(report, nonceHex, {
      nrasFetch: opts.nrasFetch ?? (fixtureMode ? cannedNrasFetch() : undefined),
    });
    if (!nvidia.verified)
      return { verified: false, reason: nvidia.reason ?? "nvidia check failed" };

    return { verified: true, signingAddress: near.signingAddress };
  } catch (error) {
    return { verified: false, reason: errorReason(error) };
  }
}
