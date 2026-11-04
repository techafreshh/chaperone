import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import QueuePage from "../app/queue/page";
import {
  FIXTURE_QUEUE_REQUESTS,
  __resetQueueOverlayForTests,
  getQueueState,
  handleQueueApprove,
  handleQueueReject,
  loadChainQueue,
  loadMirrorQueue,
  loadStubQueue,
} from "./queue";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

const READY_ENV = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key",
} as NodeJS.ProcessEnv;

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch;
}

function okFetch(rows: unknown) {
  const impl = (async () => ({
    ok: true,
    status: 200,
    json: async () => rows,
    text: async () => JSON.stringify(rows),
  })) as unknown as typeof fetch;
  return impl;
}

function writeStubFile(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-"));
  const file = path.join(dir, "stub.json");
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

function stubRow(request_id: number, extra: Record<string, unknown> = {}) {
  return {
    request_id,
    agent_id: "agent-1",
    payee: "good.near",
    amount_yocto: "1000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "held",
    reason: "reason mismatch",
    active: true,
    ...extra,
  };
}

beforeEach(() => {
  __resetQueueOverlayForTests();
});

describe("fixture probe strings", () => {
  it("holds request 6 with reason mismatch plus a frozen row", async () => {
    const state = await getQueueState({
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    const six = state.requests.find((row) => row.request_id === 6);
    expect(six?.status).toBe("held");
    expect(six?.reason).toBe("reason mismatch");
    expect(six?.active).toBe(true);
    const frozen = state.requests.find((row) => row.active === false);
    expect(frozen).toBeDefined();
    expect(FIXTURE_QUEUE_REQUESTS).toHaveLength(2);
  });
});

describe("loadStubQueue", () => {
  it("returns null when no stub env is set", () => {
    expect(loadStubQueue(EMPTY_ENV)).toBeNull();
  });

  it("accepts a bare array and normalizes string ids", () => {
    const file = writeStubFile([
      { ...stubRow(7, { request_id: "7" }) },
      { agent_id: "no-id" },
    ]);
    const rows = loadStubQueue({ QUEUE_STUB_FILE: file });
    expect(rows).toHaveLength(1);
    expect(rows?.[0].request_id).toBe(7);
  });

  it("accepts the { requests: [...] } object shape", () => {
    const file = writeStubFile({ requests: [stubRow(8)] });
    const rows = loadStubQueue({ QUEUE_STUB_FILE: file });
    expect(rows).toHaveLength(1);
    expect(rows?.[0].request_id).toBe(8);
  });

  it("prefers QUEUE_STUB_FILE over REQUESTS_STUB_FILE", () => {
    const first = writeStubFile([stubRow(11)]);
    const second = writeStubFile([stubRow(12)]);
    const rows = loadStubQueue({
      QUEUE_STUB_FILE: first,
      REQUESTS_STUB_FILE: second,
    });
    expect(rows?.map((row) => row.request_id)).toEqual([11]);
  });

  it("falls back to REQUESTS_STUB_FILE when the first is unset", () => {
    const second = writeStubFile([stubRow(13)]);
    const rows = loadStubQueue({ REQUESTS_STUB_FILE: second });
    expect(rows?.map((row) => row.request_id)).toEqual([13]);
  });
});

describe("getQueueState merge precedence", () => {
  it("merges stub over fixture and mirror over stub by request_id", async () => {
    const file = writeStubFile([
      { ...stubRow(6, { reason: "stub-objection" }) },
      { ...stubRow(9) },
    ]);
    const stubOnly = await getQueueState({
      fetchImpl: throwingFetch(),
      env: { QUEUE_STUB_FILE: file },
    });
    expect(
      stubOnly.requests.find((row) => row.request_id === 6)?.reason,
    ).toBe("stub-objection");
    expect(stubOnly.requests.some((row) => row.request_id === 9)).toBe(true);

    const mirrorRows = [{ ...stubRow(6, { reason: "mirror-objection" }) }];
    const merged = await getQueueState({
      fetchImpl: okFetch(mirrorRows),
      env: { ...READY_ENV, QUEUE_STUB_FILE: file },
    });
    expect(
      merged.requests.find((row) => row.request_id === 6)?.reason,
    ).toBe("mirror-objection");
    const ids = merged.requests.map((row) => row.request_id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids).toContain(9);
  });

  it("keeps only held rows newest-first", async () => {
    const file = writeStubFile([
      { ...stubRow(20, { status: "paid" }) },
      { ...stubRow(21, { status: "held" }) },
    ]);
    const state = await getQueueState({
      fetchImpl: throwingFetch(),
      env: { QUEUE_STUB_FILE: file },
    });
    expect(state.requests.some((row) => row.request_id === 20)).toBe(false);
    expect(state.requests.some((row) => row.request_id === 21)).toBe(true);
  });
});

describe("frozen join", () => {
  it("frozen-wins: an inactive stub row freezes the fixture agent", async () => {
    const file = writeStubFile([
      { ...stubRow(6, { agent_id: "agent-3", active: false }) },
    ]);
    const state = await getQueueState({
      fetchImpl: throwingFetch(),
      env: { QUEUE_STUB_FILE: file },
    });
    const six = state.requests.find((row) => row.request_id === 6);
    expect(six?.agent_id).toBe("agent-3");
    expect(six?.active).toBe(false);
  });

  it("chain get_agent inactive freezes a mirror-active row", async () => {
    const agentView = {
      agent_id: "agent-1",
      daily_allowance_yocto: "50000000000000000000000000",
      per_payment_cap_yocto: "10000000000000000000000000",
      active: false,
      spent_today_yocto: "0",
      remaining_today_yocto: "50000000000000000000000000",
    };
    const queueRow = stubRow(6, { active: true });
    const rpcOk = (payload: unknown) => {
      const bytes = Array.from(Buffer.from(JSON.stringify(payload), "utf8"));
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { result: bytes } }),
        text: async () => "",
      } as unknown as Response;
    };
    const impl = (async (_url: unknown, init?: { body?: unknown }) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const method = (JSON.parse(bodyText) as { params?: { method_name?: string } })
        .params?.method_name;
      if (method === "list_queue") return rpcOk([queueRow]);
      if (method === "get_agent") return rpcOk(agentView);
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const env = {
      GUARD_CONTRACT_ID: "guard.testnet",
      NEAR_RPC_URL: "https://rpc.testnet.near.org",
    } as NodeJS.ProcessEnv;
    const chain = await loadChainQueue(impl, env);
    expect(chain.state).toBe("ready");
    if (chain.state === "ready") {
      expect(chain.requests[0].active).toBe(false);
    }
    const state = await getQueueState({ fetchImpl: impl, env });
    expect(
      state.requests.find((row) => row.request_id === 6)?.active,
    ).toBe(false);
  });
});

describe("loadMirrorQueue", () => {
  it("is disabled without credentials and filters held client-side", async () => {
    const disabled = await loadMirrorQueue(throwingFetch(), EMPTY_ENV);
    expect(disabled.state).toBe("disabled");
    const mixed = [
      { ...stubRow(30, { status: "held" }) },
      { ...stubRow(31, { status: "paid" }) },
    ];
    const ready = await loadMirrorQueue(okFetch(mixed), READY_ENV);
    expect(ready.state).toBe("ready");
    if (ready.state === "ready") {
      expect(ready.requests.map((row) => row.request_id)).toEqual([30]);
    }
  });
});

describe("approve/reject overlay", () => {
  it("approve answers paid and drops 6 from the held queue", async () => {
    const res = await handleQueueApprove("6", {
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "paid" });
    const state = await getQueueState({
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    expect(state.requests.some((row) => row.request_id === 6)).toBe(false);
  });

  it("reject answers rejected with HoldRejected and drops the row", async () => {
    const res = await handleQueueReject(6, {
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "rejected" });
    const state = await getQueueState({
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    expect(state.requests.some((row) => row.request_id === 6)).toBe(false);
  });

  it("answers 404 for unknown and non-held ids", async () => {
    const missing = await handleQueueApprove("9999", {
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    expect(missing.status).toBe(404);
    const file = writeStubFile([{ ...stubRow(40, { status: "paid" }) }]);
    const env = { QUEUE_STUB_FILE: file } as NodeJS.ProcessEnv;
    const notHeld = await handleQueueApprove("40", {
      fetchImpl: throwingFetch(),
      env,
    });
    expect(notHeld.status).toBe(404);
    const rejectMissing = await handleQueueReject("9999", {
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    expect(rejectMissing.status).toBe(404);
  });

  it("answers 400 for malformed ids", async () => {
    for (const bad of ["abc", "0", "-3", "6.5", "", "  "]) {
      const res = await handleQueueApprove(bad, {
        fetchImpl: throwingFetch(),
        env: EMPTY_ENV,
      });
      expect(res.status).toBe(400);
    }
    const res = await handleQueueReject("nope", {
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    expect(res.status).toBe(400);
  });
});

describe("queue page probe strings", () => {
  it("renders 6, reason mismatch, agent frozen, and approve-6", async () => {
    const html = renderToStaticMarkup(await QueuePage());
    expect(html).toContain("<h1>Queue</h1>");
    expect(html).toContain("6");
    expect(html).toContain("reason mismatch");
    expect(html).toContain("agent frozen");
    expect(html).toContain('data-testid="approve-6"');
    expect(html).toContain('data-testid="reject-6"');
    expect(html).toContain('data-testid="queue-6"');
  });
});
