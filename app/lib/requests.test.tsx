import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  recordJudgeOutcome,
  resetLastVerified,
} from "../../verifier/src/preflight";
import Badge from "../components/Badge";
import RequestsPage from "../app/requests/page";
import {
  FIXTURE_REQUESTS,
  REQUESTS_STUB_FILE,
  badgeToLabel,
  enrichRequestsWithBadge,
  getMergedRequests,
  handleRequestsGet,
  isRequestBadge,
  loadStubRequests,
  resolveRequestBadge,
  type MirrorRequestRow,
} from "./supabase";
import type { Env } from "./env";

const READY_ENV: Env = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key",
};

const DISABLED_ENV: Env = {};

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requests-"));
  const file = path.join(dir, "stub.json");
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

function stubRow(request_id: number, extra: Record<string, unknown> = {}) {
  return {
    request_id,
    agent_id: "agent-1.signer.testnet",
    payee: "good.near",
    amount_yocto: "1000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "staged",
    reason: null,
    ...extra,
  };
}

beforeEach(() => {
  resetLastVerified();
});

describe("badge vocabulary", () => {
  it("maps short badges to the exact literal strings", () => {
    expect(badgeToLabel("verified")).toBe("TEE-verified");
    expect(badgeToLabel("unverifiable")).toBe("attestation unverifiable");
    expect(badgeToLabel("deterministic-only")).toBe("deterministic-only");
  });

  it("guards only the triple", () => {
    expect(isRequestBadge("verified")).toBe(true);
    expect(isRequestBadge("unverifiable")).toBe(true);
    expect(isRequestBadge("deterministic-only")).toBe(true);
    expect(isRequestBadge("TEE-verified")).toBe(false);
    expect(isRequestBadge("")).toBe(false);
    expect(isRequestBadge(undefined)).toBe(false);
    expect(isRequestBadge(null)).toBe(false);
  });
});

describe("resolveRequestBadge precedence", () => {
  it("explicit row badge beats a deterministic-only global", () => {
    const row = stubRow(1, { badge: "verified" }) as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("verified");
  });

  it("row without badge inherits the live global", () => {
    recordJudgeOutcome({ verified: true, model: "m", fixture: false });
    const row = stubRow(1) as unknown as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("verified");
  });

  it("explicit unverifiable beats a verified global", () => {
    recordJudgeOutcome({ verified: true, model: "m", fixture: false });
    const row = stubRow(1, { badge: "unverifiable" }) as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("unverifiable");
  });

  it("invalid row badge falls back to the global", () => {
    recordJudgeOutcome({ verified: true, model: "m", fixture: false });
    const row = stubRow(1, { badge: "TEE-verified" }) as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("verified");
  });

  it("falls back to deterministic-only with no row badge and no global", () => {
    const row = stubRow(1) as unknown as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("deterministic-only");
  });
});

describe("enrichRequestsWithBadge", () => {
  it("stamps every row with a valid badge without mutating the input", () => {
    const rows = [stubRow(2), stubRow(1, { badge: "verified" })];
    const out = enrichRequestsWithBadge(
      rows as unknown as MirrorRequestRow[],
    );
    expect(out).toHaveLength(2);
    for (const row of out) {
      expect(isRequestBadge(row.badge)).toBe(true);
    }
    expect(out[1].badge).toBe("verified");
    expect(rows[0]).not.toHaveProperty("badge");
  });
});

describe("loadStubRequests", () => {
  it("returns null when the env var is unset or the file is unreadable", () => {
    expect(loadStubRequests(DISABLED_ENV)).toBeNull();
    expect(
      loadStubRequests({ [REQUESTS_STUB_FILE]: "/no/such/file.json" }),
    ).toBeNull();
  });

  it("accepts a bare array and normalizes string request ids", () => {
    const file = writeStubFile([
      { ...stubRow(7), request_id: "7", badge: "unverifiable" },
      { ...stubRow(8), badge: "verified" },
      { agent_id: "no-id" },
    ]);
    const rows = loadStubRequests({ [REQUESTS_STUB_FILE]: file });
    expect(rows).toHaveLength(2);
    expect(rows?.map((row) => row.request_id)).toEqual([8, 7]);
    expect(rows?.[1].badge).toBe("unverifiable");
  });

  it("accepts the { requests: [...] } object shape", () => {
    const file = writeStubFile({ requests: [stubRow(4)] });
    const rows = loadStubRequests({ [REQUESTS_STUB_FILE]: file });
    expect(rows).toHaveLength(1);
    expect(rows?.[0].request_id).toBe(4);
  });

  it("returns null on malformed JSON instead of throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requests-"));
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{not json");
    expect(loadStubRequests({ [REQUESTS_STUB_FILE]: file })).toBeNull();
  });
});

describe("getMergedRequests", () => {
  it("falls back to the labeled fixture with zero credentials", async () => {
    const rows = await getMergedRequests({
      fetchImpl: throwingFetch(),
      env: DISABLED_ENV,
    });
    expect(rows.map((row) => row.request_id)).toEqual([3, 2, 1]);
    const paid = rows.find((row) => row.request_id === 3);
    expect(paid?.status).toBe("paid");
    expect(String(paid?.purpose_ref)).toContain("invoice-114");
    expect(String(paid?.vendor)).toContain("CoreWeave");
    expect(paid?.badge).toBe("verified");
    const rejected = rows.find((row) => row.request_id === 2);
    expect(rejected?.status).toBe("rejected");
    expect(String(rejected?.reason)).toContain("PayeeNotAllowlisted");
    expect(String(rejected?.reason)).toContain("invoice-114");
    const held = rows.find((row) => row.request_id === 1);
    expect(held?.badge).toBe("unverifiable");
    expect(badgeToLabel(held?.badge ?? "deterministic-only")).toBe(
      "attestation unverifiable",
    );
    expect(FIXTURE_REQUESTS).toHaveLength(3);
  });

  it("merges stub over fixture and mirror over stub by request_id", async () => {
    const file = writeStubFile([
      { ...stubRow(2), status: "paid", reason: "stub-paid" },
      { ...stubRow(9), status: "staged", badge: "unverifiable" },
    ]);
    const env: Env = { [REQUESTS_STUB_FILE]: file };
    const mirrorRows = [{ ...stubRow(2), status: "held", reason: "mirror-held" }];
    const withMirror: Env = {
      ...READY_ENV,
      [REQUESTS_STUB_FILE]: file,
    };
    const stubOnly = await getMergedRequests({ fetchImpl: throwingFetch(), env });
    expect(
      stubOnly.find((row) => row.request_id === 2)?.status,
    ).toBe("paid");
    expect(stubOnly.some((row) => row.request_id === 9)).toBe(true);
    const merged = await getMergedRequests({
      fetchImpl: okFetch(mirrorRows),
      env: withMirror,
    });
    // Mirror wins over the stub row for request 2.
    expect(merged.find((row) => row.request_id === 2)?.status).toBe("held");
    // Stub-only and fixture-only rows survive, sorted newest-first.
    const ids = merged.map((row) => row.request_id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids).toContain(9);
    expect(ids).toContain(3);
  });
});

describe("handleRequestsGet badge stamping", () => {
  it("returns 10 stamped rows for a 10-row mirror with ?limit=10", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => stubRow(10 - i));
    const res = await handleRequestsGet(
      new Request("http://localhost/api/requests?limit=10"),
      { fetchImpl: okFetch(rows), env: READY_ENV },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { badge: unknown }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(10);
    for (const row of body) {
      expect(["verified", "unverifiable", "deterministic-only"]).toContain(
        row.badge,
      );
    }
  });

  it("serves stub rows with badges when the mirror is disabled", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      stubRow(10 - i, i === 0 ? { badge: "verified" } : {}),
    );
    const file = writeStubFile(rows);
    const res = await handleRequestsGet(
      new Request("http://localhost/api/requests?limit=10"),
      {
        fetchImpl: throwingFetch(),
        env: { [REQUESTS_STUB_FILE]: file },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { badge: unknown }[];
    expect(body).toHaveLength(10);
    for (const row of body) {
      expect(["verified", "unverifiable", "deterministic-only"]).toContain(
        row.badge,
      );
    }
  });

  it("keeps the 503-disabled contract when no source is configured", async () => {
    const res = await handleRequestsGet(
      new Request("http://localhost/api/requests?limit=5"),
      { fetchImpl: throwingFetch(), env: DISABLED_ENV },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, string>;
    expect(body.mirror).toBe("disabled");
  });
});

describe("Badge component", () => {
  it("renders the exact literals with request-scoped test ids", () => {
    const verified = renderToStaticMarkup(
      <Badge badge="verified" requestId={3} />,
    );
    expect(verified).toContain("TEE-verified");
    expect(verified).toContain("badge-3");
    const unverifiable = renderToStaticMarkup(
      <Badge badge="unverifiable" requestId={1} />,
    );
    expect(unverifiable).toContain("attestation unverifiable");
    expect(unverifiable).toContain("badge-1");
    const deterministic = renderToStaticMarkup(
      <Badge badge="deterministic-only" requestId={2} />,
    );
    expect(deterministic).toContain("deterministic-only");
  });
});

describe("requests page probe strings", () => {
  it("renders TEE-verified, PayeeNotAllowlisted, invoice-114, attestation unverifiable", async () => {
    const savedUrl = process.env.SUPABASE_URL;
    const savedKey = process.env.SUPABASE_SERVICE_KEY;
    const savedStub = process.env[REQUESTS_STUB_FILE];
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env[REQUESTS_STUB_FILE];
    try {
      const html = renderToStaticMarkup(await RequestsPage());
      expect(html).toContain("<h1>Requests</h1>");
      expect(html).toContain("TEE-verified");
      expect(html).toContain("PayeeNotAllowlisted");
      expect(html).toContain("invoice-114");
      expect(html).toContain("attestation unverifiable");
      expect(html).toContain("request-3");
      expect(html).toContain("badge-3");
    } finally {
      if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
      if (savedKey !== undefined) process.env.SUPABASE_SERVICE_KEY = savedKey;
      if (savedStub !== undefined) process.env[REQUESTS_STUB_FILE] = savedStub;
    }
  });
});
