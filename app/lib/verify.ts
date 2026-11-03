import { NextResponse } from "next/server";
import {
  createNearChainAdapter,
  createVerifyStack,
  type VerifyStack,
} from "../../verifier/src/server";

// Shared `/verify` HTTP handlers. Both the documented `/api/verify` routes
// and the issue-contract `/verify` aliases delegate here so the two
// prefixes behave identically. The handler factory is built once per
// process over a module-level in-memory chain seeded with staged requests
// (ids 1-6, so the probe's request 5 exists); a second verification of the
// same request observes the paid/held transition via 409.
//
// Adapter selection is env-driven: `GUARD_CONTRACT_ID` plus signer env
// selects the live `near-api-js` adapter, otherwise the fixture store
// serves. Model ids come from `NEAR_AI_MODEL`, never hardcoded.

let stack: VerifyStack | null = null;

function getStack(): VerifyStack {
  if (stack !== null) return stack;
  const contractId = process.env.GUARD_CONTRACT_ID ?? "";
  const accountId = process.env.NEAR_ACCOUNT_ID ?? "";
  const privateKey = process.env.NEAR_PRIVATE_KEY ?? "";
  if (contractId !== "" && accountId !== "" && privateKey !== "") {
    stack = createVerifyStack({
      chain: createNearChainAdapter({ contractId, accountId, privateKey }),
    });
  } else {
    stack = createVerifyStack();
  }
  return stack;
}

// Test seam: drop the module-level stack (fresh staged requests).
export function resetVerifyStack(): void {
  stack = null;
}

export async function handleVerifyPost(
  request: Request,
): Promise<NextResponse> {
  let body: { request_id?: unknown; tamper?: unknown } = {};
  try {
    body = (await request.json()) as { request_id?: unknown };
  } catch {
    body = {};
  }
  // Body-first, query-param fallback (test/operator trigger parity).
  const queryTamper = new URL(request.url).searchParams.get("tamper");
  const result = await getStack().handle({
    request_id: body.request_id,
    tamper: body.tamper ?? queryTamper,
  });
  return NextResponse.json(result.body, { status: result.status });
}

export async function handleVerifyGet(
  request: Request,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const raw = url.searchParams.get("request_id");
  const result = await getStack().handle.view(
    raw === null ? undefined : Number(raw),
  );
  return NextResponse.json(result.body, { status: result.status });
}
