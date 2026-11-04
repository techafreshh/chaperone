import { handleVerifierKeyPost } from "../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleVerifierKeyPost(request);
}
