import { handleQueueReject } from "../../../../../lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const params = await ctx.params;
  return handleQueueReject(params.id);
}
