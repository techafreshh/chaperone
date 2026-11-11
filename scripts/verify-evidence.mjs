// Re-check a verdict's TEE evidence (issue #66): fetch the evidence bundle
// the verifier stored when it judged `<request_id>`, compare its sha256 to
// the `evidence_sha256` recorded on-chain (served back over the verify
// views), recover the EIP-191 ECDSA signer of
// `<model>:<sha256(request)>:<sha256(response)>` from the bundle's NEAR AI
// signature, and check it equals the attested `signing_address`.
//
// Usage: node scripts/verify-evidence.mjs <request_id> [--base-url URL]
//
// One line per step (`fetch`, `hash`, `signer`, `attestation`); any FAIL
// exits non-zero. A fixture bundle prints `attestation: fixture` (never
// PASS): the DCAP/NVIDIA hardware report itself stays server-side, and a
// fixture run proves the link shape, not the hardware.
//
// What each step proves:
// - `fetch`: the verifier actually serves an evidence bundle for the id.
// - `hash`: the served bundle is byte-identical to what the verdict
//   committed to (`sha256` of the canonical bundle equals the recorded
//   `evidence_sha256`), so the verdict cannot point at different evidence.
// - `signer`: the NEAR AI completion signature was made by the attested
//   TEE key (`signing_address`), binding this completion to that instance.
// - `attestation`: `fixture` for fixture bundles (informational, never
//   PASS); `PASS` only for live-issued, signature-bound bundles.
//
// Trust statement: the verifier service is still trusted to sign only what
// NEAR AI returned — this script re-checks the per-verdict link, not the
// hardware attestation report itself.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMessage } from "ethers";

export function verifyEvidenceUsage() {
  return `usage: node scripts/verify-evidence.mjs <request_id> [--base-url URL]

  <request_id>   judged request to re-check (positive integer)
  --base-url     service base URL (default: $SMOKE_BASE_URL or http://localhost:3000)

  Fetches GET <base>/api/evidence/<id>, checks its sha256 against the
  evidence_sha256 recorded on-chain, recovers the EIP-191 signer of the
  bundle's NEAR AI signature, and compares it to signing_address.`;
}

export function parseVerifyEvidenceArgs(argv) {
  let requestId = null;
  let baseUrl = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      const value = arg.includes("=")
        ? arg.slice("--base-url=".length)
        : (argv[i + 1] ?? "");
      if (arg === "--base-url") i += 1;
      if (value === "") throw new Error("--base-url needs a URL value");
      baseUrl = value;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    if (requestId !== null) throw new Error(`Unexpected argument: ${arg}`);
    requestId = arg;
  }
  if (requestId === null) throw new Error("missing <request_id>");
  if (!/^\d+$/.test(requestId) || Number(requestId) <= 0) {
    throw new Error(`request_id must be a positive integer, got ${JSON.stringify(requestId)}`);
  }
  const base = (baseUrl ?? process.env.SMOKE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  if (base === "") throw new Error("--base-url must not be empty");
  return { requestId: Number(requestId), baseUrl: base };
}

// Canonical bundle bytes: sorted keys, no whitespace — the exact grammar
// `canonicalEvidence` in `verifier/src/judge.ts` commits to. Re-specified
// here (not imported) because this CLI runs dependency-light from `scripts/`.
export function canonicalBundle(bundle) {
  const sorted = {};
  for (const key of Object.keys(bundle).sort()) sorted[key] = bundle[key];
  return JSON.stringify(sorted);
}

export function sha256HexText(data) {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// Signed-text grammar from `verifier/src/bind.ts` (`compareHashes`):
// provider_tee 3-part `{model}:{request_hash}:{response_hash}`.
export function signedEvidenceText(bundle) {
  return `${bundle.model}:${bundle.request_sha256}:${bundle.response_sha256}`;
}

export function recoverEvidenceSigner(bundle) {
  return verifyMessage(signedEvidenceText(bundle), bundle.signature);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    return { ok: false, status: response.status, body: null };
  }
  try {
    return { ok: true, status: response.status, body: await response.json() };
  } catch {
    return { ok: false, status: response.status, body: null };
  }
}

async function resolveExpectedHash(baseUrl, requestId) {
  for (const path of [
    `/api/verify?request_id=${requestId}`,
    `/verify?request_id=${requestId}`,
  ]) {
    try {
      const res = await fetchJson(`${baseUrl}${path}`);
      const hash = res.body?.evidence_sha256;
      if (res.ok && typeof hash === "string" && /^[0-9a-fA-F]{64}$/.test(hash)) {
        return hash.toLowerCase();
      }
    } catch {
      // Try the next source.
    }
  }
  try {
    const res = await fetchJson(`${baseUrl}/api/requests?limit=100`);
    if (res.ok && Array.isArray(res.body)) {
      for (const row of res.body) {
        if (
          row !== null &&
          typeof row === "object" &&
          Number(row.request_id) === requestId &&
          typeof row.evidence_sha256 === "string" &&
          /^[0-9a-fA-F]{64}$/.test(row.evidence_sha256)
        ) {
          return row.evidence_sha256.toLowerCase();
        }
      }
    }
  } catch {
    // No source answered; the hash step reports it.
  }
  return null;
}

export async function runVerifyEvidence(argv = process.argv.slice(2)) {
  const parsed = parseVerifyEvidenceArgs(argv);
  if (parsed.help === true) {
    console.log(verifyEvidenceUsage());
    return 0;
  }
  const { requestId, baseUrl } = parsed;
  const lines = [];
  let failed = false;
  const report = (step, outcome, detail) => {
    lines.push(detail !== "" ? `${step}: ${outcome} ${detail}` : `${step}: ${outcome}`);
    if (outcome === "FAIL") failed = true;
  };

  let bundle = null;
  try {
    const res = await fetchJson(`${baseUrl}/api/evidence/${requestId}`);
    if (res.ok && res.body !== null && typeof res.body === "object") {
      bundle = res.body;
      report("fetch", "PASS", `/api/evidence/${requestId}`);
    } else {
      report("fetch", "FAIL", `/api/evidence/${requestId} -> status ${res.status}`);
    }
  } catch (error) {
    report("fetch", "FAIL", `/api/evidence/${requestId} -> ${error.message}`);
  }

  let hashPass = false;
  if (bundle === null) {
    report("hash", "FAIL", "no bundle to hash");
  } else {
    const actual = sha256HexText(canonicalBundle(bundle));
    const expected = await resolveExpectedHash(baseUrl, requestId);
    if (expected === null) {
      report("hash", "FAIL", "recorded evidence_sha256 not found");
    } else if (actual === expected) {
      hashPass = true;
      report("hash", "PASS", `sha256(canonical bundle) matches ${expected}`);
    } else {
      report("hash", "FAIL", `sha256(canonical bundle) ${actual} != ${expected}`);
    }
  }

  let signerPass = false;
  let recovered = "";
  if (bundle === null) {
    report("signer", "FAIL", "no bundle to check");
  } else if (
    typeof bundle.signature !== "string" ||
    bundle.signature === "" ||
    typeof bundle.signing_address !== "string" ||
    bundle.signing_address === ""
  ) {
    report("signer", "FAIL", "bundle carries no signature or signing_address");
  } else {
    try {
      recovered = recoverEvidenceSigner(bundle);
      if (recovered.toLowerCase() === bundle.signing_address.toLowerCase()) {
        signerPass = true;
        report("signer", "PASS", `${recovered} matches signing_address`);
      } else {
        report("signer", "FAIL", `recovered ${recovered} != ${bundle.signing_address}`);
      }
    } catch (error) {
      report("signer", "FAIL", `recovery failed: ${error.message}`);
    }
  }

  if (bundle !== null && bundle.fixture === true) {
    lines.push("attestation: fixture");
  } else if (bundle !== null && hashPass && signerPass) {
    report("attestation", "PASS", "live-issued and signature-bound");
  } else {
    report("attestation", "FAIL", bundle === null ? "no bundle to check" : "not signature-bound");
  }

  for (const line of lines) console.log(line);
  return failed ? 1 : 0;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await runVerifyEvidence();
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    console.error(verifyEvidenceUsage());
    process.exitCode = 2;
  }
}
