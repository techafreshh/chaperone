import { NextResponse } from "next/server";
import { isLiveTier, liveWriteBlocked } from "../../../../../lib/guard";
import { setAgentActive } from "../../../../../lib/fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixture-tier one-click freeze: the operator wallet signs
// `set_agent_active` on the live tier (this route answers the exact 403
// there and sends nothing). Unknown agents 404, otherwise exactly 200
// `{"active":false}` with the fleet overlay flipped so `GET /fleet` shows
// `frozen` for the agent.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (isLiveTier()) return liveWriteBlocked();
  const params = await ctx.params;
  const agent = await setAgentActive(params.id, false);
  if (!agent) {
    return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  }
  return NextResponse.json({ active: false }, { status: 200 });
}
