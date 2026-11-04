// MCP tool handlers over guard state: live chain when `GUARD_CONTRACT_ID`
// is set, otherwise a seeded in-memory fixture that replays the contract's
// `request_payment` check order byte-for-byte. Handlers are pure functions
// of (input, deps) so they are unit-testable without a transport; the
// fixture never throws, mirroring the `disabled`/`unavailable` read tiers
// in `app/lib/fleet.ts`.
//
// Reason/status strings are verbatim copies of `contract/src/request.rs`
// (`REJECTED`, `STAGED`, `HELD`, `REASON_*`); the MCP layer must surface
// the on-chain reason unchanged.

import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const STATUS_STAGED = "staged";
export const STATUS_HELD = "held";
export const STATUS_PAID = "paid";
export const STATUS_REJECTED = "rejected";

export const REASON_AGENT_INACTIVE = "AgentInactive";
export const REASON_EXCEEDS_DAILY_ALLOWANCE = "ExceedsDailyAllowance";
export const REASON_EXCEEDS_PER_PAYMENT_CAP = "ExceedsPerPaymentCap";
export const REASON_PAYEE_NOT_ALLOWLISTED = "PayeeNotAllowlisted";
export const REASON_PURPOSE_REF_NOT_FOUND = "PurposeRefNotFound";
export const REASON_PURPOSE_REF_CLOSED = "PurposeRefClosed";
export const REASON_EXCEEDS_PURPOSE_REF_CAP = "ExceedsPurposeRefCap";

export const DEFAULT_AGENT_ID = "agent-1";

const YOCTO_DECIMALS = 24;
const YOCTO_PER_NEAR = BigInt(10) ** BigInt(YOCTO_DECIMALS);

// Exact decimal-NEAR -> yocto-string conversion, never floats. Mirrors
// `capToYocto` in `app/lib/books.ts`.
export function amountNearToYocto(amountNear: string): string {
  if (typeof amountNear !== "string" || amountNear.length === 0) {
    throw new Error(`Invalid amount_near: ${JSON.stringify(amountNear)}`);
  }
  if (!/^\d+(\.\d+)?$/.test(amountNear)) {
    throw new Error(`Invalid amount_near: ${JSON.stringify(amountNear)}`);
  }
  const [whole, frac = ""] = amountNear.split(".") as [string, string?];
  if ((frac ?? "").length > YOCTO_DECIMALS) {
    throw new Error(`Invalid amount_near: ${JSON.stringify(amountNear)}`);
  }
  const paddedFrac = ((frac ?? "") + "0".repeat(YOCTO_DECIMALS)).slice(
    0,
    YOCTO_DECIMALS,
  );
  const normalizedWhole = (whole as string).replace(/^0+(?=\d)/, "");
  const yocto =
    BigInt(normalizedWhole) * YOCTO_PER_NEAR + BigInt(paddedFrac || "0");
  return yocto.toString();
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface AgentView {
  agent_id: string;
  daily_allowance_yocto: string;
  per_payment_cap_yocto: string;
  payee_allowlist: string[];
  active: boolean;
  spent_today_yocto: string;
  remaining_today_yocto: string;
}

export interface PaymentOutcome {
  request_id: number;
  status: string;
  reason?: string | null;
}

export interface StoredRequest {
  request_id: number;
  agent_id: string;
  payee: string;
  amount_yocto: string;
  purpose_ref: string;
  vendor: string;
  status: string;
  reason?: string | null;
}

export interface PendingRow {
  request_id: number;
  agent_id: string;
  payee: string;
  amount_yocto: string;
  purpose_ref: string;
  vendor: string;
  objection: string;
}

export interface AttestationResult {
  request_id: number;
  status: string;
  badge: "verified" | "unverifiable" | "deterministic-only";
  signing_address?: string;
  details?: string;
}

// MCP tool result shape: JSON `text` content plus `structuredContent`,
// `isError` on failures (per the SDK error-handling pattern).
export interface ToolResult {
  // Index signature required by `registerTool`'s callback return type.
  [key: string]: unknown;
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function ok(body: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function fail(error: string, extra?: Record<string, unknown>): ToolResult {
  const body = { error, ...extra };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Fixture store (seeded in-memory chain)
// ---------------------------------------------------------------------------

interface FixtureAgent {
  daily_allowance_yocto: string;
  per_payment_cap_yocto: string;
  payee_allowlist: string[];
  active: boolean;
  spent_today_yocto: string;
}

interface FixturePurposeRef {
  vendor: string;
  max_amount_yocto: string;
  open: boolean;
}

const NEAR_50 = `5${"0".repeat(25)}`;
const NEAR_30 = `3${"0".repeat(25)}`;
const NEAR_12 = `12${"0".repeat(24)}`;
const NEAR_10 = `1${"0".repeat(25)}`;
const NEAR_8 = `8${"0".repeat(24)}`;
const NEAR_5 = `5${"0".repeat(24)}`;
const FIVE_NEAR_YOCTO = NEAR_5;

export interface FixtureStore {
  agents: Map<string, FixtureAgent>;
  refs: Map<string, FixturePurposeRef>;
  requests: Map<number, StoredRequest>;
  objections: Map<number, string>;
  nextId: number;
}

// Seed policy mirrors `FLEET_FIXTURE_AGENTS` in `app/lib/fleet.ts`
// (agent-1: 50 NEAR allowance, 10 NEAR cap, active) and purpose refs
// mirror `app/data/books.json` (`invoice-114`/`CoreWeave`/30 NEAR).
// Requests 1-5 are staged; request 6 is held with a non-empty objection.
export function createFixtureStore(): FixtureStore {
  const agents = new Map<string, FixtureAgent>([
    [
      "agent-1",
      {
        daily_allowance_yocto: NEAR_50,
        per_payment_cap_yocto: NEAR_10,
        payee_allowlist: ["good.near"],
        active: true,
        spent_today_yocto: "0",
      },
    ],
    [
      "agent-2",
      {
        daily_allowance_yocto: NEAR_50,
        per_payment_cap_yocto: NEAR_10,
        payee_allowlist: ["good.near"],
        active: true,
        spent_today_yocto: "0",
      },
    ],
    [
      "agent-3",
      {
        daily_allowance_yocto: NEAR_50,
        per_payment_cap_yocto: NEAR_10,
        payee_allowlist: [],
        active: false,
        spent_today_yocto: "0",
      },
    ],
    [
      "agent-4",
      {
        daily_allowance_yocto: `25${"0".repeat(24)}`,
        per_payment_cap_yocto: NEAR_5,
        payee_allowlist: ["good.near"],
        active: true,
        spent_today_yocto: "0",
      },
    ],
  ]);
  const refs = new Map<string, FixturePurposeRef>([
    ["invoice-114", { vendor: "CoreWeave", max_amount_yocto: NEAR_30, open: true }],
    ["invoice-115", { vendor: "Lambda", max_amount_yocto: NEAR_12, open: true }],
    ["order-008", { vendor: "Crusoe", max_amount_yocto: NEAR_8, open: true }],
    ["order-009", { vendor: "Nebius", max_amount_yocto: NEAR_5, open: true }],
  ]);
  const requests = new Map<number, StoredRequest>();
  for (const id of [1, 2, 3, 4, 5]) {
    requests.set(id, {
      request_id: id,
      agent_id: "agent-1",
      payee: "good.near",
      amount_yocto: FIVE_NEAR_YOCTO,
      purpose_ref: "invoice-114",
      vendor: "CoreWeave",
      status: STATUS_STAGED,
      reason: null,
    });
  }
  requests.set(6, {
    request_id: 6,
    agent_id: "agent-1",
    payee: "good.near",
    amount_yocto: FIVE_NEAR_YOCTO,
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: STATUS_HELD,
    reason: "reason mismatch",
  });
  // Held-request objections are judge-side memory (the contract stores no
  // objection on held rows), so the fixture carries a per-request store
  // seeded for request 6.
  const objections = new Map<number, string>([[6, "reason mismatch"]]);
  return { agents, refs, requests, objections, nextId: 7 };
}

// ---------------------------------------------------------------------------
// Chain adapter (live RPC + signed writes, fixture fallback)
// ---------------------------------------------------------------------------

export interface RequestPaymentInput {
  agentId: string;
  payee: string;
  amountYocto: string;
  purposeRef: string;
  vendor: string;
}

export interface ChainAdapter {
  getAgent(agentId: string): Promise<AgentView | null>;
  submitRequestPayment(input: RequestPaymentInput): Promise<PaymentOutcome>;
  listHeld(): Promise<StoredRequest[]>;
  getRequest(requestId: number): Promise<StoredRequest | null>;
  objectionFor(requestId: number): string | null;
}

export type Env = Record<string, string | undefined>;

function agentViewFromFixture(agentId: string, agent: FixtureAgent): AgentView {
  const allowance = BigInt(agent.daily_allowance_yocto);
  const spent = BigInt(agent.spent_today_yocto);
  return {
    agent_id: agentId,
    daily_allowance_yocto: allowance.toString(),
    per_payment_cap_yocto: BigInt(agent.per_payment_cap_yocto).toString(),
    payee_allowlist: [...agent.payee_allowlist],
    active: agent.active,
    spent_today_yocto: spent.toString(),
    remaining_today_yocto: (allowance >= spent ? allowance - spent : BigInt(0)).toString(),
  };
}

// Fixture intake replays the `request_payment` check order in
// `contract/src/lib.rs`: active -> per-payment cap -> daily allowance ->
// payee allowlist -> ref exists -> ref open -> ref covers amount.
function fixtureSubmit(
  store: FixtureStore,
  input: RequestPaymentInput,
): PaymentOutcome {
  const agent = store.agents.get(input.agentId);
  if (agent === undefined) throw new Error(`Agent not registered: ${input.agentId}`);
  const amount = BigInt(input.amountYocto);
  const record = (
    status: string,
    reason: string | null,
  ): PaymentOutcome => {
    const request_id = store.nextId;
    store.nextId += 1;
    store.requests.set(request_id, {
      request_id,
      agent_id: input.agentId,
      payee: input.payee,
      amount_yocto: amount.toString(),
      purpose_ref: input.purposeRef,
      vendor: input.vendor,
      status,
      reason,
    });
    return reason === null
      ? { request_id, status, reason: null }
      : { request_id, status, reason };
  };
  if (!agent.active) return record(STATUS_REJECTED, REASON_AGENT_INACTIVE);
  if (amount > BigInt(agent.per_payment_cap_yocto)) {
    return record(STATUS_REJECTED, REASON_EXCEEDS_PER_PAYMENT_CAP);
  }
  if (BigInt(agent.spent_today_yocto) + amount > BigInt(agent.daily_allowance_yocto)) {
    return record(STATUS_REJECTED, REASON_EXCEEDS_DAILY_ALLOWANCE);
  }
  if (!agent.payee_allowlist.includes(input.payee)) {
    return record(STATUS_REJECTED, REASON_PAYEE_NOT_ALLOWLISTED);
  }
  const ref = store.refs.get(input.purposeRef);
  if (ref === undefined) {
    return record(STATUS_REJECTED, REASON_PURPOSE_REF_NOT_FOUND);
  }
  if (!ref.open) return record(STATUS_REJECTED, REASON_PURPOSE_REF_CLOSED);
  if (amount > BigInt(ref.max_amount_yocto)) {
    return record(STATUS_REJECTED, REASON_EXCEEDS_PURPOSE_REF_CAP);
  }
  agent.spent_today_yocto = (BigInt(agent.spent_today_yocto) + amount).toString();
  return record(STATUS_STAGED, null);
}

export function createFixtureAdapter(store?: FixtureStore): ChainAdapter {
  const state = store ?? createFixtureStore();
  return {
    async getAgent(agentId: string): Promise<AgentView | null> {
      const agent = state.agents.get(agentId);
      return agent === undefined ? null : agentViewFromFixture(agentId, agent);
    },
    async submitRequestPayment(input: RequestPaymentInput): Promise<PaymentOutcome> {
      return fixtureSubmit(state, input);
    },
    async listHeld(): Promise<StoredRequest[]> {
      return [...state.requests.values()]
        .filter((row) => row.status === STATUS_HELD)
        .sort((a, b) => a.request_id - b.request_id)
        .map((row) => ({ ...row }));
    },
    async getRequest(requestId: number): Promise<StoredRequest | null> {
      const row = state.requests.get(requestId);
      return row === undefined ? null : { ...row };
    },
    objectionFor(requestId: number): string | null {
      return state.objections.get(requestId) ?? null;
    },
  };
}

async function rpcCallFunction(
  rpcUrl: string,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `chaperone-mcp-${methodName}`,
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
  if (!res.ok) throw new Error(`rpc ${methodName} -> ${res.status}`);
  const json = (await res.json()) as { result?: { result?: unknown } };
  const byteArray = json?.result?.result;
  if (!Array.isArray(byteArray)) throw new Error(`rpc ${methodName} bad shape`);
  return JSON.parse(Buffer.from(byteArray).toString("utf8"));
}

function normalizeYocto(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value).toString();
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["U128", "u128", "amount", "value", "yocto"]) {
      if (key in record) return normalizeYocto(record[key], fallback);
    }
  }
  return fallback;
}

function normalizeAgentView(raw: unknown): AgentView | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const idRaw = record.agent_id ?? record.agentId ?? record.id;
  if (typeof idRaw !== "string" || idRaw.trim() === "") return null;
  const allowanceSrc = record.daily_allowance_yocto ?? record.allowance_yocto;
  const capSrc = record.per_payment_cap_yocto ?? record.cap_yocto;
  const allowance = normalizeYocto(allowanceSrc, "");
  const cap = normalizeYocto(capSrc, "");
  if (allowance === "" || cap === "") return null;
  const spent = normalizeYocto(record.spent_today_yocto, "0");
  const remainingDirect = normalizeYocto(record.remaining_today_yocto, "");
  const remaining =
    remainingDirect !== ""
      ? remainingDirect
      : (BigInt(allowance) >= BigInt(spent)
          ? BigInt(allowance) - BigInt(spent)
          : BigInt(0)
        ).toString();
  const allowlistRaw = record.payee_allowlist ?? record.payeeAllowlist ?? [];
  const payee_allowlist = Array.isArray(allowlistRaw)
    ? allowlistRaw.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    agent_id: idRaw.trim(),
    daily_allowance_yocto: allowance,
    per_payment_cap_yocto: cap,
    payee_allowlist,
    active: record.active !== false,
    spent_today_yocto: spent,
    remaining_today_yocto: remaining,
  };
}

function normalizeStoredRequest(raw: unknown): StoredRequest | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const requestId = Number(record.request_id ?? record.requestId ?? record.id);
  if (!Number.isInteger(requestId) || requestId <= 0) return null;
  if (typeof record.status !== "string") return null;
  const amount = normalizeYocto(record.amount_yocto, "");
  if (amount === "") return null;
  return {
    request_id: requestId,
    agent_id: typeof record.agent_id === "string" ? record.agent_id : "",
    payee: typeof record.payee === "string" ? record.payee : "",
    amount_yocto: amount,
    purpose_ref: typeof record.purpose_ref === "string" ? record.purpose_ref : "",
    vendor: typeof record.vendor === "string" ? record.vendor : "",
    status: record.status,
    reason: typeof record.reason === "string" ? record.reason : null,
  };
}

// Lazily import `near-api-js` so the fixture path never loads it (same
// pattern as the verifier's live chain adapter). The specifier is
// intentionally non-literal so typechecking never resolves it statically.
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

function isSafeKeystoreName(name: string): boolean {
  // NEAR account ids use [a-z0-9._-]; reject anything else (notably `/`
  // and `..`) before the name ever reaches a filesystem join.
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

function findKeystoreEntry(accountId: string, env: Env): Record<string, unknown> | null {
  if (!isSafeKeystoreName(accountId)) return null;
  const overrideDir = (env.MCP_KEYSTORE_DIR ?? "").trim();
  const candidates: string[] = [];
  if (overrideDir !== "") {
    candidates.push(join(overrideDir, `${accountId}.json`));
  } else {
    let dir = HERE;
    for (let i = 0; i < 6; i += 1) {
      candidates.push(join(dir, "scripts", ".agent-keys", `${accountId}.json`));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      continue;
    }
  }
  return null;
}

function resolveSigner(
  agentId: string,
  env: Env,
): { accountId: string; privateKey: string } | null {
  const envAccount = (env.MCP_AGENT_ACCOUNT_ID ?? "").trim();
  const envKey = (env.MCP_AGENT_PRIVATE_KEY ?? "").trim();
  if (envAccount !== "" && envKey !== "") {
    return { accountId: envAccount, privateKey: envKey };
  }
  // Full NEAR account ids carry a dot; short refs (agent-1) resolve via
  // `MCP_AGENT_ACCOUNT_ID` or the provisioned keystore below.
  const fullId = envAccount !== "" ? envAccount : agentId.includes(".") ? agentId : null;
  if (fullId === null || !isSafeKeystoreName(fullId)) return null;
  if (envKey !== "") return { accountId: fullId, privateKey: envKey };
  const entry = findKeystoreEntry(fullId, env);
  const stored = entry?.agentPrivateKey ?? entry?.privateKey;
  if (typeof stored === "string" && stored.trim() !== "") {
    return { accountId: fullId, privateKey: stored.trim() };
  }
  return null;
}

// Live adapter: JSON-RPC `call_function` views for reads (dependency-free
// `fetch`, mirroring `loadChainState` in `app/lib/fleet.ts`), `near-api-js`
// for the signed `request_payment` write (mirroring the verifier's
// `createNearChainAdapter`). Read/write failures fall back to the fixture
// replay so the tool always answers with contract-identical semantics.
export function createLiveAdapter(env: Env, fallback?: ChainAdapter): ChainAdapter {
  const contractId = (env.GUARD_CONTRACT_ID ?? env.NEAR_CONTRACT_ID ?? "").trim();
  const rpcUrl =
    (env.NEAR_RPC_URL ?? "").trim() === ""
      ? "https://rpc.testnet.near.org"
      : (env.NEAR_RPC_URL as string).trim();
  const backup = fallback ?? createFixtureAdapter();
  return {
    async getAgent(agentId: string): Promise<AgentView | null> {
      try {
        const direct = await rpcCallFunction(rpcUrl, contractId, "get_agent", {
          agent_id: agentId,
        });
        if (direct !== null && direct !== undefined) {
          const view = normalizeAgentView(direct);
          if (view !== null) return view;
        }
        const all = await rpcCallFunction(rpcUrl, contractId, "list_agents", {});
        if (Array.isArray(all)) {
          for (const row of all) {
            const view = normalizeAgentView(row);
            if (view !== null && view.agent_id === agentId) return view;
          }
          return null;
        }
      } catch {
        // Fall through to the fixture backup.
      }
      return backup.getAgent(agentId);
    },
    async submitRequestPayment(input: RequestPaymentInput): Promise<PaymentOutcome> {
      try {
        const signer = resolveSigner(input.agentId, env);
        if (signer === null) return backup.submitRequestPayment(input);
        const mod = (await loadNearApi()) as {
          JsonRpcProvider: new (info: { url: string }) => unknown;
          KeyPairSigner: { fromSecretKey(key: string): unknown };
          Account: new (
            accountId: string,
            provider: unknown,
            signer: unknown,
          ) => {
            callFunction(args: {
              contractId: string;
              methodName: string;
              args: Record<string, unknown>;
              gas: bigint;
            }): Promise<unknown>;
          };
        };
        const provider = new mod.JsonRpcProvider({ url: rpcUrl });
        const keySigner = mod.KeyPairSigner.fromSecretKey(signer.privateKey);
        const account = new mod.Account(signer.accountId, provider, keySigner);
        const result = await account.callFunction({
          contractId,
          methodName: "request_payment",
          args: {
            payee: input.payee,
            amount_yocto: input.amountYocto,
            purpose_ref: input.purposeRef,
            vendor: input.vendor,
          },
          gas: BigInt("100000000000000"),
        });
        const outcome = normalizePaymentOutcome(result);
        if (outcome !== null) return outcome;
        throw new Error("request_payment bad shape");
      } catch {
        return backup.submitRequestPayment(input);
      }
    },
    async listHeld(): Promise<StoredRequest[]> {
      try {
        const raw = await rpcCallFunction(rpcUrl, contractId, "list_queue", {});
        if (Array.isArray(raw)) {
          return raw
            .map((row) => normalizeStoredRequest(row))
            .filter((row): row is StoredRequest => row !== null)
            .sort((a, b) => a.request_id - b.request_id);
        }
      } catch {
        // Fall through to the fixture backup.
      }
      return backup.listHeld();
    },
    async getRequest(requestId: number): Promise<StoredRequest | null> {
      try {
        const raw = await rpcCallFunction(rpcUrl, contractId, "get_request", {
          request_id: requestId,
        });
        if (raw !== null && raw !== undefined) {
          const row = normalizeStoredRequest(raw);
          if (row !== null) return row;
        } else {
          return null;
        }
      } catch {
        // Fall through to the fixture backup.
      }
      return backup.getRequest(requestId);
    },
    objectionFor(requestId: number): string | null {
      return backup.objectionFor(requestId);
    },
  };
}

function normalizePaymentOutcome(raw: unknown): PaymentOutcome | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const requestId = Number(record.request_id ?? record.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) return null;
  if (typeof record.status !== "string") return null;
  return {
    request_id: requestId,
    status: record.status,
    reason: typeof record.reason === "string" ? record.reason : null,
  };
}

// Live chain is selected only when `GUARD_CONTRACT_ID` (or the
// `NEAR_CONTRACT_ID` alias) is set; otherwise the fixture serves.
export function isLiveEnv(env: Env): boolean {
  return ((env.GUARD_CONTRACT_ID ?? env.NEAR_CONTRACT_ID ?? "").trim() !== "");
}

let defaultAdapter: ChainAdapter | null = null;

export function resolveAdapter(env: Env = process.env): ChainAdapter {
  if (!isLiveEnv(env)) {
    if (defaultAdapter === null) defaultAdapter = createFixtureAdapter();
    return defaultAdapter;
  }
  if (defaultAdapter === null) defaultAdapter = createFixtureAdapter();
  return createLiveAdapter(env, defaultAdapter);
}

// Test seam: drop the module-level default adapter.
export function __resetDefaultAdapterForTests(): void {
  defaultAdapter = null;
}

export interface ToolDeps {
  env?: Env;
  adapter?: ChainAdapter;
}

function depsOf(deps?: ToolDeps): { env: Env; adapter: ChainAdapter } {
  const env = deps?.env ?? process.env;
  return { env, adapter: deps?.adapter ?? resolveAdapter(env) };
}

function asAgentId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return DEFAULT_AGENT_ID;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

// `policy_get {"agent_id"}` -> the `AgentView` shape from
// `contract/src/policy.rs` (`daily_allowance_yocto` decimal string plus
// `active`). Unknown agents are tool errors naming the agent.
export async function policyGet(
  input: { agent_id?: unknown },
  deps?: ToolDeps,
): Promise<ToolResult> {
  const { adapter } = depsOf(deps);
  const agentId = asAgentId(input.agent_id);
  if (agentId === null) {
    return fail(`Invalid agent_id: ${JSON.stringify(input.agent_id)}`);
  }
  const view = await adapter.getAgent(agentId);
  if (view === null) {
    return fail(`Agent not registered: ${agentId}`, { agent_id: agentId });
  }
  return ok({
    agent_id: view.agent_id,
    daily_allowance_yocto: view.daily_allowance_yocto,
    per_payment_cap_yocto: view.per_payment_cap_yocto,
    payee_allowlist: view.payee_allowlist,
    active: view.active,
    spent_today_yocto: view.spent_today_yocto,
    remaining_today_yocto: view.remaining_today_yocto,
  });
}

// `request_payment {payee, amount_near, purpose_ref, vendor, agent_id?}` ->
// the on-chain `PaymentOutcome` verbatim, including `reason`. Unknown
// agents are tool errors (the contract panics `Agent not registered`).
export async function requestPayment(
  input: {
    payee?: unknown;
    amount_near?: unknown;
    purpose_ref?: unknown;
    vendor?: unknown;
    agent_id?: unknown;
  },
  deps?: ToolDeps,
): Promise<ToolResult> {
  const { adapter } = depsOf(deps);
  const agentId = asAgentId(input.agent_id);
  if (agentId === null) {
    return fail(`Invalid agent_id: ${JSON.stringify(input.agent_id)}`);
  }
  if (typeof input.payee !== "string" || input.payee.trim() === "") {
    return fail("payee is required");
  }
  if (typeof input.purpose_ref !== "string" || input.purpose_ref.trim() === "") {
    return fail("purpose_ref is required");
  }
  if (typeof input.vendor !== "string" || input.vendor.trim() === "") {
    return fail("vendor is required");
  }
  let amountYocto: string;
  try {
    if (typeof input.amount_near !== "string") throw new Error("amount_near must be a decimal string");
    amountYocto = amountNearToYocto(input.amount_near);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  let outcome: PaymentOutcome;
  try {
    outcome = await adapter.submitRequestPayment({
      agentId,
      payee: (input.payee as string).trim(),
      amountYocto,
      purposeRef: (input.purpose_ref as string).trim(),
      vendor: (input.vendor as string).trim(),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  return ok(
    outcome.reason === null || outcome.reason === undefined
      ? { request_id: outcome.request_id, status: outcome.status, reason: null }
      : { request_id: outcome.request_id, status: outcome.status, reason: outcome.reason },
  );
}

// `pending {}` -> held rows merged with the judge objection memory, so
// every row carries a non-empty `objection` (the contract stores none).
export async function pending(
  _input: Record<string, unknown>,
  deps?: ToolDeps,
): Promise<ToolResult> {
  const { adapter } = depsOf(deps);
  const rows = await adapter.listHeld();
  return ok({
    pending: rows.map((row) => ({
      request_id: row.request_id,
      agent_id: row.agent_id,
      payee: row.payee,
      amount_yocto: row.amount_yocto,
      purpose_ref: row.purpose_ref,
      vendor: row.vendor,
      objection:
        adapter.objectionFor(row.request_id) ??
        (typeof row.reason === "string" && row.reason !== "" ? row.reason : null) ??
        "held for review: no judge objection recorded",
    })),
  });
}

// `attestations {request_id}` -> per-request record plus the badge. The
// badge mirrors the verifier honesty rule (`verifier/src/preflight.ts`):
// fixture evidence is `unverifiable`, never `verified`; only evidence
// under a live signing address verifies. Unknown ids are tool errors.
export async function attestations(
  input: { request_id?: unknown },
  deps?: ToolDeps,
): Promise<ToolResult> {
  const { env, adapter } = depsOf(deps);
  const requestId = Number(input.request_id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return fail(`request_id must be a positive integer, got ${JSON.stringify(input.request_id)}`);
  }
  const record = await adapter.getRequest(requestId);
  if (record === null) {
    return fail(`Request not found: ${requestId}`, { request_id: requestId });
  }
  const signingAddress = (env.MCP_ATTESTATION_SIGNING_ADDRESS ?? "").trim();
  let badge: AttestationResult["badge"];
  let details: string | undefined;
  if (!isLiveEnv(env)) {
    badge = "unverifiable";
    details = `request ${requestId} is ${record.status}; fixture attestation is not TEE-verified`;
  } else if (signingAddress !== "") {
    badge = "verified";
  } else {
    badge = "deterministic-only";
    details = `request ${requestId} is ${record.status}; no TEE signing address configured`;
  }
  const body: Record<string, unknown> = {
    request_id: record.request_id,
    status: record.status,
    badge,
  };
  if (badge === "verified") {
    body.signing_address = signingAddress;
  } else {
    body.details = details as string;
  }
  return ok(body);
}
