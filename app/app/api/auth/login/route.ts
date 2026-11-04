import { handleLoginPost } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleLoginPost(request);
}

// Query-string login alias (`GET /api/auth/login?account_id=...`) so the
// operator can sign in from a plain link or form as well as JSON.
export async function GET(request: Request) {
  return handleLoginPost(request);
}
