import { handleVerifyGet, handleVerifyPost } from "../../lib/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleVerifyPost(request);
}

export async function GET(request: Request) {
  return handleVerifyGet(request);
}
