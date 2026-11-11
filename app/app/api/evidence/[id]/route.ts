import { handleEvidenceGet } from "../../../../lib/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const params = await ctx.params;
  return handleEvidenceGet(Number(params.id));
}
