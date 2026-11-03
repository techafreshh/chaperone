import { NextResponse } from "next/server";

// Supabase read mirror client (issue #12). The mirror is query-only: the
// chain stays the source of truth and these helpers never authorize
// payment. Without `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` the mirror is an
// explicit labeled `disabled` state (503 from the route, never fake rows).

export const MIRROR_HEADER = "x-chaperone-mirror";
export const MIRROR_DISABLED_REASON =
  "SUPABASE_URL/SUPABASE_SERVICE_KEY not configured";
export const DEFAULT_REQUESTS_LIMIT = 20;
export const MAX_REQUESTS_LIMIT = 100;

export type MirrorStatus =
  | { state: "disabled"; reason: string }
  | { state: "ready"; url: string };

export function getMirrorStatus(
  env: NodeJS.ProcessEnv = process.env,
): MirrorStatus {
  const url = (env.SUPABASE_URL ?? "").trim();
  const serviceKey = env.SUPABASE_SERVICE_KEY ?? "";
  if (url === "" || serviceKey === "") {
    return { state: "disabled", reason: MIRROR_DISABLED_REASON };
  }
  return { state: "ready", url: url.replace(/\/+$/, "") };
}

export interface MirrorRequestRow {
  request_id: number;
  status: string;
  [key: string]: unknown;
}

export function clampRequestsLimit(raw: unknown): number {
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_REQUESTS_LIMIT;
  return Math.min(MAX_REQUESTS_LIMIT, Math.max(1, Math.floor(parsed)));
}

// Read mirrored requests newest-first via PostgREST. Throws a labeled
// `mirror disabled` error without credentials, and a transport error when
// the upstream fetch fails or returns non-2xx.
export async function listRequests(
  limit: number = DEFAULT_REQUESTS_LIMIT,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MirrorRequestRow[]> {
  const status = getMirrorStatus(env);
  if (status.state === "disabled") {
    throw new Error(`mirror disabled: ${status.reason}`);
  }
  const serviceKey = env.SUPABASE_SERVICE_KEY as string;
  const clamped = clampRequestsLimit(limit);
  const endpoint =
    `${status.url}/rest/v1/requests` +
    `?select=*&order=request_id.desc&limit=${clamped}`;
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
  } catch (err) {
    throw new Error(
      `mirror request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    let excerpt = "";
    try {
      excerpt = (await res.text()).slice(0, 300);
    } catch {
      excerpt = "";
    }
    throw new Error(
      `mirror request failed: GET requests -> ${res.status} ${excerpt}`,
    );
  }
  return (await res.json()) as MirrorRequestRow[];
}

// Shared `GET /api/requests` handler: 200 JSON array on success, 503 with
// `mirror: "disabled"` when unconfigured, 502 on transport failure. Every
// response carries `x-chaperone-mirror` so callers can tell an empty
// mirror apart from a disabled one.
export async function handleRequestsGet(
  request: Request,
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<NextResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const status = getMirrorStatus(env);
  if (status.state === "disabled") {
    return NextResponse.json(
      { error: `mirror disabled: ${status.reason}`, mirror: "disabled" },
      { status: 503, headers: { [MIRROR_HEADER]: "disabled" } },
    );
  }
  const limit = clampRequestsLimit(
    new URL(request.url).searchParams.get("limit"),
  );
  try {
    const rows = await listRequests(limit, fetchImpl, env);
    return NextResponse.json(rows, {
      status: 200,
      headers: { [MIRROR_HEADER]: "ready" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: message },
      { status: 502, headers: { [MIRROR_HEADER]: "ready" } },
    );
  }
}
