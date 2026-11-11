import { NextResponse } from "next/server";
import {
  createNearChainAdapter,
  createVerifyStack,
  getEvidenceBundle,
  type VerifyStack,
} from "../../verifier/src/server";

// Shared `/verify` HTTP handlers. Both the documented `/api/verify` routes
// and the issue-contract `/verify` aliases delegate here so the two
// prefixes behave identically. The handler factory is built once per
// process over a module-level in-memory chain seeded with staged requests
// (ids 1-6, so the probe's request 5 exists); a second verification of the
// same request observes the paid/held transition via 409.
//
// Adapter selection is env-driven: `GUARD_CONTRACT_ID` plus the dedicated
// `VERIFIER_ACCOUNT_ID`/`VERIFIER_PRIVATE_KEY` pair selects the live
// `near-api-js` adapter (never the owner key), otherwise the fixture store
// serves. Model ids come from `NEAR_AI_MODEL`, never hardcoded.

let stack: VerifyStack | null = null;

function getStack(): VerifyStack {
  if (stack !== null) return stack;
  const contractId =
    (process.env.GUARD_CONTRACT_ID ?? process.env.NEAR_CONTRACT_ID ?? "").trim();
  // Live `/verify` writes are submitted with a dedicated verifier key,
  // never the owner key: the contract's `submit_verdict` is
  // permissionless-but-signature-gated, so no owner signature is needed.
  const accountId = (process.env.VERIFIER_ACCOUNT_ID ?? "").trim();
  const privateKey = (process.env.VERIFIER_PRIVATE_KEY ?? "").trim();
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

// Evidence-bundle read path: serves the canonical evidence bundle the
// verifier stored when it judged `id`, so anyone can re-check the
// per-verdict link. Non-positive-integer ids are 400; unjudged, refused,
// or unknown ids are 404.
export async function handleEvidenceGet(
  id: unknown,
): Promise<NextResponse> {
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { error: "request_id must be a positive integer" },
      { status: 400 },
    );
  }
  const bundle = getEvidenceBundle(id);
  if (bundle === null) {
    return NextResponse.json(
      { error: "evidence not found", request_id: id },
      { status: 404 },
    );
  }
  return NextResponse.json(bundle, { status: 200 });
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
