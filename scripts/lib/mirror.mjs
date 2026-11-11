// Supabase mirror sync core (issue #12): on-chain views -> PostgREST rows.
// This module must stay import-free (Node.js builtins only) so the offline
// `node:test` suite runs without `npm install`. Only the thin
// `scripts/mirror-sync.mjs` CLI imports `near-api-js` for the live chain
// adapter; everything here takes injected dependencies (`fetchImpl`,
// in-memory or stub-file chains, capture stores) instead.
import { readFileSync } from "node:fs";

export const TESTNET_RPC_URL = "https://rpc.testnet.near.org";
export const DEFAULT_POLL_MS = 15000;
export const MIRROR_DISABLED_REASON =
  "SUPABASE_URL/SUPABASE_SERVICE_KEY not configured";

export function usage() {
  return [
    "Usage: node scripts/mirror-sync.mjs [options]",
    "",
    "Options:",
    "  --once            Run a single sync pass and exit (default polls every MIRROR_POLL_MS)",
    "  --stub <path>     Use a local JSON stub chain instead of NEAR RPC (or $MIRROR_STUB_FILE)",
    "  --contract <id>   Guard contract account id (or $NEAR_CONTRACT_ID)",
    "  --rpc-url <url>   NEAR RPC endpoint (default: https://rpc.testnet.near.org)",
    "  --help            Print this help and exit 0",
    "",
    "Env:",
    "  SUPABASE_URL / SUPABASE_SERVICE_KEY mirror target; when either is",
    "  unset the sync reports disabled and exits 0 without writing a row.",
  ].join("\n");
}

export function parseMirrorArgs(argv) {
  const out = {
    once: false,
    help: false,
    stub: null,
    contract: null,
    rpcUrl: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--once") {
      out.once = true;
    } else if (arg === "--stub" && i + 1 < argv.length) {
      out.stub = argv[(i += 1)];
    } else if (arg === "--contract" && i + 1 < argv.length) {
      out.contract = argv[(i += 1)];
    } else if (arg === "--rpc-url" && i + 1 < argv.length) {
      out.rpcUrl = argv[(i += 1)];
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return out;
}

// Resolve mirror configuration from the environment. Missing credentials
// are an explicit labeled `disabled` state, never silent: callers exit 0
// (CLI) or answer 503 (API) with the reason attached.
export function resolveMirrorConfig(env = {}, flags = {}) {
  const url = String(env.SUPABASE_URL ?? "").trim();
  const serviceKey = env.SUPABASE_SERVICE_KEY ?? "";
  if (url === "" || serviceKey === "") {
    return { disabled: true, reason: MIRROR_DISABLED_REASON };
  }
  return {
    disabled: false,
    url: url.replace(/\/+$/, ""),
    serviceKey,
    contractId:
      flags.contract ??
      env.MIRROR_CONTRACT_ID ??
      env.NEAR_CONTRACT_ID ??
      env.GUARD_CONTRACT_ID ??
      "",
    rpcUrl: flags.rpcUrl ?? env.NEAR_RPC_URL ?? TESTNET_RPC_URL,
  };
}

// Normalize an on-chain U128 JSON value to a decimal string. Contract views
// serialize U128 as a string, but accept numbers and single-value objects
// so stub files and future view shapes keep working.
export function u128ToString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value !== null && typeof value === "object") {
    for (const key of ["0", "value", "amount", "yocto", "balance"]) {
      const candidate = value[key];
      if (typeof candidate === "string" || typeof candidate === "number") {
        return String(candidate);
      }
    }
    const values = Object.values(value);
    if (
      values.length === 1 &&
      (typeof values[0] === "string" || typeof values[0] === "number")
    ) {
      return String(values[0]);
    }
  }
  throw new Error(`Invalid U128 value: ${JSON.stringify(value)}`);
}

// Map an on-chain AgentView to an `agents` row. The contract calls the
// columns `daily_allowance_yocto` / `per_payment_cap_yocto`; the mirror
// shortens them to `allowance_yocto` / `cap_yocto`.
export function mapAgentView(view) {
  return {
    agent_id: String(view.agent_id),
    allowance_yocto: u128ToString(view.daily_allowance_yocto),
    cap_yocto: u128ToString(view.per_payment_cap_yocto),
    active: Boolean(view.active),
    payee_allowlist: Array.isArray(view.payee_allowlist)
      ? view.payee_allowlist.map(String)
      : [],
    spent_today_yocto: u128ToString(view.spent_today_yocto ?? "0"),
    remaining_today_yocto: u128ToString(view.remaining_today_yocto ?? "0"),
  };
}

// Map an on-chain PaymentRequest view to a `requests` row, passing all
// eight contract fields through with `request_id` as a number.
export function mapPaymentRequest(record) {
  return {
    request_id: Number(record.request_id),
    agent_id: String(record.agent_id),
    payee: String(record.payee),
    amount_yocto: u128ToString(record.amount_yocto),
    purpose_ref: String(record.purpose_ref ?? ""),
    vendor: String(record.vendor ?? ""),
    status: String(record.status),
    reason: record.reason ?? null,
  };
}

// Derive the `verdicts` row for a decided request. `paid`, `paying`
// and `failed` all mirror as `consistent: true`: `paying` only follows
// a consistent verdict or an `approve_hold` release (the views do not
// expose which), and `failed` is a consistent verdict whose transfer
// bounced. Documented assumption: an `approve_hold` release (paid with
// no on-chain verdict) mirrors as `consistent: true` for the same reason.
export function deriveVerdict(record) {
  if (
    record.status === "paid" ||
    record.status === "paying" ||
    record.status === "failed"
  ) {
    return { request_id: Number(record.request_id), consistent: true };
  }
  if (record.status === "held") {
    return { request_id: Number(record.request_id), consistent: false };
  }
  return null;
}

// Derive the `audit_events` rows for a request, mirroring the contract's
// EVENT_JSON envelope names 1:1. Every row shares `subject:
// "request:<id>"` so the (event, subject) unique key makes re-syncs
// idempotent. Rejections are recorded on-chain (no `request_created`),
// staged requests emit creation only, and terminal verdict states emit
// creation + verdict + outcome.
export function deriveAudits(record) {
  const requestId = Number(record.request_id);
  const subject = `request:${requestId}`;
  const agentId = String(record.agent_id);
  const base = { request_id: requestId, agent_id: agentId };
  if (record.status === "rejected") {
    return [
      {
        event: "request_rejected",
        subject,
        ...base,
        data: { reason: record.reason ?? null },
      },
    ];
  }
  const created = {
    event: "request_created",
    subject,
    ...base,
    data: {
      payee: String(record.payee),
      amount_yocto: u128ToString(record.amount_yocto),
      purpose_ref: String(record.purpose_ref ?? ""),
      vendor: String(record.vendor ?? ""),
    },
  };
  if (record.status === "paid") {
    return [
      created,
      { event: "verdict_recorded", subject, ...base, data: { consistent: true } },
      { event: "request_paid", subject, ...base, data: {} },
    ];
  }
  // In-flight payout: the consistent verdict is on record, the transfer
  // outcome is not yet known, so no outcome event is mirrored.
  if (record.status === "paying") {
    return [
      created,
      { event: "verdict_recorded", subject, ...base, data: { consistent: true } },
    ];
  }
  // Bounced transfer: the consistent verdict stands, the outcome is the
  // contract's `request_failed` envelope 1:1.
  if (record.status === "failed") {
    return [
      created,
      { event: "verdict_recorded", subject, ...base, data: { consistent: true } },
      {
        event: "request_failed",
        subject,
        ...base,
        data: { reason: record.reason ?? null },
      },
    ];
  }
  if (record.status === "held") {
    return [
      created,
      { event: "verdict_recorded", subject, ...base, data: { consistent: false } },
      { event: "request_held", subject, ...base, data: {} },
    ];
  }
  return [created];
}

// Minimal PostgREST store over an injected `fetch`. Upserts use
// `Prefer: resolution=merge-duplicates` with `on_conflict` set to the
// table's unique key so re-syncs overwrite instead of duplicating.
export function createSupabaseStore({ url, serviceKey, fetchImpl }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("createSupabaseStore: a fetch implementation is required");
  }
  const base = String(url).replace(/\/+$/, "");
  async function readErrorBody(res) {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }
  return {
    async upsert(table, rows, onConflict) {
      if (!Array.isArray(rows) || rows.length === 0) return [];
      const endpoint = `${base}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(rows),
      });
      if (!res.ok) {
        const excerpt = String(await readErrorBody(res)).slice(0, 300);
        throw new Error(
          `Supabase upsert failed: POST ${table} -> ${res.status} ${excerpt}`,
        );
      }
      return rows;
    },
    async select(table, query = "") {
      const endpoint = `${base}/rest/v1/${table}${query}`;
      const res = await fetchImpl(endpoint, {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        const excerpt = String(await readErrorBody(res)).slice(0, 300);
        throw new Error(
          `Supabase select failed: GET ${table} -> ${res.status} ${excerpt}`,
        );
      }
      return res.json();
    },
  };
}

// Build a chain adapter from an in-memory object with view-identical
// shapes: `{ agents: [...AgentView], requests: [...PaymentRequest] }`
// (`requests` may also be an `{ id: record }` map).
export function createStubChain(data = {}) {
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const byId = new Map();
  if (Array.isArray(data.requests)) {
    for (const record of data.requests) {
      byId.set(Number(record.request_id), record);
    }
  } else if (data.requests !== null && typeof data.requests === "object") {
    for (const [key, record] of Object.entries(data.requests)) {
      byId.set(Number(key), record);
    }
  }
  return {
    async listAgents() {
      return agents.map((agent) => ({ ...agent }));
    },
    async getRequest(id) {
      const record = byId.get(Number(id));
      return record === undefined ? null : { ...record };
    },
  };
}

// Load a stub chain from a JSON file with the same shape as
// `createStubChain` accepts (view-identical AgentView/PaymentRequest
// entries). Used by `--stub` / `$MIRROR_STUB_FILE` for offline runs.
export function loadStubChain(stubPath) {
  const parsed = JSON.parse(readFileSync(stubPath, "utf8"));
  return createStubChain(parsed);
}

// One idempotent sync pass: upsert agents, then walk request ids from the
// detected base (try 1, fall back to 0) until the first `get_request`
// miss. Request ids are dense and monotonic (every intake consumes one
// id, including rejections), so the walk is complete. A disabled config
// performs zero reads and zero writes.
export async function syncMirror({ chain, store, config }) {
  const counts = { agents: 0, requests: 0, verdicts: 0, auditEvents: 0 };
  if (config?.disabled) return counts;
  if (!chain || typeof chain.listAgents !== "function" || typeof chain.getRequest !== "function") {
    throw new Error("syncMirror: chain must provide listAgents/getRequest");
  }
  if (!store || typeof store.upsert !== "function") {
    throw new Error("syncMirror: store must provide upsert");
  }

  const agents = await chain.listAgents();
  const agentRows = (agents ?? []).map(mapAgentView);
  if (agentRows.length > 0) {
    await store.upsert("agents", agentRows, "agent_id");
  }
  counts.agents = agentRows.length;

  let startId = 1;
  let current = await chain.getRequest(1);
  if (current === null || current === undefined) {
    const zeroth = await chain.getRequest(0);
    if (zeroth === null || zeroth === undefined) return counts;
    startId = 0;
    current = zeroth;
  }
  for (let id = startId; current !== null && current !== undefined; id += 1) {
    const row = mapPaymentRequest(current);
    await store.upsert("requests", [row], "request_id");
    counts.requests += 1;
    const verdict = deriveVerdict(current);
    if (verdict !== null) {
      await store.upsert("verdicts", [verdict], "request_id");
      counts.verdicts += 1;
    }
    const audits = deriveAudits(current);
    await store.upsert("audit_events", audits, "event,subject");
    counts.auditEvents += audits.length;
    current = await chain.getRequest(id + 1);
  }
  return counts;
}
