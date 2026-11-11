import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MIRROR_DISABLED_REASON,
  STATUS_FAILED,
  STATUS_PAYING,
  clampRequestsLimit,
  getMergedRequests,
  getMirrorStatus,
  handleRequestsGet,
  listRequests,
} from "./supabase";
import type { Env } from "./env";

const READY_ENV: Env = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key",
};

function stubRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    request_id: n - i,
    agent_id: "agent-1.signer.testnet",
    payee: "good.near",
    amount_yocto: "1000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "staged",
    reason: null,
  }));
}

function okFetch(rows: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => rows,
      text: async () => JSON.stringify(rows),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
});

describe("getMirrorStatus", () => {
  it("reports disabled without credentials", () => {
    expect(getMirrorStatus({})).toEqual({
      state: "disabled",
      reason: MIRROR_DISABLED_REASON,
    });
  });

  it("reports ready with credentials", () => {
    expect(getMirrorStatus(READY_ENV)).toEqual({
      state: "ready",
      url: "https://x.supabase.co",
    });
  });
});

describe("clampRequestsLimit", () => {
  it("defaults to 20 and clamps to 1-100", () => {
    expect(clampRequestsLimit(null)).toBe(20);
    expect(clampRequestsLimit("abc")).toBe(20);
    expect(clampRequestsLimit(500)).toBe(100);
    expect(clampRequestsLimit("0")).toBe(1);
    expect(clampRequestsLimit("-3")).toBe(1);
    expect(clampRequestsLimit(5)).toBe(5);
  });
});

describe("listRequests", () => {
  it("issues a PostgREST select with limit=5 and returns rows unchanged", async () => {
    const rows = stubRows(5);
    const { impl, calls } = okFetch(rows);
    const out = await listRequests(5, impl, READY_ENV);
    expect(out).toEqual(rows);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/rest/v1/requests");
    expect(calls[0].url).toContain("limit=5");
    expect(calls[0].url).toContain("order=request_id.desc");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.apikey).toBe("service-key");
    expect(headers.Authorization).toBe("Bearer service-key");
  });

  it("throws a labeled error when disabled", async () => {
    const { impl } = okFetch([]);
    await expect(
      listRequests(5, impl, {}),
    ).rejects.toThrow(/mirror disabled/);
  });

  it("throws a transport error when fetch fails", async () => {
    const failing = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    await expect(listRequests(5, failing, READY_ENV)).rejects.toThrow(
      /mirror request failed/,
    );
  });
});

describe("payout statuses", () => {
  it("pins the on-chain paying/failed strings", () => {
    expect(STATUS_PAYING).toBe("paying");
    expect(STATUS_FAILED).toBe("failed");
  });

  it("passes paying and failed rows through the merged feed with badges", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-"));
    const file = path.join(dir, "stub.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { request_id: 11, agent_id: "agent-1", status: "paying", reason: null },
        {
          request_id: 12,
          agent_id: "agent-1",
          status: "failed",
          reason: "TransferFailed",
        },
      ]),
    );
    const throwing = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    // No mirror credentials: the mirror tier falls through, the stub
    // tier decides.
    const rows = await getMergedRequests({
      fetchImpl: throwing,
      env: { REQUESTS_STUB_FILE: file },
    });
    const paying = rows.find((row) => row.request_id === 11);
    expect(paying?.status).toBe("paying");
    expect(["verified", "unverifiable", "deterministic-only"]).toContain(
      paying?.badge,
    );
    const failed = rows.find((row) => row.request_id === 12);
    expect(failed?.status).toBe("failed");
    expect(failed?.reason).toBe("TransferFailed");
  });
});

describe("handleRequestsGet", () => {
  it("returns 200 array length <=5 with request_id/status fields", async () => {
    const { impl } = okFetch(stubRows(5));
    const res = await handleRequestsGet(
      new Request("http://localhost/api/requests?limit=5"),
      { fetchImpl: impl, env: READY_ENV },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-chaperone-mirror")).toBe("ready");
    const body = (await res.json()) as { request_id: number; status: string }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(5);
    for (const row of body) {
      expect(typeof row.request_id).toBe("number");
      expect(typeof row.status).toBe("string");
    }
  });

  it("returns 503 with mirror disabled when unconfigured", async () => {
    const { impl } = okFetch([]);
    const res = await handleRequestsGet(
      new Request("http://localhost/api/requests?limit=5"),
      { fetchImpl: impl, env: {} },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("x-chaperone-mirror")).toBe("disabled");
    const body = (await res.json()) as Record<string, string>;
    expect(body.mirror).toBe("disabled");
    expect(body.error).toMatch(/mirror disabled/);
  });

  it("returns 502 on transport failure", async () => {
    const failing = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const res = await handleRequestsGet(
      new Request("http://localhost/api/requests"),
      { fetchImpl: failing, env: READY_ENV },
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("x-chaperone-mirror")).toBe("ready");
  });
});
