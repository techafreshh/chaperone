import { handleStatusGet } from "../../../../lib/attestation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleStatusGet();
}
