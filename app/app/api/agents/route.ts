import {
  handleAgentsGet,
  handleAgentsPatch,
  handleAgentsPost,
} from "../../../lib/fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleAgentsGet(request);
}

export async function POST(request: Request) {
  return handleAgentsPost(request);
}

export async function PATCH(request: Request) {
  return handleAgentsPatch(request);
}
