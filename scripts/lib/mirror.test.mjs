import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIRROR_DISABLED_REASON,
  createStubChain,
  createSupabaseStore,
  deriveAudits,
  deriveVerdict,
  mapAgentView,
  mapPaymentRequest,
  parseMirrorArgs,
  resolveMirrorConfig,
  syncMirror,
} from "./mirror.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  here,
  "..",
  "..",
  "supabase",
  "migrations",
  "0001_chaperone_mirror.sql",
);

function stubFetchOk(calls) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 201,
      async text() {
        return "";
      },
      async json() {
        return [];
      },
    };
  };
}

function captureStore() {
  const calls = [];
  return {
    calls,
    async upsert(table, rows, onConflict) {
      calls.push({ table, rows, onConflict });
      return rows;
    },
  };
}

describe("parseMirrorArgs", () => {
  it("parses --once, --stub, --contract and --rpc-url", () => {
    const args = parseMirrorArgs([
      "--once",
      "--stub",
      "stub.json",
      "--contract",
      "guard.testnet",
      "--rpc-url",
      "https://example.test",
    ]);
    assert.equal(args.once, true);
    assert.equal(args.stub, "stub.json");
    assert.equal(args.contract, "guard.testnet");
    assert.equal(args.rpcUrl, "https://example.test");
  });

  it("parses --help without requiring anything else", () => {
    assert.equal(parseMirrorArgs(["--help"]).help, true);
    assert.equal(parseMirrorArgs([]).help, false);
  });

  it("rejects unknown arguments with a labeled error", () => {
    assert.throws(() => parseMirrorArgs(["--bogus"]), /Unknown argument: --bogus/);
  });
});

describe("resolveMirrorConfig", () => {
  it("reports disabled when credentials are unset", () => {
    assert.deepEqual(resolveMirrorConfig({}), {
      disabled: true,
      reason: MIRROR_DISABLED_REASON,
    });
    assert.equal(
      resolveMirrorConfig({ SUPABASE_URL: "https://x.supabase.co" }).disabled,
      true,
    );
    assert.equal(
      resolveMirrorConfig({ SUPABASE_SERVICE_KEY: "key" }).disabled,
      true,
    );
  });

  it("resolves ready config and strips trailing slashes", () => {
    const config = resolveMirrorConfig({
      SUPABASE_URL: "https://x.supabase.co/",
      SUPABASE_SERVICE_KEY: "key",
    });
    assert.equal(config.disabled, false);
    assert.equal(config.url, "https://x.supabase.co");
  });
});

describe("mapAgentView", () => {
  it("maps daily_allowance_yocto/per_payment_cap_yocto to allowance_yocto/cap_yocto", () => {
    const row = mapAgentView({
      agent_id: "agent-1.signer.testnet",
      daily_allowance_yocto: "50000000000000000000000000",
      per_payment_cap_yocto: "10000000000000000000000000",
      payee_allowlist: ["good.near"],
      active: true,
      spent_today_yocto: "0",
      remaining_today_yocto: "50000000000000000000000000",
    });
    assert.equal(row.agent_id, "agent-1.signer.testnet");
    assert.equal(row.allowance_yocto, "50000000000000000000000000");
    assert.equal(row.cap_yocto, "10000000000000000000000000");
    assert.equal(row.active, true);
    assert.deepEqual(row.payee_allowlist, ["good.near"]);
  });

  it("accepts U128 object shapes", () => {
    const row = mapAgentView({
      agent_id: "agent-1.signer.testnet",
      daily_allowance_yocto: { value: "50" },
      per_payment_cap_yocto: "10",
      active: false,
    });
    assert.equal(row.allowance_yocto, "50");
    assert.equal(row.cap_yocto, "10");
    assert.equal(row.active, false);
  });
});

describe("mapPaymentRequest", () => {
  it("mirrors a request_created-shaped event for id 9 with matching payee/amount", () => {
    const row = mapPaymentRequest({
      request_id: 9,
      agent_id: "agent-1.signer.testnet",
      payee: "good.near",
      amount_yocto: "5000000000000000000000000",
      purpose_ref: "invoice-114",
      vendor: "CoreWeave",
      status: "staged",
      reason: null,
    });
    assert.equal(row.request_id, 9);
    assert.equal(row.payee, "good.near");
    assert.equal(row.amount_yocto, "5000000000000000000000000");
    assert.equal(row.purpose_ref, "invoice-114");
    assert.equal(row.vendor, "CoreWeave");
    assert.equal(row.status, "staged");
    assert.equal(row.reason, null);
  });
});

describe("deriveAudits", () => {
  const base = {
    request_id: 9,
    agent_id: "agent-1.signer.testnet",
    payee: "good.near",
    amount_yocto: "5000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
  };

  it("maps rejected to request_rejected only", () => {
    const audits = deriveAudits({
      ...base,
      status: "rejected",
      reason: "ExceedsPerPaymentCap",
    });
    assert.deepEqual(
      audits.map((a) => a.event),
      ["request_rejected"],
    );
    assert.equal(audits[0].subject, "request:9");
  });

  it("maps staged to request_created only", () => {
    const audits = deriveAudits({ ...base, status: "staged", reason: null });
    assert.deepEqual(
      audits.map((a) => a.event),
      ["request_created"],
    );
  });

  it("maps paid to created + verdict + paid with consistent verdict", () => {
    const audits = deriveAudits({ ...base, status: "paid", reason: null });
    assert.deepEqual(
      audits.map((a) => a.event),
      ["request_created", "verdict_recorded", "request_paid"],
    );
    assert.equal(
      audits.find((a) => a.event === "verdict_recorded").data.consistent,
      true,
    );
    assert.deepEqual(deriveVerdict({ ...base, status: "paid" }), {
      request_id: 9,
      consistent: true,
    });
  });

  it("maps held to created + verdict + held with inconsistent verdict", () => {
    const audits = deriveAudits({ ...base, status: "held", reason: null });
    assert.deepEqual(
      audits.map((a) => a.event),
      ["request_created", "verdict_recorded", "request_held"],
    );
    assert.equal(
      audits.find((a) => a.event === "verdict_recorded").data.consistent,
      false,
    );
    assert.deepEqual(deriveVerdict({ ...base, status: "held" }), {
      request_id: 9,
      consistent: false,
    });
  });

  it("derives no verdict row for staged or rejected requests", () => {
    assert.equal(deriveVerdict({ ...base, status: "staged" }), null);
    assert.equal(deriveVerdict({ ...base, status: "rejected" }), null);
  });
});

describe("createSupabaseStore", () => {
  it("upserts with Prefer merge-duplicates and on_conflict", async () => {
    const calls = [];
    const store = createSupabaseStore({
      url: "https://x.supabase.co/",
      serviceKey: "service-key",
      fetchImpl: stubFetchOk(calls),
    });
    await store.upsert("requests", [{ request_id: 9 }], "request_id");
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call.url.startsWith("https://x.supabase.co/rest/v1/requests"));
    assert.ok(call.url.includes("on_conflict=request_id"));
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers.apikey, "service-key");
    assert.equal(
      call.init.headers.Authorization,
      "Bearer service-key",
    );
    assert.equal(
      call.init.headers.Prefer,
      "resolution=merge-duplicates",
    );
    assert.deepEqual(JSON.parse(call.init.body), [{ request_id: 9 }]);
  });

  it("throws a labeled error with a body excerpt on non-2xx", async () => {
    const store = createSupabaseStore({
      url: "https://x.supabase.co",
      serviceKey: "service-key",
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        async text() {
          return "invalid api key detail";
        },
      }),
    });
    await assert.rejects(
      store.upsert("requests", [{ request_id: 1 }], "request_id"),
      /Supabase upsert failed: POST requests -> 401 invalid api key detail/,
    );
  });
});

describe("syncMirror", () => {
  const request9 = {
    request_id: 9,
    agent_id: "agent-1.signer.testnet",
    payee: "good.near",
    amount_yocto: "5000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "staged",
    reason: null,
  };
  const agent = {
    agent_id: "agent-1.signer.testnet",
    daily_allowance_yocto: "50000000000000000000000000",
    per_payment_cap_yocto: "10000000000000000000000000",
    payee_allowlist: ["good.near"],
    active: true,
    spent_today_yocto: "0",
    remaining_today_yocto: "50000000000000000000000000",
  };

  it("round-trips a 1-based stub chain and upserts requests id 9 faithfully", async () => {
    // Request ids are dense and monotonic: id 9 exists alongside 1-8.
    const earlier = [];
    for (let id = 1; id <= 8; id += 1) {
      earlier.push({ ...request9, request_id: id });
    }
    const chain = createStubChain({ agents: [agent], requests: [...earlier, request9] });
    const store = captureStore();
    const counts = await syncMirror({
      chain,
      store,
      config: { disabled: false },
    });
    assert.equal(counts.agents, 1);
    assert.equal(counts.requests, 9);
    const requestCalls = store.calls.filter((c) => c.table === "requests");
    assert.equal(requestCalls.length, 9);
    for (const call of requestCalls) {
      assert.equal(call.onConflict, "request_id");
    }
    const row9 = requestCalls.find((c) => c.rows[0].request_id === 9);
    assert.ok(row9);
    assert.equal(row9.rows[0].payee, "good.near");
    assert.equal(row9.rows[0].amount_yocto, "5000000000000000000000000");
    const agentCall = store.calls.find((c) => c.table === "agents");
    assert.equal(agentCall.onConflict, "agent_id");
    assert.equal(agentCall.rows[0].allowance_yocto, "50000000000000000000000000");
    assert.equal(agentCall.rows[0].cap_yocto, "10000000000000000000000000");
    assert.equal(agentCall.rows[0].active, true);
  });

  it("detects a 0-based chain via the id 0 fallback", async () => {
    const zeroth = { ...request9, request_id: 0, status: "rejected", reason: "AgentInactive" };
    const chain = createStubChain({ agents: [], requests: [zeroth] });
    const store = captureStore();
    const counts = await syncMirror({
      chain,
      store,
      config: { disabled: false },
    });
    assert.equal(counts.requests, 1);
    const requestCall = store.calls.find((c) => c.table === "requests");
    assert.equal(requestCall.rows[0].request_id, 0);
  });

  it("performs zero fetch calls when disabled", async () => {
    let calls = 0;
    const chain = {
      async listAgents() {
        calls += 1;
        return [];
      },
      async getRequest() {
        calls += 1;
        return null;
      },
    };
    const store = {
      async upsert() {
        calls += 1;
        return [];
      },
    };
    const counts = await syncMirror({
      chain,
      store,
      config: { disabled: true, reason: MIRROR_DISABLED_REASON },
    });
    assert.deepEqual(counts, {
      agents: 0,
      requests: 0,
      verdicts: 0,
      auditEvents: 0,
    });
    assert.equal(calls, 0);
  });
});

describe("migration file", () => {
  it("creates all four tables with the required agents columns", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(migrationPath, "utf8");
    for (const table of ["agents", "requests", "verdicts", "audit_events"]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
    for (const column of ["agent_id", "allowance_yocto", "cap_yocto", "active"]) {
      assert.ok(sql.includes(column), `migration must define ${column}`);
    }
  });
});
