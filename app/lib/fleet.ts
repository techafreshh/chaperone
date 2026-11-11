import { NextResponse } from "next/server";
import fs from "node:fs";
import { isLiveTier, liveWriteBlocked } from "./guard";
import { getMirrorStatus } from "./supabase";
import { capToYocto } from "./books";
import type { Env } from "./env";

// Fleet dashboard data layer (issue #13). Merges three read tiers —
// Supabase mirror `agents` table first, live chain views (`list_agents`,
// `treasury`/`fleet_summary` via plain JSON-RPC `fetch`) second, fixture
// fallback third — with the chain's `active` flag authoritative for the
// `frozen` label. Writes go to a fixture-tier in-process overlay (plus
// best-effort mirror upsert) so the next `GET /fleet` in the same server
// process reflects `POST /api/agents`; on the live tier the server sends
// nothing and owner writes are wallet-signed in the browser (issue #62).
//
// Yocto amounts stay decimal strings end-to-end (Postgres TEXT, u128);
// display formatting uses exact `BigInt` math, never floats. Direct
// transfers bypassing `deposit_fleet_funds` do not credit the logical
// treasury, mirroring the contract caveat in `contract/src/lib.rs`.

export interface FleetAgent {
  agent_id: string;
  allowance_yocto: string;
  cap_yocto: string;
  spent_today_yocto: string;
  remaining_today_yocto: string;
  active: boolean;
}

export interface FleetState {
  agents: FleetAgent[];
  treasuryYocto: string;
  source: "fixture" | "stub" | "mirror" | "chain" | "overlay";
}

const YOCTO_PER_NEAR = BigInt(10) ** BigInt(24);

const YOCTO_50_NEAR = "50000000000000000000000000";
const YOCTO_45_NEAR = "45000000000000000000000000";
const YOCTO_40_NEAR = "40000000000000000000000000";
const YOCTO_25_NEAR = "25000000000000000000000000";
const YOCTO_10_NEAR = "10000000000000000000000000";
const YOCTO_5_NEAR = "5000000000000000000000000";

export const DEFAULT_ALLOWANCE_YOCTO = YOCTO_50_NEAR;
export const DEFAULT_CAP_YOCTO = YOCTO_10_NEAR;

export const FLEET_FIXTURE_AGENTS: FleetAgent[] = [
  {
    agent_id: "agent-1",
    allowance_yocto: YOCTO_50_NEAR,
    cap_yocto: YOCTO_10_NEAR,
    spent_today_yocto: "0",
    remaining_today_yocto: YOCTO_50_NEAR,
    active: true,
  },
  {
    agent_id: "agent-2",
    allowance_yocto: YOCTO_50_NEAR,
    cap_yocto: YOCTO_10_NEAR,
    spent_today_yocto: YOCTO_10_NEAR,
    remaining_today_yocto: YOCTO_40_NEAR,
    active: true,
  },
  {
    agent_id: "agent-3",
    allowance_yocto: YOCTO_50_NEAR,
    cap_yocto: YOCTO_10_NEAR,
    spent_today_yocto: YOCTO_5_NEAR,
    remaining_today_yocto: YOCTO_45_NEAR,
    active: false,
  },
  {
    agent_id: "agent-4",
    allowance_yocto: YOCTO_25_NEAR,
    cap_yocto: YOCTO_5_NEAR,
    spent_today_yocto: "0",
    remaining_today_yocto: YOCTO_25_NEAR,
    active: true,
  },
];

export const FLEET_FIXTURE_TREASURY_YOCTO = "125000000000000000000000000";

// Exact yocto-string -> NEAR-decimal display ("20", "0.5"). Mirrors the
// strict decimal-string discipline of `capToYocto` in `./books`.
export function formatYoctoToNear(yocto: string): string {
  if (typeof yocto !== "string" || !/^\d+$/.test(yocto)) {
    throw new Error(`Invalid yocto amount: ${JSON.stringify(yocto)}`);
  }
  const value = BigInt(yocto);
  const whole = value / YOCTO_PER_NEAR;
  const frac = value % YOCTO_PER_NEAR;
  if (frac === BigInt(0)) return whole.toString();
  const fracStr = frac
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

function normalizeYocto(value: unknown, fallback: string): string {
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
      if (key in record) return normalizeYocto(record[key], fallback);
    }
  }
  return fallback;
}

function normalizeActive(value: unknown, fallback: boolean): boolean {
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

// `allowance - spent` saturating at zero, for rows that omit `remaining`.
function remainingOrComputed(
  allowanceYocto: string,
  spentYocto: string,
  remaining: unknown,
): string {
  if (remaining !== undefined) {
    const direct = normalizeYocto(remaining, "");
    if (direct !== "") return direct;
  }
  try {
    const allowance = BigInt(allowanceYocto);
    const spent = BigInt(spentYocto);
    return (allowance >= spent ? allowance - spent : BigInt(0)).toString();
  } catch {
    return "0";
  }
}

// Accepts both mirror-short (`allowance_yocto`) and chain-long
// (`daily_allowance_yocto`) keys; the `AgentView` field names in
// `contract/src/policy.rs` are the source of truth.
function normalizeAgentRecord(
  raw: Record<string, unknown>,
): FleetAgent | null {
  const idRaw = raw.agent_id ?? raw.agentId ?? raw.id;
  if (typeof idRaw !== "string" || idRaw.trim() === "") return null;
  const agent_id = idRaw.trim();
  const allowanceSrc = raw.allowance_yocto ?? raw.daily_allowance_yocto;
  const capSrc = raw.cap_yocto ?? raw.per_payment_cap_yocto;
  const allowance_yocto =
    allowanceSrc === undefined
      ? DEFAULT_ALLOWANCE_YOCTO
      : normalizeYocto(allowanceSrc, DEFAULT_ALLOWANCE_YOCTO);
  const cap_yocto =
    capSrc === undefined
      ? DEFAULT_CAP_YOCTO
      : normalizeYocto(capSrc, DEFAULT_CAP_YOCTO);
  const spent_today_yocto = normalizeYocto(raw.spent_today_yocto, "0");
  const remaining_today_yocto = remainingOrComputed(
    allowance_yocto,
    spent_today_yocto,
    raw.remaining_today_yocto,
  );
  const active = normalizeActive(raw.active, true);
  return {
    agent_id,
    allowance_yocto,
    cap_yocto,
    spent_today_yocto,
    remaining_today_yocto,
    active,
  };
}

export type MirrorAgentsResult =
  | { state: "disabled"; reason: string }
  | { state: "ready"; agents: FleetAgent[] }
  | { state: "unavailable"; reason: string };

// Mirror `agents` reader. Same PostgREST header shape (`apikey` + `Bearer`)
// and column names as the #12 migration; labeled `disabled` without creds,
// labeled `unavailable` on transport failure — never throws.
export async function loadMirrorAgents(
  fetchImpl: typeof fetch = fetch,
  env: Env = process.env,
): Promise<MirrorAgentsResult> {
  const status = getMirrorStatus(env);
  if (status.state === "disabled") {
    return { state: "disabled", reason: status.reason };
  }
  const serviceKey = env.SUPABASE_SERVICE_KEY as string;
  const endpoint = `${status.url}/rest/v1/agents?select=*&order=agent_id`;
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
      reason: `mirror agents failed: ${err instanceof Error ? err.message : String(err)}`,
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
      reason: `mirror agents failed: GET agents -> ${res.status} ${excerpt}`,
    };
  }
  let rows: unknown;
  try {
    rows = await res.json();
  } catch (err) {
    return {
      state: "unavailable",
      reason: `mirror agents failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(rows)) return { state: "ready", agents: [] };
  const agents = (rows as Record<string, unknown>[])
    .map((row) =>
      row !== null && typeof row === "object"
        ? normalizeAgentRecord(row as Record<string, unknown>)
        : null,
    )
    .filter((agent): agent is FleetAgent => agent !== null)
    .sort((a, b) => (a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0));
  return { state: "ready", agents };
}

export interface StubFileState {
  agents: FleetAgent[];
  treasuryYocto: string | null;
}

// File-injected tier for harnesses: `FLEET_STUB_FILE` points at JSON
// `{agents, treasury_yocto}`. Null when unset or unreadable (fall through
// to the next tier, never throw).
export function loadStubAgents(
  env: Env = process.env,
): StubFileState | null {
  const path = (env.FLEET_STUB_FILE ?? "").trim();
  if (path === "") return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as Record<string, unknown>)?.agents;
    if (!Array.isArray(list)) return null;
    const agents = (list as unknown[])
      .map((row) =>
        row !== null && typeof row === "object"
          ? normalizeAgentRecord(row as Record<string, unknown>)
          : null,
      )
      .filter((agent): agent is FleetAgent => agent !== null)
      .sort((a, b) =>
        a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0,
      );
    let treasuryYocto: string | null = null;
    if (!Array.isArray(parsed) && parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const treasurySrc =
        record.treasury_yocto ?? record.treasuryYocto ?? record.treasury;
      if (treasurySrc !== undefined) {
        const direct = normalizeYocto(treasurySrc, "");
        treasuryYocto =
          direct !== ""
            ? direct
            : normalizeYocto(
                (treasurySrc as Record<string, unknown>)?.treasury_yocto,
                "",
              ) || null;
      }
    }
    return { agents, treasuryYocto };
  } catch {
    return null;
  }
}

async function rpcCallFunction(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  contractId: string,
  methodName: string,
): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `chaperone-fleet-${methodName}`,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from("{}").toString("base64"),
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

export type ChainStateResult =
  | { state: "disabled"; reason: string }
  | { state: "unavailable"; reason: string }
  | { state: "ready"; agents: FleetAgent[]; treasuryYocto: string | null };

// Chain reader using only global `fetch` (no new dependency). Queries the
// `list_agents` and `treasury` views (`fleet_summary.treasury_yocto` as
// the treasury fallback) and normalizes both string and `{U128}` yocto
// shapes. Labeled `disabled` without a contract id, labeled `unavailable`
// on any failure — never throws, so the page still renders from
// mirror/fixture.
export async function loadChainState(
  fetchImpl: typeof fetch = fetch,
  env: Env = process.env,
): Promise<ChainStateResult> {
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

  let agents: FleetAgent[] | null = null;
  try {
    const raw = await rpcCallFunction(fetchImpl, rpcUrl, contractId, "list_agents");
    if (Array.isArray(raw)) {
      agents = (raw as unknown[])
        .map((row) =>
          row !== null && typeof row === "object"
            ? normalizeAgentRecord(row as Record<string, unknown>)
            : null,
        )
        .filter((agent): agent is FleetAgent => agent !== null)
        .sort((a, b) =>
          a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0,
        );
    }
  } catch {
    agents = null;
  }

  let treasuryYocto: string | null = null;
  try {
    const raw = await rpcCallFunction(fetchImpl, rpcUrl, contractId, "treasury");
    const direct = normalizeYocto(raw, "");
    if (direct !== "") {
      treasuryYocto = direct;
    } else {
      throw new Error("treasury bad shape");
    }
  } catch {
    try {
      const summary = (await rpcCallFunction(
        fetchImpl,
        rpcUrl,
        contractId,
        "fleet_summary",
      )) as Record<string, unknown>;
      const direct = normalizeYocto(summary?.treasury_yocto, "");
      treasuryYocto = direct !== "" ? direct : null;
    } catch {
      treasuryYocto = null;
    }
  }

  if (agents === null && treasuryYocto === null) {
    return { state: "unavailable", reason: "chain views unreachable" };
  }
  return { state: "ready", agents: agents ?? [], treasuryYocto };
}

// In-process write overlay: `POST /api/agents` upserts here so the next
// `GET /fleet` in the same server process shows the new agent.
const overlay = new Map<string, FleetAgent>();

// Test seam: drop the module-level overlay.
export function __resetFleetOverlayForTests(): void {
  overlay.clear();
}

// Merged fleet view: fixture, then stub file, then mirror rows, then chain
// rows, then the POST overlay. Union by `agent_id`; missing
// `remaining_today_yocto` fills as `allowance - spent` saturating at zero.
// Read tiers merge with frozen-wins (`active` is the AND across sources,
// chain authoritative); the overlay replaces wholesale as the operator's
// latest write intent. Treasury prefers chain, then stub, then fixture.
export async function getFleetState(
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<FleetState> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const merged = new Map<string, FleetAgent>();
  const placeRead = (agent: FleetAgent): void => {
    const prev = merged.get(agent.agent_id);
    if (!prev) {
      merged.set(agent.agent_id, { ...agent });
    } else {
      merged.set(agent.agent_id, { ...agent, active: prev.active && agent.active });
    }
  };

  for (const agent of FLEET_FIXTURE_AGENTS) placeRead({ ...agent });
  const stub = loadStubAgents(env);
  if (stub) {
    for (const agent of stub.agents) placeRead(agent);
  }
  let mirrorReady = false;
  try {
    const mirror = await loadMirrorAgents(fetchImpl, env);
    if (mirror.state === "ready") {
      mirrorReady = true;
      for (const agent of mirror.agents) placeRead(agent);
    }
  } catch {
    mirrorReady = false;
  }
  let chainReady = false;
  let chainTreasury: string | null = null;
  const chainAgents = new Map<string, FleetAgent>();
  try {
    const chain = await loadChainState(fetchImpl, env);
    if (chain.state === "ready") {
      chainReady = true;
      chainTreasury = chain.treasuryYocto;
      for (const agent of chain.agents) {
        chainAgents.set(agent.agent_id, { ...agent });
        placeRead(agent);
      }
    }
  } catch {
    chainReady = false;
  }
  // Chain is the source of truth when ready: every agent the chain
  // returns takes `active` (and the full row) from the chain view only,
  // so a stale mirror/stub/fixture/overlay `active:false` can never
  // freeze an agent the chain reports active.
  if (chainReady) {
    for (const [id, chainAgent] of chainAgents) {
      merged.set(id, { ...chainAgent });
    }
  }
  // The overlay is fixture-tier only: on the live tier the server sends
  // nothing and every owner write is wallet-signed in the browser.
  if (!isLiveTier(env)) {
    for (const agent of overlay.values()) {
      // When the chain tier is ready, an overlay row for a chain-owned
      // agent must not contradict the chain view.
      if (chainReady && chainAgents.has(agent.agent_id)) continue;
      merged.set(agent.agent_id, { ...agent });
    }
  }

  const agents = [...merged.values()].sort((a, b) =>
    a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0,
  );
  const treasuryYocto =
    chainTreasury ?? stub?.treasuryYocto ?? FLEET_FIXTURE_TREASURY_YOCTO;
  const source: FleetState["source"] = chainReady
    ? "chain"
    : mirrorReady
      ? "mirror"
      : stub !== null
        ? "stub"
        : overlay.size > 0
          ? "overlay"
          : "fixture";
  return { agents, treasuryYocto, source };
}

async function readBodyMap(request: Request): Promise<Record<string, string>> {
  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return {};
  }
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        out[key] =
          typeof value === "string"
            ? value
            : value === null || value === undefined
              ? ""
              : typeof value === "number" || typeof value === "boolean"
                ? String(value)
                : JSON.stringify(value);
      }
      return out;
    }
  } catch {
    // Not JSON: fall through to form parsing below.
  }
  try {
    const params = new URLSearchParams(raw);
    const out: Record<string, string> = {};
    let any = false;
    params.forEach((value, key) => {
      any = true;
      out[key] = value;
    });
    if (any) return out;
  } catch {
    // Ignore malformed bodies.
  }
  return {};
}

function pickField(
  body: Record<string, string>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (body[key] !== undefined) return body[key];
  }
  return undefined;
}

function nearToYoctoOrDefault(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  try {
    return BigInt(capToYocto(trimmed)).toString();
  } catch {
    return fallback;
  }
}

// Allowance/cap resolution: explicit `*_yocto` keys win as yocto strings,
// explicit `*_near` keys convert from NEAR decimals, generic keys treat
// dotted values as NEAR and plain digits as yocto. Defaults keep the
// fixture-tier blast radius (50 NEAR allowance / 10 NEAR cap).
function resolveAmount(
  body: Record<string, string>,
  yoctoKeys: string[],
  nearKeys: string[],
  genericKeys: string[],
  fallback: string,
): string {
  const yoctoSrc = pickField(body, ...yoctoKeys);
  if (yoctoSrc !== undefined) {
    return /^\d+$/.test(yoctoSrc.trim())
      ? BigInt(yoctoSrc.trim()).toString()
      : fallback;
  }
  const nearSrc = pickField(body, ...nearKeys);
  if (nearSrc !== undefined) {
    return nearToYoctoOrDefault(nearSrc, fallback);
  }
  const genericSrc = pickField(body, ...genericKeys);
  if (genericSrc !== undefined) {
    const trimmed = genericSrc.trim();
    if (trimmed === "") return fallback;
    if (trimmed.includes(".")) return nearToYoctoOrDefault(trimmed, fallback);
    return /^\d+$/.test(trimmed) ? BigInt(trimmed).toString() : fallback;
  }
  return fallback;
}

// Best-effort persistence. Mirror upserts fire when the mirror is
// configured; the live chain-submit path stays wallet-signed and out of
// band (this dependency-free layer cannot sign), so with only an RPC
// contract id configured there is nothing further to attempt. Either way
// failures never fail the 200 — the overlay already holds the write.
async function bestEffortPersist(
  agent: FleetAgent,
  fetchImpl: typeof fetch,
  env: Env,
): Promise<void> {
  try {
    const status = getMirrorStatus(env);
    if (status.state === "ready") {
      const serviceKey = env.SUPABASE_SERVICE_KEY as string;
      await fetchImpl(`${status.url}/rest/v1/agents`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          agent_id: agent.agent_id,
          allowance_yocto: agent.allowance_yocto,
          cap_yocto: agent.cap_yocto,
          active: agent.active,
          spent_today_yocto: agent.spent_today_yocto,
          remaining_today_yocto: agent.remaining_today_yocto,
        }),
      });
    }
  } catch {
    // Best-effort only: the overlay already holds the write.
  }
}

export async function handleAgentsGet(
  _request: Request,
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<NextResponse> {
  const state = await getFleetState(deps);
  return NextResponse.json(
    state.agents.map((agent) => ({
      agent_id: agent.agent_id,
      allowance_yocto: agent.allowance_yocto,
      cap_yocto: agent.cap_yocto,
      spent_today_yocto: agent.spent_today_yocto,
      remaining_today_yocto: agent.remaining_today_yocto,
      active: agent.active,
    })),
    { status: 200 },
  );
}

// Fixture-tier write: any caller is accepted as the owner (labeled
// fixture-write). On the live tier the server sends nothing: the operator
// signs `register_agent`/`set_agent_policy` with the owner wallet in the
// browser. 400 only on missing/empty `agent_id`.
export async function handleAgentsPost(
  request: Request,
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<NextResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  if (isLiveTier(env)) return liveWriteBlocked();
  const body = await readBodyMap(request);
  const rawId = pickField(body, "agent_id", "agentId", "id");
  if (rawId === undefined || rawId.trim() === "") {
    return NextResponse.json(
      { ok: false, error: "agent_id is required" },
      { status: 400 },
    );
  }
  const agent_id = rawId.trim();
  const allowance_yocto = resolveAmount(
    body,
    ["allowance_yocto", "daily_allowance_yocto"],
    ["daily_allowance_near", "allowance_near"],
    ["allowance", "daily_allowance"],
    DEFAULT_ALLOWANCE_YOCTO,
  );
  const cap_yocto = resolveAmount(
    body,
    ["cap_yocto", "per_payment_cap_yocto"],
    ["per_payment_cap_near", "cap_near"],
    ["cap", "per_payment_cap"],
    DEFAULT_CAP_YOCTO,
  );
  const active = normalizeActive(
    pickField(body, "active", "is_active", "isActive"),
    true,
  );

  const current = await getFleetState({ fetchImpl, env });
  const prev = current.agents.find((agent) => agent.agent_id === agent_id);
  const spent_today_yocto = prev
    ? normalizeYocto(
        pickField(body, "spent_today_yocto") ?? prev.spent_today_yocto,
        prev.spent_today_yocto,
      )
    : normalizeYocto(pickField(body, "spent_today_yocto"), "0");
  const remaining_today_yocto =
    pickField(body, "remaining_today_yocto") !== undefined
      ? remainingOrComputed(
          allowance_yocto,
          spent_today_yocto,
          pickField(body, "remaining_today_yocto"),
        )
      : remainingOrComputed(allowance_yocto, spent_today_yocto, undefined);

  const agent: FleetAgent = {
    agent_id,
    allowance_yocto,
    cap_yocto,
    spent_today_yocto,
    remaining_today_yocto,
    active,
  };
  overlay.set(agent_id, agent);
  await bestEffortPersist(agent, fetchImpl, env);
  return NextResponse.json({ ok: true, agent_id }, { status: 200 });
}

// Policy edit for the per-card edit forms: applies only the fields the
// caller sent, keeps the rest from the merged view, and always answers 200
// (400 only on missing/empty `agent_id`).
export async function handleAgentsPatch(
  request: Request,
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<NextResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  if (isLiveTier(env)) return liveWriteBlocked();
  const body = await readBodyMap(request);
  const rawId = pickField(body, "agent_id", "agentId", "id");
  if (rawId === undefined || rawId.trim() === "") {
    return NextResponse.json(
      { ok: false, error: "agent_id is required" },
      { status: 400 },
    );
  }
  const agent_id = rawId.trim();
  const current = await getFleetState({ fetchImpl, env });
  const prev = current.agents.find((agent) => agent.agent_id === agent_id);
  const base: FleetAgent = prev ?? {
    agent_id,
    allowance_yocto: DEFAULT_ALLOWANCE_YOCTO,
    cap_yocto: DEFAULT_CAP_YOCTO,
    spent_today_yocto: "0",
    remaining_today_yocto: DEFAULT_ALLOWANCE_YOCTO,
    active: true,
  };

  const allowanceProvided =
    pickField(
      body,
      "allowance_yocto",
      "daily_allowance_yocto",
      "daily_allowance_near",
      "allowance_near",
      "allowance",
      "daily_allowance",
    ) !== undefined;
  const allowance_yocto = allowanceProvided
    ? resolveAmount(
        body,
        ["allowance_yocto", "daily_allowance_yocto"],
        ["daily_allowance_near", "allowance_near"],
        ["allowance", "daily_allowance"],
        base.allowance_yocto,
      )
    : base.allowance_yocto;
  const cap_yocto =
    pickField(
      body,
      "cap_yocto",
      "per_payment_cap_yocto",
      "per_payment_cap_near",
      "cap_near",
      "cap",
      "per_payment_cap",
    ) !== undefined
      ? resolveAmount(
          body,
          ["cap_yocto", "per_payment_cap_yocto"],
          ["per_payment_cap_near", "cap_near"],
          ["cap", "per_payment_cap"],
          base.cap_yocto,
        )
      : base.cap_yocto;
  const active = normalizeActive(
    pickField(body, "active", "is_active", "isActive"),
    base.active,
  );
  const spent_today_yocto = normalizeYocto(
    pickField(body, "spent_today_yocto") ?? base.spent_today_yocto,
    base.spent_today_yocto,
  );
  const remaining_today_yocto =
    pickField(body, "remaining_today_yocto") !== undefined || allowanceProvided
      ? remainingOrComputed(
          allowance_yocto,
          spent_today_yocto,
          pickField(body, "remaining_today_yocto"),
        )
      : base.remaining_today_yocto;

  const agent: FleetAgent = {
    agent_id,
    allowance_yocto,
    cap_yocto,
    spent_today_yocto,
    remaining_today_yocto,
    active,
  };
  overlay.set(agent_id, agent);
  await bestEffortPersist(agent, fetchImpl, env);
  return NextResponse.json({ ok: true, agent_id }, { status: 200 });
}

// Fixture-tier kill/revive write: flip `active` on the merged agent row
// and upsert the overlay so the next `GET /fleet` in the same server
// process reflects the freeze. The kill/revive routes answer the exact
// 403 on the live tier before reaching here. Unknown id -> null (the
// route maps to 404); allowance/cap/spent carry over with
// `remainingOrComputed`, and the existing best-effort persist never fails
// the 200.
export async function setAgentActive(
  agent_id: string,
  active: boolean,
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<FleetAgent | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const current = await getFleetState({ fetchImpl, env });
  const prev = current.agents.find((agent) => agent.agent_id === agent_id);
  if (!prev) return null;
  const agent: FleetAgent = {
    ...prev,
    remaining_today_yocto: remainingOrComputed(
      prev.allowance_yocto,
      prev.spent_today_yocto,
      prev.remaining_today_yocto,
    ),
    active,
  };
  overlay.set(agent_id, agent);
  await bestEffortPersist(agent, fetchImpl, env);
  return agent;
}
