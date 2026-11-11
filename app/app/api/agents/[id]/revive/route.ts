import { NextResponse } from "next/server";
import { isLiveTier, liveWriteBlocked } from "../../../../../lib/guard";
import { setAgentActive } from "../../../../../lib/fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixture-tier revive (kill inverse): live-tier freeze/revive is
// wallet-signed `set_agent_active` in the browser, so this route answers
// the exact 403 there and sends nothing. Otherwise exactly 200
// `{"active":true}`.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (isLiveTier()) return liveWriteBlocked();
  const params = await ctx.params;
  const agent = await setAgentActive(params.id, true);
  if (!agent) {
    return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  }
  return NextResponse.json({ active: true }, { status: 200 });
}
