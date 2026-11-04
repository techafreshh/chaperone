import { NextResponse } from "next/server";
import { requireOwner } from "../../../../../lib/auth";
import { setAgentActive } from "../../../../../lib/fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-gated one-click freeze: missing/unknown session fails closed with
// the exact 401, unknown agents 404, otherwise exactly 200
// `{"active":false}` with the fleet overlay flipped so `GET /fleet` shows
// `frozen` for the agent.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const params = await ctx.params;
  const auth = requireOwner(request);
  if (auth instanceof NextResponse) return auth;
  const agent = await setAgentActive(params.id, false);
  if (!agent) {
    return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  }
  return NextResponse.json({ active: false }, { status: 200 });
}
