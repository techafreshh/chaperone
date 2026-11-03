import { handlePreflightPost } from "../../../lib/attestation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handlePreflightPost(request);
}
