import { NextResponse } from "next/server";
import { requireOwner } from "../../../../../lib/auth";
import { setAgentActive } from "../../../../../lib/fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-gated revive (kill inverse): same gating as the kill route,
// otherwise exactly 200 `{"active":true}`.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const params = await ctx.params;
  const auth = requireOwner(request);
  if (auth instanceof NextResponse) return auth;
  const agent = await setAgentActive(params.id, true);
  if (!agent) {
    return NextResponse.json({ error: "unknown agent" }, { status: 404 });
  }
  return NextResponse.json({ active: true }, { status: 200 });
}
