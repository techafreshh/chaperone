// Receipts waterfall + audit-pack export data layer (issue #16). Merges
// paid requests from four read tiers — labeled fixture, stub file
// (`RECEIPTS_STUB_FILE` then `REQUESTS_STUB_FILE`), Supabase mirror
// (`requests` with `status=eq.paid`), live chain `list_requests` — and
// serves both the HTML waterfall (`/receipts`) and the JSON/CSV audit
// pack (`/api/audit/export`) from the same merged view.
//
// Yocto amounts stay decimal strings end-to-end. `verdict_signature` and
// `chain_tx` are always emitted per entry; when no source provides them
// the value is `""` (honest absence, never a synthesized id). Fixture
// rows carry no signature strings (issue #63): their signature/tx fields
// stay `""` and the pages render `sample data` instead.

import { NextResponse } from "next/server";
import fs from "node:fs";
import { getMirrorStatus } from "./supabase";
import type { Env } from "./env";

export type ReceiptSource = "chain" | "mirror" | "stub" | "fixture";

export function isReceiptSource(value: unknown): value is ReceiptSource {
  return (
    value === "chain" ||
    value === "mirror" ||
    value === "stub" ||
    value === "fixture"
  );
}

export interface ReceiptRow {
  request_id: number;
  agent_id: string;
  payee: string;
  amount_yocto: string;
  purpose_ref: string;
  vendor: string;
  status: string;
  reason?: string | null;
  verdict_signature: string;
  chain_tx: string;
  source: ReceiptSource;
}

export const RECEIPTS_STUB_FILE = "RECEIPTS_STUB_FILE";
export const REQUESTS_STUB_FILE_KEY = "REQUESTS_STUB_FILE";

export const RECEIPTS_CSV_HEADER =
  "request_id,status,verdict_signature,chain_tx,source";

// On-chain payout vocabulary (mirrors `contract/src/request.rs`): the
// waterfall and audit pack stay paid-only, but the normalizer
// understands the in-flight and bounced states so `paying` (transfer in
// flight) and `failed` (bounced transfer, reason `TransferFailed`) rows
// pass through to consumers instead of being mangled or dropped.
export const STATUS_PAID = "paid";
export const STATUS_PAYING = "paying";
export const STATUS_FAILED = "failed";

// Fixture tier (issue #63 sample data, never live evidence): exactly 3
// paid rows for `agent-1` (ids 7-9, chosen to avoid colliding with the
// #14 fixture ids 1-3 and the #15 queue fixture ids 5-6). Signature/tx
// fields stay `""` (honest absence) so no fixture row claims a live
// signature; the pages and CSV label them `sample data` / `fixture`.
export const FIXTURE_RECEIPTS: ReceiptRow[] = [
  {
    request_id: 9,
    agent_id: "agent-1",
    payee: "coreweave.near",
    amount_yocto: "3000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "paid",
    reason: null,
    verdict_signature: "",
    chain_tx: "",
    source: "fixture",
  },
  {
    request_id: 8,
    agent_id: "agent-1",
    payee: "coreweave.near",
    amount_yocto: "2000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "paid",
    reason: null,
    verdict_signature: "",
    chain_tx: "",
    source: "fixture",
  },
  {
    request_id: 7,
    agent_id: "agent-1",
    payee: "coreweave.near",
    amount_yocto: "1000000000000000000000000",
    purpose_ref: "invoice-114",
    vendor: "CoreWeave",
    status: "paid",
    reason: null,
    verdict_signature: "",
    chain_tx: "",
    source: "fixture",
  },
];

function normalizeReceiptId(value: unknown): number | null {
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
  if (typeof value === "bigint" && value >= 0) {
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

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

// Coerces `request_id` from number/numeric-string, defaults `status`,
// resolves `verdict_signature` from
// `verdict_signature|signature|signature_base58` and `chain_tx` from
// `chain_tx|tx_hash|transaction_hash|txHash` with `""` fallback — keys
// always present, values never synthesized. Null when the row carries no
// usable id or agent.
export function normalizeReceiptRow(
  raw: Record<string, unknown>,
): ReceiptRow | null {
  const request_id = normalizeReceiptId(
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
    verdict_signature:
      firstString(raw, ["verdict_signature", "signature", "signature_base58"]) ??
      "",
    chain_tx:
      firstString(raw, ["chain_tx", "tx_hash", "transaction_hash", "txHash"]) ??
      "",
    source: isReceiptSource(raw.source) ? raw.source : "fixture",
  };
}

// File-injected tier for harnesses: `RECEIPTS_STUB_FILE` first, then
// `REQUESTS_STUB_FILE` (forward-compat with the #14 convention). Accepts
// a bare array or a `{ requests: [...] }` / `{ receipts: [...] }` object;
// `request_id` normalizes from number or numeric string. Null on
// unset/unreadable/malformed (fall through, never throw).
export function loadStubReceipts(
  env: Env = process.env,
): ReceiptRow[] | null {
  for (const key of [RECEIPTS_STUB_FILE, REQUESTS_STUB_FILE_KEY]) {
    const path = (env[key] ?? "").trim();
    if (path === "") continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
      const record =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const list = Array.isArray(parsed)
        ? parsed
        : (record?.requests ?? record?.receipts);
      if (!Array.isArray(list)) continue;
      const rows = (list as unknown[])
        .map((item) =>
          item !== null && typeof item === "object"
            ? normalizeReceiptRow(item as Record<string, unknown>)
            : null,
        )
        .filter((row): row is ReceiptRow => row !== null)
        .map((row) => ({ ...row, source: "stub" as const }))
        .sort((a, b) => b.request_id - a.request_id);
      return rows;
    } catch {
      continue;
    }
  }
  return null;
}

export type MirrorReceiptsResult =
  | { state: "disabled"; reason: string }
  | { state: "ready"; receipts: ReceiptRow[] }
  | { state: "unavailable"; reason: string };

// Mirror `requests` reader filtered to paid rows. Same PostgREST header
// shape (`apikey` + `Bearer`) and column names as the #12 migration;
// labeled `disabled` without creds, labeled `unavailable` on transport
// failure — never throws. The PostgREST `status=eq.paid` filter is backed
// by a client-side paid check so an unfiltered mirror still yields a
// paid-only waterfall.
export async function loadMirrorReceipts(
  fetchImpl: typeof fetch = fetch,
  env: Env = process.env,
): Promise<MirrorReceiptsResult> {
  const status = getMirrorStatus(env);
  if (status.state === "disabled") {
    return { state: "disabled", reason: status.reason };
  }
  const serviceKey = env.SUPABASE_SERVICE_KEY as string;
  const endpoint =
    `${status.url}/rest/v1/requests` +
    `?select=*&status=eq.${STATUS_PAID}&order=request_id.desc`;
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
      reason: `mirror receipts failed: ${err instanceof Error ? err.message : String(err)}`,
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
      reason: `mirror receipts failed: GET requests -> ${res.status} ${excerpt}`,
    };
  }
  let rows: unknown;
  try {
    rows = await res.json();
  } catch (err) {
    return {
      state: "unavailable",
      reason: `mirror receipts failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(rows)) return { state: "ready", receipts: [] };
  const receipts = (rows as unknown[])
    .map((item) =>
      item !== null && typeof item === "object"
        ? normalizeReceiptRow(item as Record<string, unknown>)
        : null,
    )
    .filter((row): row is ReceiptRow => row !== null)
    .filter((row) => row.status === STATUS_PAID)
    .map((row) => ({ ...row, source: "mirror" as const }));
  return { state: "ready", receipts };
}

async function rpcCallReceipts(
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
      id: `chaperone-receipts-${methodName}`,
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

export type ChainReceiptsResult =
  | { state: "disabled"; reason: string }
  | { state: "unavailable"; reason: string }
  | { state: "ready"; receipts: ReceiptRow[] };

// Chain reader using only global `fetch` (no new dependency). Queries the
// `list_requests` view (paginated `offset`/`limit` args) and normalizes
// both string and `{U128}` yocto shapes. Chain rows carry no
// signature/tx columns, so those stay `""` (honest absence). Labeled
// `disabled` without a contract id, labeled `unavailable` on any failure
// — never throws, so the page still renders from mirror/stub/fixture.
export async function loadChainReceipts(
  fetchImpl: typeof fetch = fetch,
  env: Env = process.env,
): Promise<ChainReceiptsResult> {
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
    raw = await rpcCallReceipts(fetchImpl, rpcUrl, contractId, "list_requests", {
      offset: 0,
      limit: 100,
    });
  } catch {
    return { state: "unavailable", reason: "chain receipts unreachable" };
  }
  if (!Array.isArray(raw)) {
    return { state: "unavailable", reason: "chain receipts unreachable" };
  }
  const receipts = (raw as unknown[])
    .map((item) =>
      item !== null && typeof item === "object"
        ? normalizeReceiptRow(item as Record<string, unknown>)
        : null,
    )
    .filter((row): row is ReceiptRow => row !== null)
    .filter((row) => row.status === STATUS_PAID)
    .map((row) => ({ ...row, source: "chain" as const }));
  return { state: "ready", receipts };
}

// Merged receipts view: stub, then mirror rows, then chain rows, unioned
// by `request_id` (chain wins over mirror over stub, per-row
// replacement), kept paid-only and sorted newest-first. The fixture tier
// is fallback-only: it is used solely when no higher tier produced any
// paid row, so an injecting harness always sees exactly its own rows.
export async function getReceipts(
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<ReceiptRow[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const merged = new Map<number, ReceiptRow>();

  const stub = loadStubReceipts(env);
  if (stub !== null) {
    for (const row of stub) {
      merged.set(row.request_id, { ...row, source: "stub" as const });
    }
  }
  try {
    const mirror = await loadMirrorReceipts(fetchImpl, env);
    if (mirror.state === "ready") {
      for (const row of mirror.receipts) {
        merged.set(row.request_id, { ...row, source: "mirror" as const });
      }
    }
  } catch {
    // Mirror disabled or unreachable: file tiers still render.
  }
  try {
    const chain = await loadChainReceipts(fetchImpl, env);
    if (chain.state === "ready") {
      for (const row of chain.receipts) {
        merged.set(row.request_id, { ...row, source: "chain" as const });
      }
    }
  } catch {
    // Chain unreachable: file tiers still render.
  }

  const paid = [...merged.values()]
    .filter((row) => row.status === STATUS_PAID)
    .sort((a, b) => b.request_id - a.request_id);
  if (paid.length > 0) return paid;
  return [...FIXTURE_RECEIPTS].sort((a, b) => b.request_id - a.request_id);
}

function csvEscape(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function receiptsToCsv(rows: ReceiptRow[]): string {
  const lines = [RECEIPTS_CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        String(row.request_id),
        row.status,
        row.verdict_signature,
        row.chain_tx,
        (row as { source?: unknown }).source ?? "fixture",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

// Shared `GET /api/audit/export` handler: `format=json` (or absent)
// answers 200 with the full receipt objects (each carrying `source`);
// `format=csv` answers 200 `text/csv` with the 5-column audit header
// (`request_id,status,verdict_signature,chain_tx,source`) plus one row per
// receipt; any other `format` answers 400.
export async function handleAuditExportGet(
  request: Request,
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<NextResponse> {
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      { error: `unsupported format: ${format}` },
      { status: 400 },
    );
  }
  const receipts = await getReceipts(deps);
  if (format === "csv") {
    return new NextResponse(receiptsToCsv(receipts), {
      status: 200,
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="audit-pack.csv"',
      },
    });
  }
  return NextResponse.json(receipts, { status: 200 });
}
