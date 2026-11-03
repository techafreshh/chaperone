import { createHash } from "node:crypto";
import { verifyMessage } from "ethers";

// Cryptographic binding of a NEAR AI Cloud completion to the attested TEE
// instance, mirroring `utils/verification-helpers.js` from the
// `nearai-cloud-verification-example` reference: hash comparison over the
// signed text grammar plus EIP-191 signer recovery matched against the
// stored attestation address. Refusals return `{verified:false, reason}`
// naming the failed check and never throw.

// SHA-256 hex digest of the exact UTF-8 bytes sent/received.
export function sha256HexText(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// Normalize a cloud base to the service root: strip trailing slashes, then
// a single trailing `/v1` when present, so callers can append the
// documented `/v1/...` paths idempotently. Both the bare service root
// (`https://cloud-api.near.ai`) and the documented base
// (`https://cloud-api.near.ai/v1`) resolve to the same live URLs; the
// in-repo fixture root (`http://127.0.0.1:<port>`) works unchanged.
export function normalizeCloudBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
}

export interface CompletionSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

export interface FetchSignatureOptions {
  baseUrl: string;
  chatId: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch the TEE signature for a chat completion. The completion may be
// served by several TEE nodes while the signature is cached on the serving
// node, so a lookup can transiently 404 on a different node — retry a few
// times before giving up (reference `getChatMessageSignature` behavior).
export async function fetchCompletionSignature(
  opts: FetchSignatureOptions,
): Promise<CompletionSignature> {
  const retries = opts.retries ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = normalizeCloudBaseUrl(opts.baseUrl);
  const url =
    `${base}/v1/signature/${encodeURIComponent(opts.chatId)}` +
    `?model=${encodeURIComponent(opts.model)}&signing_algo=ecdsa`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.apiKey !== undefined && opts.apiKey !== "")
    headers.Authorization = `Bearer ${opts.apiKey}`;
  let lastError = `signature request failed: status 404`;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new Error(
        `signature request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.ok) {
      const body = (await response.json()) as Partial<CompletionSignature>;
      if (typeof body.text !== "string" || typeof body.signature !== "string")
        throw new Error("signature response is missing text or signature");
      return {
        text: body.text,
        signature: body.signature,
        signing_address: typeof body.signing_address === "string"
          ? body.signing_address
          : "",
        signing_algo: typeof body.signing_algo === "string"
          ? body.signing_algo
          : "ecdsa",
        ...(typeof body.signature_kind === "string"
          ? { signature_kind: body.signature_kind }
          : {}),
      };
    }
    lastError = `signature request failed: status ${response.status}`;
    if (response.status !== 404 || attempt === retries) break;
    await sleep(retryDelayMs);
  }
  throw new Error(lastError);
}

export interface HashComparison {
  valid: boolean;
  requestHashMatch: boolean;
  responseHashMatch: boolean;
  // Null when the signed text carries no model id (gateway signature).
  modelIdMatch: boolean | null;
  reason?: string;
}

// Validate request/response hashes against the signed `text` payload. The
// signed text is `provider_tee` 3-part
// `{model_id}:{request_hash}:{response_hash}` or `gateway` 2-part
// `{request_hash}:{response_hash}`; a carried model id must match the
// expected one when both are present.
export function compareHashes(
  signatureText: string,
  expectedRequestHash: string,
  expectedResponseHash: string,
  expectedModelId?: string,
): HashComparison {
  const parts = signatureText.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    return {
      valid: false,
      requestHashMatch: false,
      responseHashMatch: false,
      modelIdMatch: null,
      reason: `expected 2 or 3 ':'-separated parts in signed text, got ${parts.length}`,
    };
  }
  const hasModelId = parts.length === 3;
  const signedModelId = hasModelId ? (parts[0] as string) : null;
  const signedRequestHash = parts[hasModelId ? 1 : 0] as string;
  const signedResponseHash = parts[hasModelId ? 2 : 1] as string;
  const requestHashMatch = signedRequestHash === expectedRequestHash;
  const responseHashMatch = signedResponseHash === expectedResponseHash;
  const modelIdMatch = hasModelId && expectedModelId !== undefined
    ? signedModelId === expectedModelId
    : null;
  const valid =
    requestHashMatch && responseHashMatch && modelIdMatch !== false;
  if (valid) {
    return { valid, requestHashMatch, responseHashMatch, modelIdMatch };
  }
  const failures: string[] = [];
  if (!requestHashMatch) failures.push("request hash mismatch");
  if (!responseHashMatch) failures.push("response hash mismatch");
  if (modelIdMatch === false) failures.push("model id mismatch");
  return {
    valid,
    requestHashMatch,
    responseHashMatch,
    modelIdMatch,
    reason: failures.join("; "),
  };
}

export interface BindingCheck {
  verified: boolean;
  reason?: string;
  recoveredAddress?: string;
}

// Recover the EIP-191 signer of the completion signature and match it
// against the stored attestation address(es), case-insensitively.
export async function verifyBinding(opts: {
  text: string;
  signature: string;
  expectedAddresses: string | string[];
}): Promise<BindingCheck> {
  const expected = Array.isArray(opts.expectedAddresses)
    ? opts.expectedAddresses
    : [opts.expectedAddresses];
  if (opts.text === "" || opts.signature === "")
    return { verified: false, reason: "missing signature text or signature" };
  if (expected.length === 0)
    return { verified: false, reason: "no attested signing address on record" };
  let recovered: string;
  try {
    recovered = verifyMessage(opts.text, opts.signature);
  } catch (error) {
    return {
      verified: false,
      reason: `signature recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const match = expected.some(
    (address) => recovered.toLowerCase() === address.toLowerCase(),
  );
  if (!match) {
    return {
      verified: false,
      reason: `recovered signer ${recovered} does not match attested address`,
      recoveredAddress: recovered,
    };
  }
  return { verified: true, recoveredAddress: recovered };
}
