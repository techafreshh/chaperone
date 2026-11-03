// Operator live-tier smoke: exercises the RUNNING service's real preflight
// against NEAR AI Cloud. Run order: start the app with NEAR_AI_API_KEY (and
// NEAR_AI_MODEL) set, then run this script:
//
//   NEAR_AI_API_KEY=... NEAR_AI_MODEL=qwen3-30b npm --prefix app run start &
//   NEAR_AI_API_KEY=... node scripts/verifier-live-smoke.mjs
//
// Exit 0 with SKIP when NEAR_AI_API_KEY is unset (fixture mode covers CI).
// With a key set, asserts live `verified:true` plus a 42-char `0x`
// signing address; any other outcome exits non-zero.

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
    process.exit(0);
  }
  lastError = `${path} -> ${response.status} ${JSON.stringify(body).slice(0, 300)}`;
}
console.error(`FAIL: live preflight not verified. ${lastError}`);
process.exit(1);
