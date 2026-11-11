import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import ReceiptsPage from "../app/receipts/page";
import {
  FIXTURE_RECEIPTS,
  RECEIPTS_CSV_HEADER,
  STATUS_FAILED,
  STATUS_PAID,
  STATUS_PAYING,
  getReceipts,
  handleAuditExportGet,
  loadChainReceipts,
  loadMirrorReceipts,
  loadStubReceipts,
  normalizeReceiptRow,
  receiptsToCsv,
} from "./receipts";
import type { Env } from "./env";

const EMPTY_ENV: Env = {};

const READY_ENV: Env = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key",
};

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-"));
  const file = path.join(dir, "stub.json");
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

function stubRow(request_id: number, extra: Record<string, unknown> = {}) {
  return {
    request_id,
    agent_id: "agent-1",
    payee: "coreweave.near",
    amount_yocto: "1000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "paid",
    reason: null,
    verdict_signature: `sig-${request_id}`,
    chain_tx: `tx-${request_id}`,
    ...extra,
  };
}

describe("fixture tier (issue #63 sample data)", () => {
  it("yields exactly 3 paid agent-1 receipts with no signature strings and fixture source", async () => {
    const receipts = await getReceipts({
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    expect(receipts).toHaveLength(3);
    expect(FIXTURE_RECEIPTS).toHaveLength(3);
    for (const row of receipts) {
      expect(row.agent_id).toBe("agent-1");
      expect(row.status).toBe("paid");
      expect(typeof row.request_id).toBe("number");
      expect(row.verdict_signature).toBe("");
      expect(row.chain_tx).toBe("");
      expect(row.source).toBe("fixture");
    }
    expect(receipts.map((row) => row.request_id)).toEqual([9, 8, 7]);
  });
});

describe("payout status vocabulary", () => {
  it("pins the on-chain paying/failed strings", () => {
    expect(STATUS_PAID).toBe("paid");
    expect(STATUS_PAYING).toBe("paying");
    expect(STATUS_FAILED).toBe("failed");
  });

  it("normalizes paying and failed rows without mangling them", () => {
    const paying = normalizeReceiptRow(stubRow(50, { status: "paying" }));
    expect(paying?.status).toBe("paying");
    const failed = normalizeReceiptRow(
      stubRow(51, { status: "failed", reason: "TransferFailed" }),
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.reason).toBe("TransferFailed");
  });

  it("keeps the waterfall paid-only when stubs carry paying/failed rows", async () => {
    const file = writeStubFile([
      stubRow(60),
      { ...stubRow(61, { status: "paying" }) },
      { ...stubRow(62, { status: "failed", reason: "TransferFailed" }) },
    ]);
    const receipts = await getReceipts({
      fetchImpl: throwingFetch(),
      env: { RECEIPTS_STUB_FILE: file },
    });
    expect(receipts.map((row) => row.request_id)).toEqual([60]);
  });
});

describe("normalizeReceiptRow", () => {
  it("coerces numeric-string ids and resolves aliased signature/tx keys", () => {
    const row = normalizeReceiptRow({
      request_id: "42",
      agent_id: "agent-1",
      status: "paid",
      signature_base58: "sig-alias",
      tx_hash: "tx-alias",
    });
    expect(row?.request_id).toBe(42);
    expect(row?.status).toBe("paid");
    expect(row?.verdict_signature).toBe("sig-alias");
    expect(row?.chain_tx).toBe("tx-alias");
  });

  it("falls back to empty signature/tx and drops rows without id or agent", () => {
    const row = normalizeReceiptRow({
      request_id: 1,
      agent_id: "agent-1",
      status: "paid",
    });
    expect(row?.verdict_signature).toBe("");
    expect(row?.chain_tx).toBe("");
    expect(normalizeReceiptRow({ agent_id: "agent-1" })).toBeNull();
    expect(normalizeReceiptRow({ request_id: 1 })).toBeNull();
  });
});

describe("loadStubReceipts", () => {
  it("returns null when no stub env is set", () => {
    expect(loadStubReceipts(EMPTY_ENV)).toBeNull();
  });

  it("accepts a bare array and the { receipts: [...] } object shape", () => {
    const bare = writeStubFile([stubRow(7, { request_id: "7" })]);
    expect(loadStubReceipts({ RECEIPTS_STUB_FILE: bare })?.[0].request_id).toBe(
      7,
    );
    const wrapped = writeStubFile({ receipts: [stubRow(8)] });
    expect(
      loadStubReceipts({ RECEIPTS_STUB_FILE: wrapped })?.[0].request_id,
    ).toBe(8);
    const requestsWrapped = writeStubFile({ requests: [stubRow(9)] });
    expect(
      loadStubReceipts({ RECEIPTS_STUB_FILE: requestsWrapped })?.[0]
        .request_id,
    ).toBe(9);
  });

  it("falls back to REQUESTS_STUB_FILE and never throws on malformed JSON", () => {
    const file = writeStubFile([stubRow(11)]);
    expect(
      loadStubReceipts({ REQUESTS_STUB_FILE: file })?.map(
        (row) => row.request_id,
      ),
    ).toEqual([11]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-"));
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    expect(loadStubReceipts({ RECEIPTS_STUB_FILE: bad })).toBeNull();
  });
});

describe("getReceipts merge precedence", () => {
  it("a stub shadows the fixture tier entirely", async () => {
    const file = writeStubFile([
      stubRow(21),
      stubRow(22),
      stubRow(23),
      { ...stubRow(24, { status: "held" }) },
    ]);
    const receipts = await getReceipts({
      fetchImpl: throwingFetch(),
      env: { RECEIPTS_STUB_FILE: file },
    });
    expect(receipts.map((row) => row.request_id)).toEqual([23, 22, 21]);
  });

  it("chain wins over mirror over stub per request_id", async () => {
    const file = writeStubFile([stubRow(30, { verdict_signature: "stub-sig" })]);
    const mirrorRows = [
      { ...stubRow(30, { verdict_signature: "mirror-sig" }), status: "paid" },
    ];
    const merged = await getReceipts({
      fetchImpl: okFetch(mirrorRows),
      env: { ...READY_ENV, RECEIPTS_STUB_FILE: file },
    });
    expect(
      merged.find((row) => row.request_id === 30)?.verdict_signature,
    ).toBe("mirror-sig");
  });
});

describe("loadMirrorReceipts", () => {
  it("is disabled without credentials and filters paid client-side", async () => {
    const disabled = await loadMirrorReceipts(throwingFetch(), EMPTY_ENV);
    expect(disabled.state).toBe("disabled");
    const mixed = [
      stubRow(40, { status: "paid" }),
      stubRow(41, { status: "held" }),
    ];
    const ready = await loadMirrorReceipts(okFetch(mixed), READY_ENV);
    expect(ready.state).toBe("ready");
    if (ready.state === "ready") {
      expect(ready.receipts.map((row) => row.request_id)).toEqual([40]);
    }
  });
});

describe("loadChainReceipts", () => {
  it("is disabled without a contract id", async () => {
    const disabled = await loadChainReceipts(throwingFetch(), EMPTY_ENV);
    expect(disabled.state).toBe("disabled");
  });
});

describe("handleAuditExportGet", () => {
  it("JSON answers a 200 array where each entry carries the audit keys plus source", async () => {
    const res = await handleAuditExportGet(
      new Request("http://localhost/api/audit/export?format=json"),
      { fetchImpl: throwingFetch(), env: EMPTY_ENV },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);
    for (const entry of body) {
      expect(entry).toHaveProperty("request_id");
      expect(entry).toHaveProperty("verdict_signature");
      expect(entry).toHaveProperty("chain_tx");
      expect(entry).toHaveProperty("source", "fixture");
    }
  });

  it("a missing format defaults to JSON", async () => {
    const res = await handleAuditExportGet(
      new Request("http://localhost/api/audit/export"),
      { fetchImpl: throwingFetch(), env: EMPTY_ENV },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);
  });

  it("CSV answers text/csv with the source header plus 3 fixture data rows", async () => {
    const res = await handleAuditExportGet(
      new Request("http://localhost/api/audit/export?format=csv"),
      { fetchImpl: throwingFetch(), env: EMPTY_ENV },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe(RECEIPTS_CSV_HEADER);
    expect(lines[0]).toBe("request_id,status,verdict_signature,chain_tx,source");
    expect(lines[0]).toContain("request_id,status,verdict_signature,chain_tx");
    expect(lines[0]).toContain("source");
    expect(lines).toHaveLength(4);
    for (const line of lines.slice(1)) {
      expect(line.endsWith(",fixture")).toBe(true);
    }
    expect(text).not.toContain("fixture-sig-");
  });

  it("an unknown format answers 400", async () => {
    const res = await handleAuditExportGet(
      new Request("http://localhost/api/audit/export?format=xml"),
      { fetchImpl: throwingFetch(), env: EMPTY_ENV },
    );
    expect(res.status).toBe(400);
  });

  it("CSV escapes commas and quotes", () => {
    const csv = receiptsToCsv([
      {
        ...stubRow(1),
        verdict_signature: 'a,"b',
        chain_tx: "c",
        status: "paid",
        source: "stub",
      } as unknown as Parameters<typeof receiptsToCsv>[0][number],
    ]);
    expect(csv.split("\n")[0]).toBe(RECEIPTS_CSV_HEADER);
    expect(csv).toContain('"a,""b"');
  });
});

describe("receipts page probe strings (issue #63)", () => {
  it("renders agent-1 plus 3 receipt-row markers with sample data and no signatures", async () => {
    const html = renderToStaticMarkup(await ReceiptsPage());
    expect(html).toContain("<h1>Receipts</h1>");
    expect(html).toContain("agent-1");
    expect(html.match(/data-testid="receipt-row"/g)).toHaveLength(3);
    expect(html).toContain("/api/audit/export?format=json");
    expect(html).toContain("/api/audit/export?format=csv");
    expect(html).toContain("sample data");
    expect(html).not.toContain("fixture-sig-");
    expect(html).not.toContain("TEE-verified");
  });
});
