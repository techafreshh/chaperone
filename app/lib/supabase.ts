import { NextResponse } from "next/server";
import fs from "node:fs";
import { getStatus } from "../../verifier/src/preflight";
import type { Env } from "./env";

// Supabase read mirror client (issue #12). The mirror is query-only: the
// chain stays the source of truth and these helpers never authorize
// payment. Without `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` the mirror is an
// explicit labeled `disabled` state (503 from the route, never fake rows).

// On-chain payout vocabulary (mirrors `contract/src/request.rs`): the
// merged feed carries every status verbatim, so `paying` (transfer in
// flight) and `failed` (bounced transfer, reason `TransferFailed`) flow
// through with badges like any other row — no filter drops them.
export const STATUS_PAYING = "paying";
export const STATUS_FAILED = "failed";

export const MIRROR_HEADER = "x-chaperone-mirror";
export const MIRROR_DISABLED_REASON =
  "SUPABASE_URL/SUPABASE_SERVICE_KEY not configured";
export const DEFAULT_REQUESTS_LIMIT = 20;
export const MAX_REQUESTS_LIMIT = 100;

export type MirrorStatus =
  | { state: "disabled"; reason: string }
  | { state: "ready"; url: string };

export function getMirrorStatus(
  env: Env = process.env,
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
  badge?: unknown;
  source?: unknown;
  [key: string]: unknown;
}

// Row provenance for the request feed (issue #63). Every merged row
// carries its tier: `chain` (live contract view), `mirror` (Supabase
// PostgREST), `stub` (file-injected harness rows), or `fixture`
// (labeled display data). Fixture and stub rows render a visible
// `sample data` tag and never resolve to `verified`.

export type RequestSource = "chain" | "mirror" | "stub" | "fixture";

export function isRequestSource(value: unknown): value is RequestSource {
  return (
    value === "chain" ||
    value === "mirror" ||
    value === "stub" ||
    value === "fixture"
  );
}

// A row is backed by live evidence only when it carries a non-empty
// signature field bound to that request id (`verdict_signature` /
// `signature` / `signature_base58`). Fixture and stub tiers never carry
// live signatures; chain/mirror rows without one are unbacked.
function hasBoundSignature(row: MirrorRequestRow): boolean {
  const record = row as Record<string, unknown>;
  for (const key of ["verdict_signature", "signature", "signature_base58"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return true;
  }
  return false;
}

// Attestation badge vocabulary for the request feed (issue #14).
// Binary-honest states only: a row is either TEE-verified, explicitly
// unverifiable, or honestly deterministic-only. The JSON API carries the
// short forms; `badgeToLabel` maps them to the literal display strings.
export type RequestBadge = "verified" | "unverifiable" | "deterministic-only";

export function isRequestBadge(value: unknown): value is RequestBadge {
  return (
    value === "verified" ||
    value === "unverifiable" ||
    value === "deterministic-only"
  );
}

export function badgeToLabel(badge: RequestBadge): string {
  if (badge === "verified") return "TEE-verified";
  if (badge === "unverifiable") return "attestation unverifiable";
  return "deterministic-only";
}

export type BadgedRequestRow = MirrorRequestRow & {
  badge: RequestBadge;
  source: RequestSource;
};

// Hardened badge (issue #63): `verified` only for chain/mirror rows
// backed by a verified non-fixture preflight (`getStatus().badge`) plus a
// signature bound to that request id. Fixture, stub, and unsourced rows
// never resolve to `verified`, whatever their `badge` field says — the
// row badge and the unbacked global are ignored for `verified` and fall
// back to `deterministic-only` (explicit `unverifiable` still surfaces).
export function resolveRequestBadge(row: MirrorRequestRow): RequestBadge {
  const source = (row as { source?: unknown }).source;
  if (source !== "chain" && source !== "mirror") {
    return "deterministic-only";
  }
  const backed = hasBoundSignature(row);
  let global: RequestBadge | null = null;
  try {
    const live = getStatus().badge;
    if (isRequestBadge(live)) global = live;
  } catch {
    global = null;
  }
  if (backed && global === "verified") return "verified";
  if (row !== null && typeof row === "object" && row.badge === "unverifiable") {
    return "unverifiable";
  }
  if (
    row !== null &&
    typeof row === "object" &&
    row.badge === "deterministic-only"
  ) {
    return "deterministic-only";
  }
  if (global === "unverifiable") return "unverifiable";
  return "deterministic-only";
}

export function enrichRequestsWithBadge(
  rows: MirrorRequestRow[],
): BadgedRequestRow[] {
  return rows.map((row) => {
    const source: RequestSource = isRequestSource(
      (row as { source?: unknown }).source,
    )
      ? (row.source as RequestSource)
      : "fixture";
    const sourced = { ...row, source };
    return { ...sourced, badge: resolveRequestBadge(sourced) };
  });
}

// File-injected request tier for harnesses. `REQUESTS_STUB_FILE` points at
// JSON shaped either as an array of request rows or `{ "requests": [...] }`
// (same dual-shape tolerance as `loadStubAgents` in `./fleet`).
export const REQUESTS_STUB_FILE = "REQUESTS_STUB_FILE";

function normalizeStubRequestId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function normalizeStubRequest(
  raw: Record<string, unknown>,
): MirrorRequestRow | null {
  const request_id = normalizeStubRequestId(
    raw.request_id ?? raw.requestId ?? raw.id,
  );
  if (request_id === null) return null;
  const status = typeof raw.status === "string" ? raw.status : "staged";
  return { ...raw, request_id, status, source: "stub" };
}

export function loadStubRequests(
  env: Env = process.env,
): MirrorRequestRow[] | null {
  const path = (env[REQUESTS_STUB_FILE] ?? "").trim();
  if (path === "") return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as Record<string, unknown>)?.requests;
    if (!Array.isArray(list)) return null;
    return (list as unknown[])
      .map((item) =>
        item !== null && typeof item === "object"
          ? normalizeStubRequest(item as Record<string, unknown>)
          : null,
      )
      .filter((row): row is MirrorRequestRow => row !== null)
      .sort((a, b) => b.request_id - a.request_id);
  } catch {
    return null;
  }
}

// Labeled fixture tier for the page merge (issue #63 sample data, not
// live evidence): a paid `invoice-114` CoreWeave row, a rejected
// `PayeeNotAllowlisted` poisoned row citing `invoice-114`, and a held row.
// Every fixture row carries `source: "fixture"` and a
// `deterministic-only` badge so the offline page never renders
// `TEE-verified`; `resolveRequestBadge` additionally forces fixture/stub
// rows to `deterministic-only` even when a harness injects `badge:
// "verified"`.
export const FIXTURE_REQUESTS: MirrorRequestRow[] = [
  {
    request_id: 3,
    agent_id: "agent-1.signer.testnet",
    payee: "coreweave.near",
    amount_yocto: "1000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "paid",
    reason: "allowlisted payee, cap respected",
    badge: "deterministic-only",
    source: "fixture",
  },
  {
    request_id: 2,
    agent_id: "agent-2.signer.testnet",
    payee: "evil.example",
    amount_yocto: "5000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "PoisonVendor",
    status: "rejected",
    reason:
      "PayeeNotAllowlisted: payee evil.example not allowlisted for invoice-114",
    badge: "deterministic-only",
    source: "fixture",
  },
  {
    request_id: 1,
    agent_id: "agent-1.signer.testnet",
    payee: "pending.near",
    amount_yocto: "2000000000000000000000000",
    purpose_ref: "invoice-115",
    vendor: "CoreWeave",
    status: "held",
    reason: "quorum not reached",
    badge: "deterministic-only",
    source: "fixture",
  },
];

// Merged request feed for the page: fixture, then stub file, then mirror
// rows. Union by `request_id` (mirror wins over stub over fixture),
// sorted newest-first, every row stamped with a valid `badge` and an
// explicit `source`. Mirror failures fall through to the file tiers so
// the page still renders.
export async function getMergedRequests(
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<BadgedRequestRow[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const merged = new Map<number, MirrorRequestRow>();
  for (const row of FIXTURE_REQUESTS) {
    merged.set(row.request_id, { ...row, source: "fixture" });
  }
  const stub = loadStubRequests(env);
  if (stub !== null) {
    for (const row of stub) {
      merged.set(row.request_id, { ...row, source: "stub" });
    }
  }
  try {
    const mirror = await listRequests(MAX_REQUESTS_LIMIT, fetchImpl, env);
    for (const raw of mirror) {
      if (raw === null || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const request_id = normalizeStubRequestId(record.request_id);
      if (request_id === null) continue;
      const status =
        typeof record.status === "string" ? record.status : "staged";
      merged.set(request_id, { ...record, request_id, status, source: "mirror" });
    }
  } catch {
    // Mirror disabled or unreachable: fixture+stub tiers still render.
  }
  return enrichRequestsWithBadge(
    [...merged.values()].sort((a, b) => b.request_id - a.request_id),
  );
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
  env: Env = process.env,
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
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<NextResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const status = getMirrorStatus(env);
  if (status.state === "disabled") {
    // Stub tier: harness-declared rows are served (limit-clamped, stamped)
    // even without mirror credentials. With no source at all the route
    // stays 503-disabled so the #12 contract holds.
    const stub = loadStubRequests(env);
    if (stub === null) {
      return NextResponse.json(
        { error: `mirror disabled: ${status.reason}`, mirror: "disabled" },
        { status: 503, headers: { [MIRROR_HEADER]: "disabled" } },
      );
    }
    const limit = clampRequestsLimit(
      new URL(request.url).searchParams.get("limit"),
    );
    return NextResponse.json(enrichRequestsWithBadge(stub.slice(0, limit)), {
      status: 200,
      headers: { [MIRROR_HEADER]: "stub" },
    });
  }
  const limit = clampRequestsLimit(
    new URL(request.url).searchParams.get("limit"),
  );
  try {
    const rows = await listRequests(limit, fetchImpl, env);
    return NextResponse.json(
      enrichRequestsWithBadge(
        rows.map((row) => ({ ...row, source: "mirror" as const })),
      ), {
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
