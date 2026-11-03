// Operator live-tier smoke: exercises the RUNNING service's real preflight
// and judged verdict path against NEAR AI Cloud. Run order: start the app
// with NEAR_AI_API_KEY (and NEAR_AI_MODEL) set, then run this script:
//
//   NEAR_AI_API_KEY=... NEAR_AI_MODEL=qwen3-30b npm --prefix app run start &
//   NEAR_AI_API_KEY=... node scripts/verifier-live-smoke.mjs [--judge]
//
// Exit 0 with SKIP when NEAR_AI_API_KEY is unset (fixture mode covers CI).
// With a key set, asserts live `verified:true` plus a 42-char `0x`
// signing address; any other outcome exits non-zero.
//
// `--judge` extends the smoke to one real judged completion end to end
// (judge → bind → sign → submit) via `POST /verify` with
// `VERIFY_REQUEST_ID` (default 5). The verdict lands on the service's
// fixture store in CI-shaped environments and on-chain when the live
// adapter is configured. `--help` documents both modes.

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`usage: node scripts/verifier-live-smoke.mjs [--judge] [--help]

  (default)  live preflight smoke against /attestation/preflight
  --judge    additionally POST /verify {request_id} end to end
             (VERIFY_REQUEST_ID, default 5)

  Both modes SKIP with exit 0 when NEAR_AI_API_KEY is unset.`);
  process.exit(0);
}

const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const model = process.env.NEAR_AI_MODEL ?? "qwen3-30b";
const apiKey = process.env.NEAR_AI_API_KEY ?? "";

if (apiKey === "") {
  console.log("SKIP: NEAR_AI_API_KEY unset (fixture mode covers CI)");
  process.exit(0);
}

const paths = ["/attestation/preflight", "/api/attestation/preflight"];
let lastError = "";
for (const path of paths) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  const body = await response.json().catch(() => ({}));
  if (
    response.ok &&
    body.verified === true &&
    typeof body.signing_address === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(body.signing_address) &&
    body.fixture === false
  ) {
    console.log(`OK: live preflight verified via ${path}`);
    break;
  }
  lastError = `${path} -> ${response.status} ${JSON.stringify(body).slice(0, 300)}`;
  if (path === paths[paths.length - 1]) {
    console.error(`FAIL: live preflight not verified. ${lastError}`);
    process.exit(1);
  }
}

if (!args.includes("--judge")) process.exit(0);

// Live-tier judge mode: one real judged completion end to end.
const requestId = Number(process.env.VERIFY_REQUEST_ID ?? "5");
const verifyPaths = ["/verify", "/api/verify"];
let judgeError = "";
for (const path of verifyPaths) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId }),
  });
  const body = await response.json().catch(() => ({}));
  if (
    response.ok &&
    typeof body.consistent === "boolean" &&
    typeof body.signature === "string" &&
    body.signature.length > 0 &&
    body.request_id === requestId
  ) {
    console.log(
      `OK: live judge verdict via ${path} (consistent=${body.consistent})`,
    );
    process.exit(0);
  }
  judgeError = `${path} -> ${response.status} ${JSON.stringify(body).slice(0, 300)}`;
}
console.error(`FAIL: live judge verdict not returned. ${judgeError}`);
process.exit(1);
