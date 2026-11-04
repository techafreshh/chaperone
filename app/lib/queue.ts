// Approval queue data layer (issue #15). Merges held requests from four
// read tiers — fixture, stub file (`QUEUE_STUB_FILE` then
// `REQUESTS_STUB_FILE`), Supabase mirror (`requests` with
// `status=eq.held`), live chain `list_queue` — plus a killed-agent join for
// the `agent frozen` banner. Writes go to an in-process overlay (plus a
// best-effort wallet-signed `approve_hold`/`reject_hold` when live creds
// exist) so the next `GET /queue` in the same process reflects the
// decision.
//
// Status strings mirror the contract exactly (`held`/`paid`/`rejected`,
// `HoldRejected`); `AgentView.active` is the frozen source of truth.

import { NextResponse } from "next/server";
import fs from "node:fs";
import { getMirrorStatus } from "./supabase";
import type { Env } from "./env";

export interface QueueRow {
  request_id: number;
  agent_id: string;
  payee: string;
  amount_yocto: string;
  purpose_ref: string;
  vendor: string;
  status: string;
  reason?: string | null;
  objection?: string | null;
  active: boolean;
}

export interface QueueState {
  requests: QueueRow[];
  source: "fixture" | "stub" | "mirror" | "chain" | "overlay";
}

export const QUEUE_STUB_FILE = "QUEUE_STUB_FILE";
export const REQUESTS_STUB_FILE_KEY = "REQUESTS_STUB_FILE";

export const REASON_HOLD_REJECTED = "HoldRejected";

// Fixture tier (labeled display data, never live evidence): held request 6
// with the probe's `reason mismatch` objection from an active agent, plus a
// held row from the frozen `agent-3` so the default page carries the
// `agent frozen` banner.
export const FIXTURE_QUEUE_REQUESTS: QueueRow[] = [
  {
    request_id: 6,
    agent_id: "agent-1",
    payee: "good.near",
    amount_yocto: "5000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "held",
    reason: "reason mismatch",
    active: true,
  },
  {
    request_id: 5,
    agent_id: "agent-3",
    payee: "good.near",
    amount_yocto: "5000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "held",
    reason: "purpose mismatch",
    active: false,
  },
];

function normalizeQueueId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function normalizeAmountYocto(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value).toString();
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "bigint" && value >= BigInt(0)) {
    return value.toString();
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["U128", "u128", "amount", "value", "yocto"]) {
      if (key in record) return normalizeAmountYocto(record[key], fallback);
    }
  }
  return fallback;
}

function normalizeQueueActive(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (
      s === "false" ||
      s === "0" ||
      s === "off" ||
      s === "no" ||
      s === "n" ||
      s === "inactive" ||
      s === "frozen" ||
      s === "disabled"
    )
      return false;
    if (
      s === "true" ||
      s === "1" ||
      s === "on" ||
      s === "yes" ||
      s === "y" ||
      s === "active" ||
      s === "enabled"
    )
      return true;
    return fallback;
  }
  return fallback;
}

function normalizeQueueRow(raw: Record<string, unknown>): QueueRow | null {
  const request_id = normalizeQueueId(
    raw.request_id ?? raw.requestId ?? raw.id,
  );
  if (request_id === null) return null;
  const agentRaw = raw.agent_id ?? raw.agentId ?? raw.agent;
  const agent_id =
    typeof agentRaw === "string" && agentRaw.trim() !== ""
      ? agentRaw.trim()
      : "";
  if (agent_id === "") return null;
  const status = typeof raw.status === "string" ? raw.status : "staged";
  const reason =
    typeof raw.reason === "string"
      ? raw.reason
      : raw.reason === null || raw.reason === undefined
        ? null
        : String(raw.reason);
  const objection =
    typeof raw.objection === "string"
      ? raw.objection
      : raw.objection === null || raw.objection === undefined
        ? null
        : String(raw.objection);
  return {
    request_id,
    agent_id,
    payee: typeof raw.payee === "string" ? raw.payee : "",
    amount_yocto: normalizeAmountYocto(raw.amount_yocto, "0"),
    purpose_ref:
      typeof raw.purpose_ref === "string"
        ? raw.purpose_ref
        : typeof raw.purposeRef === "string"
          ? (raw.purposeRef as string)
          : "",
    vendor: typeof raw.vendor === "string" ? raw.vendor : "",
    status,
    reason,
    objection,
    active: normalizeQueueActive(raw.active, true),
  };
}

// File-injected tier for harnesses: `QUEUE_STUB_FILE` first, then
// `REQUESTS_STUB_FILE`. Both accept a bare array or a `{ requests: [...] }`
// object; `request_id` normalizes from number or numeric string, `status`
// defaults to `staged`. Null on unset/unreadable/malformed (fall through,
// never throw).
export function loadStubQueue(
  env: Env = process.env,
): QueueRow[] | null {
  for (const key of [QUEUE_STUB_FILE, REQUESTS_STUB_FILE_KEY]) {
    const path = (env[key] ?? "").trim();
    if (path === "") continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed as Record<string, unknown>)?.requests;
      if (!Array.isArray(list)) continue;
      const rows = (list as unknown[])
        .map((item) =>
          item !== null && typeof item === "object"
            ? normalizeQueueRow(item as Record<string, unknown>)
            : null,
        )
        .filter((row): row is QueueRow => row !== null)
        .sort((a, b) => b.request_id - a.request_id);
      return rows;
    } catch {
      continue;
    }
  }
  return null;
}

export type MirrorQueueResult =
  | { state: "disabled"; reason: string }
  | { state: "ready"; requests: QueueRow[] }
  | { state: "unavailable"; reason: string };

// Mirror `requests` reader filtered to held rows. Same PostgREST header
// shape as the #12 migration; labeled `disabled` without creds, labeled
// `unavailable` on transport failure — never throws. The PostgREST
// `status=eq.held` filter is backed by a client-side held check so an
// unfiltered mirror still yields a held-only queue.
export async function loadMirrorQueue(
  fetchImpl: typeof fetch = fetch,
  env: Env = process.env,
): Promise<MirrorQueueResult> {
  const status = getMirrorStatus(env);
  if (status.state === "disabled") {
    return { state: "disabled", reason: status.reason };
  }
  const serviceKey = env.SUPABASE_SERVICE_KEY as string;
  const endpoint =
    `${status.url}/rest/v1/requests` +
    `?select=*&status=eq.held&order=request_id.asc`;
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
  } catch (err) {
    return {
      state: "unavailable",
      reason: `mirror queue failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    let excerpt = "";
    try {
      excerpt = (await res.text()).slice(0, 300);
    } catch {
      excerpt = "";
    }
    return {
      state: "unavailable",
      reason: `mirror queue failed: GET requests -> ${res.status} ${excerpt}`,
    };
  }
  let rows: unknown;
  try {
    rows = await res.json();
  } catch (err) {
    return {
      state: "unavailable",
      reason: `mirror queue failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(rows)) return { state: "ready", requests: [] };
  const requests = (rows as unknown[])
    .map((item) =>
      item !== null && typeof item === "object"
        ? normalizeQueueRow(item as Record<string, unknown>)
        : null,
    )
    .filter((row): row is QueueRow => row !== null)
    .filter((row) => row.status === "held");
  return { state: "ready", requests };
}

async function rpcCallQueue(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `chaperone-queue-${methodName}`,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`rpc ${methodName} -> ${res.status}`);
  }
  const json = (await res.json()) as {
    result?: { result?: unknown };
  };
  const byteArray = json?.result?.result;
  if (!Array.isArray(byteArray)) {
    throw new Error(`rpc ${methodName} bad shape`);
  }
  return JSON.parse(Buffer.from(byteArray).toString("utf8"));
}

function normalizeChainActive(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("active" in record)
      return normalizeQueueActive(record.active, true);
    return null;
  }
  if (typeof value === "boolean") return value;
  return normalizeQueueActive(value, true);
}

export type ChainQueueResult =
  | { state: "disabled"; reason: string }
  | { state: "unavailable"; reason: string }
  | { state: "ready"; requests: QueueRow[] };

// Chain reader using only global `fetch` (no new dependency). Queries the
// `list_queue` view (held-only ascending by contract) plus `get_agent` per
// held row's `agent_id` (`list_agents` as the liveness fallback) and folds
// `AgentView.active` into each row. Labeled `disabled` without a contract
// id, labeled `unavailable` on any failure — never throws.
export async function loadChainQueue(
  fetchImpl: typeof fetch = fetch,
  env: Env = process.env,
): Promise<ChainQueueResult> {
  const contractId = (
    env.GUARD_CONTRACT_ID ??
    env.NEAR_CONTRACT_ID ??
    ""
  ).trim();
  if (contractId === "") {
    return { state: "disabled", reason: "GUARD_CONTRACT_ID not configured" };
  }
  const rpcUrl =
    (env.NEAR_RPC_URL ?? "").trim() === ""
      ? "https://rpc.testnet.near.org"
      : (env.NEAR_RPC_URL as string).trim();

  let raw: unknown;
  try {
    raw = await rpcCallQueue(fetchImpl, rpcUrl, contractId, "list_queue", {});
  } catch {
    return { state: "unavailable", reason: "chain queue unreachable" };
  }
  if (!Array.isArray(raw)) {
    return { state: "unavailable", reason: "chain queue unreachable" };
  }
  const rows = (raw as unknown[])
    .map((item) =>
      item !== null && typeof item === "object"
        ? normalizeQueueRow(item as Record<string, unknown>)
        : null,
    )
    .filter((row): row is QueueRow => row !== null)
    .filter((row) => row.status === "held");
  if (rows.length === 0) return { state: "ready", requests: [] };

  // Join agent liveness: `get_agent` per held row is authoritative;
  // `list_agents` fills gaps when direct views fail.
  const liveness = new Map<string, boolean>();
  let directOk = false;
  for (const row of rows) {
    if (liveness.has(row.agent_id)) continue;
    try {
      const view = await rpcCallQueue(fetchImpl, rpcUrl, contractId, "get_agent", {
        agent_id: row.agent_id,
      });
      const active = normalizeChainActive(view);
      if (active !== null) {
        liveness.set(row.agent_id, active);
        directOk = true;
      }
    } catch {
      // Fall through to the list_agents fallback below.
    }
  }
  if (!directOk) {
    try {
      const agents = (await rpcCallQueue(
        fetchImpl,
        rpcUrl,
        contractId,
        "list_agents",
        {},
      )) as unknown;
      if (Array.isArray(agents)) {
        for (const item of agents) {
          if (item === null || typeof item !== "object") continue;
          const record = item as Record<string, unknown>;
          const idRaw = record.agent_id ?? record.agentId ?? record.id;
          if (typeof idRaw !== "string" || idRaw.trim() === "") continue;
          const active = normalizeChainActive(record);
          if (active !== null && !liveness.has(idRaw.trim())) {
            liveness.set(idRaw.trim(), active);
          }
        }
      }
    } catch {
      // Liveness stays at row defaults; the queue still renders.
    }
  }
  for (const row of rows) {
    const live = liveness.get(row.agent_id);
    if (live !== undefined) row.active = row.active && live;
  }
  return { state: "ready", requests: rows };
}

// In-process write overlay: approve/reject transitions land here so the
// next `GET /queue` in the same server process reflects the decision.
const overlay = new Map<number, QueueRow>();

// Test seam: drop the module-level overlay.
export function __resetQueueOverlayForTests(): void {
  overlay.clear();
}

// Merged queue view: fixture, then stub file, then mirror rows, then chain
// rows, then the POST overlay. Union by `request_id` (chain over mirror
// over stub over fixture); `active` is the AND across sources
// (frozen-wins, chain `AgentView.active` authoritative) while every other
// field follows tier precedence; the overlay replaces wholesale as the
// operator's latest write intent. The exposed list is held-only,
// newest-first.
export async function getQueueState(
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<QueueState> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const merged = new Map<number, QueueRow>();
  const agentLiveness = new Map<string, boolean>();

  const noteAgent = (agent_id: string, active: boolean): void => {
    const prev = agentLiveness.get(agent_id);
    agentLiveness.set(agent_id, prev === undefined ? active : prev && active);
  };
  const place = (row: QueueRow): void => {
    noteAgent(row.agent_id, row.active);
    const prev = merged.get(row.request_id);
    if (!prev) {
      merged.set(row.request_id, { ...row });
    } else {
      merged.set(row.request_id, {
        ...row,
        active: prev.active && row.active,
      });
    }
  };

  for (const row of FIXTURE_QUEUE_REQUESTS) place({ ...row });
  const stub = loadStubQueue(env);
  if (stub) {
    for (const row of stub) place(row);
  }
  let mirrorReady = false;
  try {
    const mirror = await loadMirrorQueue(fetchImpl, env);
    if (mirror.state === "ready") {
      mirrorReady = true;
      for (const row of mirror.requests) place(row);
    }
  } catch {
    mirrorReady = false;
  }
  let chainReady = false;
  try {
    const chain = await loadChainQueue(fetchImpl, env);
    if (chain.state === "ready") {
      chainReady = true;
      for (const row of chain.requests) {
        // Chain rows already carry joined `AgentView.active`; noting them
        // folds the authoritative liveness into the per-agent AND.
        place(row);
      }
    }
  } catch {
    chainReady = false;
  }

  // Propagate per-agent frozen-wins across request ids: any source that
  // marks an agent inactive freezes all of its rows.
  for (const row of merged.values()) {
    const live = agentLiveness.get(row.agent_id);
    if (live !== undefined) row.active = row.active && live;
  }
  for (const row of overlay.values()) {
    merged.set(row.request_id, { ...row });
  }

  const requests = [...merged.values()]
    .filter((row) => row.status === "held")
    .sort((a, b) => b.request_id - a.request_id);
  const source: QueueState["source"] = chainReady
    ? "chain"
    : mirrorReady
      ? "mirror"
      : stub !== null
        ? "stub"
        : overlay.size > 0
          ? "overlay"
          : "fixture";
  return { requests, source };
}

// Full merged view before the held filter (for 404 diagnostics): overlay
// included, every status kept.
async function getMergedAll(
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<Map<number, QueueRow>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const merged = new Map<number, QueueRow>();
  const placeAll = (row: QueueRow): void => {
    const prev = merged.get(row.request_id);
    if (!prev) merged.set(row.request_id, { ...row });
    else
      merged.set(row.request_id, {
        ...row,
        active: prev.active && row.active,
      });
  };
  for (const row of FIXTURE_QUEUE_REQUESTS) placeAll({ ...row });
  const stub = loadStubQueue(env);
  if (stub) for (const row of stub) placeAll(row);
  try {
    const mirror = await loadMirrorQueue(fetchImpl, env);
    if (mirror.state === "ready") for (const row of mirror.requests) placeAll(row);
  } catch {
    // Mirror disabled or unreachable: file tiers still decide.
  }
  try {
    const chain = await loadChainQueue(fetchImpl, env);
    if (chain.state === "ready") for (const row of chain.requests) placeAll(row);
  } catch {
    // Chain unreachable: file tiers still decide.
  }
  for (const row of overlay.values()) merged.set(row.request_id, { ...row });
  return merged;
}

// Lazily import `near-api-js` so the live chain path never burdens the
// offline/CI path (same pattern as the verifier's lazy load). The
// specifier is intentionally non-literal so typechecking never resolves the
// package statically; the operator installs it for live-tier runs.
const NEAR_API_JS_SPECIFIER = "near-api-js";
async function loadNearApi(): Promise<unknown> {
  try {
    return await import(/* webpackIgnore: true */ NEAR_API_JS_SPECIFIER);
  } catch (error) {
    throw new Error(
      `live chain unavailable: near-api-js could not be loaded (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export interface NearQueueChainOptions {
  contractId: string;
  accountId: string;
  privateKey: string;
  networkId?: string;
  nodeUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface QueueChainAdapter {
  approveHold(requestId: number): Promise<{ status: string }>;
  rejectHold(requestId: number): Promise<{ status: string }>;
}

// Live chain adapter: `approve_hold`/`reject_hold` through `near-api-js`
// function calls, selected when the contract plus signer env is set. Never
// constructed in the fixture/test path.
export function createQueueChainAdapter(
  opts: NearQueueChainOptions,
): QueueChainAdapter {
  const networkId = opts.networkId ?? process.env.NEAR_NETWORK ?? "testnet";
  const nodeUrl = opts.nodeUrl ?? process.env.NEAR_NODE_URL ?? "";
  async function functionCall(
    methodName: "approve_hold" | "reject_hold",
    requestId: number,
  ): Promise<void> {
    const mod = (await loadNearApi()) as {
      connect: (config: unknown) => Promise<{
        account: (id: string) => Promise<{
          functionCall: (args: unknown) => Promise<unknown>;
        }>;
      }>;
      keyStores: {
        InMemoryKeyStore: new () => {
          setKey(n: string, a: string, k: unknown): Promise<void>;
        };
      };
      KeyPair: { fromString(s: string): unknown };
    };
    const keyStore = new mod.keyStores.InMemoryKeyStore();
    await keyStore.setKey(
      networkId,
      opts.accountId,
      mod.KeyPair.fromString(opts.privateKey),
    );
    const near = await mod.connect({
      networkId,
      nodeUrl: nodeUrl !== "" ? nodeUrl : undefined,
      keyStore,
      ...(opts.fetchImpl !== undefined ? { fetch: opts.fetchImpl } : {}),
    });
    const account = await near.account(opts.accountId);
    await account.functionCall({
      contractId: opts.contractId,
      methodName,
      args: { request_id: requestId },
    });
  }
  return {
    async approveHold(requestId: number): Promise<{ status: string }> {
      await functionCall("approve_hold", requestId);
      return { status: "paid" };
    },
    async rejectHold(requestId: number): Promise<{ status: string }> {
      await functionCall("reject_hold", requestId);
      return { status: "rejected" };
    },
  };
}

function liveQueueAdapter(
  env: Env,
  fetchImpl: typeof fetch,
): QueueChainAdapter | null {
  const contractId = (
    env.GUARD_CONTRACT_ID ??
    env.NEAR_CONTRACT_ID ??
    ""
  ).trim();
  const accountId = (env.NEAR_ACCOUNT_ID ?? "").trim();
  const privateKey = (env.NEAR_PRIVATE_KEY ?? "").trim();
  if (contractId === "" || accountId === "" || privateKey === "") return null;
  return createQueueChainAdapter({
    contractId,
    accountId,
    privateKey,
    fetchImpl,
  });
}

function parseQueueId(rawId: unknown): number | null {
  if (typeof rawId === "number") {
    return Number.isInteger(rawId) && rawId > 0 ? rawId : null;
  }
  if (typeof rawId === "string") {
    const trimmed = rawId.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function contractErrorToStatus(message: string): number | null {
  if (message.includes("Request not found")) return 404;
  if (message.includes("Request is not held")) return 409;
  return null;
}

export async function handleQueueApprove(
  rawId: unknown,
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<NextResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const requestId = parseQueueId(rawId);
  if (requestId === null) {
    return NextResponse.json(
      { error: "request_id must be a positive integer" },
      { status: 400 },
    );
  }
  const merged = await getMergedAll({ fetchImpl, env });
  const prev = merged.get(requestId);
  if (!prev || prev.status !== "held") {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  // Best-effort live submit when wallet creds exist; contract-identical
  // errors map to 404/409, transport failures fall through to the overlay.
  const adapter = liveQueueAdapter(env, fetchImpl);
  if (adapter !== null) {
    try {
      await adapter.approveHold(requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const mapped = contractErrorToStatus(message);
      if (mapped !== null) {
        return NextResponse.json({ error: message }, { status: mapped });
      }
      // Best-effort only: the overlay below still holds the write.
    }
  }

  overlay.set(requestId, {
    ...prev,
    status: "paid",
    reason: null,
    objection: null,
  });
  return NextResponse.json({ status: "paid" }, { status: 200 });
}

export async function handleQueueReject(
  rawId: unknown,
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<NextResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const requestId = parseQueueId(rawId);
  if (requestId === null) {
    return NextResponse.json(
      { error: "request_id must be a positive integer" },
      { status: 400 },
    );
  }
  const merged = await getMergedAll({ fetchImpl, env });
  const prev = merged.get(requestId);
  if (!prev || prev.status !== "held") {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  const adapter = liveQueueAdapter(env, fetchImpl);
  if (adapter !== null) {
    try {
      await adapter.rejectHold(requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const mapped = contractErrorToStatus(message);
      if (mapped !== null) {
        return NextResponse.json({ error: message }, { status: mapped });
      }
      // Best-effort only: the overlay below still holds the write.
    }
  }

  overlay.set(requestId, {
    ...prev,
    status: "rejected",
    reason: REASON_HOLD_REJECTED,
  });
  return NextResponse.json({ status: "rejected" }, { status: 200 });
}
