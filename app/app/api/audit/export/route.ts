import { handleAuditExportGet } from "../../../../lib/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAuditExportGet(request);
}
