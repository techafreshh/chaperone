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

describe("resolveRequestBadge precedence (issue #63)", () => {
  it("fixture rows with badge verified resolve to deterministic-only", () => {
    const row = stubRow(1, {
      badge: "verified",
      source: "fixture",
    }) as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("deterministic-only");
  });

  it("stub rows with badge verified resolve to deterministic-only", () => {
    const row = stubRow(1, {
      badge: "verified",
      source: "stub",
    }) as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("deterministic-only");
  });

  it("unsourced rows never resolve to verified", () => {
    recordJudgeOutcome({ verified: true, model: "m", fixture: false });
    const row = stubRow(1, {
      badge: "verified",
    }) as unknown as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("deterministic-only");
  });

  it("mirror rows need a verified preflight plus a bound signature", () => {
    recordJudgeOutcome({ verified: true, model: "m", fixture: false });
    const backed = stubRow(1, {
      source: "mirror",
      verdict_signature: "ed25519:sig-for-1",
    }) as unknown as MirrorRequestRow;
    expect(resolveRequestBadge(backed)).toBe("verified");
    const unbacked = stubRow(2, {
      source: "mirror",
    }) as unknown as MirrorRequestRow;
    expect(resolveRequestBadge(unbacked)).toBe("deterministic-only");
  });

  it("mirror rows with a fixture preflight stay non-verified even when backed", () => {
    recordJudgeOutcome({ verified: true, model: "m", fixture: true });
    const row = stubRow(1, {
      source: "mirror",
      verdict_signature: "ed25519:sig-for-1",
    }) as unknown as MirrorRequestRow;
    // A fixture preflight maps to `unverifiable`, never `verified`.
    expect(resolveRequestBadge(row)).toBe("unverifiable");
  });

  it("chain rows with backing resolve to verified", () => {
    recordJudgeOutcome({ verified: true, model: "m", fixture: false });
    const row = stubRow(1, {
      source: "chain",
      signature: "ed25519:sig-for-1",
    }) as unknown as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("verified");
  });

  it("explicit unverifiable on chain/mirror rows still surfaces", () => {
    recordJudgeOutcome({ verified: true, model: "m", fixture: false });
    const row = stubRow(1, {
      source: "mirror",
      badge: "unverifiable",
    }) as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("unverifiable");
  });

  it("falls back to deterministic-only with no row badge and no global", () => {
    const row = stubRow(1, {
      source: "mirror",
    }) as unknown as MirrorRequestRow;
    expect(resolveRequestBadge(row)).toBe("deterministic-only");
  });
});

describe("enrichRequestsWithBadge", () => {
  it("stamps every row with a valid badge and source without mutating the input", () => {
    const rows = [
      stubRow(2, { source: "stub" }),
      stubRow(1, { badge: "verified", source: "stub" }),
    ];
    const out = enrichRequestsWithBadge(
      rows as unknown as MirrorRequestRow[],
    );
    expect(out).toHaveLength(2);
    for (const row of out) {
      expect(isRequestBadge(row.badge)).toBe(true);
    }
    // Stub rows never resolve to verified, whatever their badge field says.
    expect(out[1].badge).toBe("deterministic-only");
    expect(out[1].source).toBe("stub");
    expect(rows[0]).not.toHaveProperty("badge");
  });

  it("defaults unsourced rows to fixture sample data", () => {
    const out = enrichRequestsWithBadge([stubRow(5)] as unknown as MirrorRequestRow[]);
    expect(out[0].source).toBe("fixture");
    expect(out[0].badge).toBe("deterministic-only");
  });
});

describe("loadStubRequests", () => {
  it("returns null when the env var is unset or the file is unreadable", () => {
    expect(loadStubRequests(DISABLED_ENV)).toBeNull();
    expect(
      loadStubRequests({ [REQUESTS_STUB_FILE]: "/no/such/file.json" }),
    ).toBeNull();
  });

  it("accepts a bare array, normalizes string request ids, and tags stub source", () => {
    const file = writeStubFile([
      { ...stubRow(7), request_id: "7", badge: "unverifiable" },
      { ...stubRow(8), badge: "verified" },
      { agent_id: "no-id" },
    ]);
    const rows = loadStubRequests({ [REQUESTS_STUB_FILE]: file });
    expect(rows).toHaveLength(2);
    expect(rows?.map((row) => row.request_id)).toEqual([8, 7]);
    expect(rows?.[1].badge).toBe("unverifiable");
    for (const row of rows ?? []) {
      expect(row.source).toBe("stub");
    }
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
  it("falls back to labeled sample data with zero credentials", async () => {
    const rows = await getMergedRequests({
      fetchImpl: throwingFetch(),
      env: DISABLED_ENV,
    });
    expect(rows.map((row) => row.request_id)).toEqual([3, 2, 1]);
    const paid = rows.find((row) => row.request_id === 3);
    expect(paid?.status).toBe("paid");
    expect(String(paid?.purpose_ref)).toContain("invoice-114");
    expect(String(paid?.vendor)).toContain("CoreWeave");
    // Offline fixture rows never render TEE-verified.
    expect(paid?.badge).toBe("deterministic-only");
    expect(paid?.source).toBe("fixture");
    const rejected = rows.find((row) => row.request_id === 2);
    expect(rejected?.status).toBe("rejected");
    expect(String(rejected?.reason)).toContain("PayeeNotAllowlisted");
    expect(String(rejected?.reason)).toContain("invoice-114");
    expect(rejected?.source).toBe("fixture");
    const held = rows.find((row) => row.request_id === 1);
    expect(held?.badge).toBe("deterministic-only");
    expect(held?.source).toBe("fixture");
    expect(FIXTURE_REQUESTS).toHaveLength(3);
    for (const row of rows) {
      expect(row.source).toBe("fixture");
    }
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
  it("returns 10 stamped mirror rows for a 10-row mirror with ?limit=10", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => stubRow(10 - i));
    const res = await handleRequestsGet(
      new Request("http://localhost/api/requests?limit=10"),
      { fetchImpl: okFetch(rows), env: READY_ENV },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { badge: unknown; source: unknown }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(10);
    for (const row of body) {
      expect(["verified", "unverifiable", "deterministic-only"]).toContain(
        row.badge,
      );
      // Mirror tier rows carry mirror source; without backing they stay
      // deterministic-only (never verified from the badge field alone).
      expect(row.source).toBe("mirror");
      expect(row.badge).toBe("deterministic-only");
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
      <Badge badge="verified" requestId={3} source="mirror" />,
    );
    expect(verified).toContain("TEE-verified");
    expect(verified).toContain("badge-3");
    const unverifiable = renderToStaticMarkup(
      <Badge badge="unverifiable" requestId={1} source="mirror" />,
    );
    expect(unverifiable).toContain("attestation unverifiable");
    expect(unverifiable).toContain("badge-1");
    const deterministic = renderToStaticMarkup(
      <Badge badge="deterministic-only" requestId={2} source="fixture" />,
    );
    expect(deterministic).toContain("deterministic-only");
  });

  it("never renders TEE-verified for fixture or stub rows", () => {
    const fixture = renderToStaticMarkup(
      <Badge badge="verified" requestId={3} source="fixture" />,
    );
    expect(fixture).not.toContain("TEE-verified");
    expect(fixture).toContain("deterministic-only");
    const stub = renderToStaticMarkup(
      <Badge badge="verified" requestId={3} source="stub" />,
    );
    expect(stub).not.toContain("TEE-verified");
    expect(stub).toContain("deterministic-only");
  });
});

describe("requests page probe strings (issue #63)", () => {
  it("renders sample data with no TEE-verified, plus PayeeNotAllowlisted and invoice-114", async () => {
    const savedUrl = process.env.SUPABASE_URL;
    const savedKey = process.env.SUPABASE_SERVICE_KEY;
    const savedStub = process.env[REQUESTS_STUB_FILE];
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env[REQUESTS_STUB_FILE];
    try {
      const html = renderToStaticMarkup(await RequestsPage());
      expect(html).toContain("<h1>Requests</h1>");
      expect(html).not.toContain("TEE-verified");
      expect(html).toContain("sample data");
      expect(html).toContain("PayeeNotAllowlisted");
      expect(html).toContain("invoice-114");
      expect(html).toContain("deterministic-only");
      expect(html).toContain("request-3");
      expect(html).toContain("badge-3");
    } finally {
      if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
      if (savedKey !== undefined) process.env.SUPABASE_SERVICE_KEY = savedKey;
      if (savedStub !== undefined) process.env[REQUESTS_STUB_FILE] = savedStub;
    }
  });
});
