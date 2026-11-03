import { NextResponse } from "next/server";
import { getStatus, runPreflight } from "../../verifier/src/preflight";

// Shared attestation HTTP handlers. Both the documented `/api/...` routes
// and the issue-contract `/attestation/...` aliases delegate here so the
// two prefixes behave identically.

// Any client-supplied nonce is ignored: the server always generates a fresh
// 32-byte nonce per call inside runPreflight.
export async function handlePreflightPost(
  request: Request,
): Promise<NextResponse> {
  let body: { model?: unknown } = {};
  try {
    body = (await request.json()) as { model?: unknown };
  } catch {
    body = {};
  }
  const apiKey = process.env.NEAR_AI_API_KEY ?? "";
  const requestedModel =
    typeof body.model === "string" && body.model !== ""
      ? body.model
      : (process.env.NEAR_AI_MODEL ?? "");
  // Fixture mode falls back to a sentinel (never a catalog id); live mode
  // with no model anywhere fails closed via runPreflight.
  const model =
    apiKey === ""
      ? requestedModel !== ""
        ? requestedModel
        : "fixture-model"
      : requestedModel;

  const result = await runPreflight({ model, apiKey });
  const wire: Record<string, unknown> = {
    verified: result.verified,
    request_nonce: result.request_nonce,
    model: result.model,
    fixture: result.fixture,
  };
  if (result.signing_address !== undefined)
    wire.signing_address = result.signing_address;
  if (result.reason !== undefined) wire.reason = result.reason;

  let status = 200;
  if (result.transportError === true) status = 502;
  else if (!result.fixture && result.model === "") status = 400;
  return NextResponse.json(wire, { status });
}

export function handleStatusGet(): NextResponse {
  return NextResponse.json(getStatus());
}
