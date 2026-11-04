import { NextResponse } from "next/server";
import bs58 from "bs58";
import { requireOwner } from "./auth";
import type { Env } from "./env";

// Verifier-key rotation store (issue #17). The operator-visible key is an
// in-process overlay (plus the chain `get_verifier` view when live creds
// exist) so the next `GET /settings` in the same server process reflects a
// rotation. Only rotation writes are owner-gated; reads stay public.

// Overlay holds the operator's latest rotation (`null` = cleared, mirrors
// the contract `set_verifier(None)`); `undefined` = no rotation yet.
let overlay: string | null | undefined;

// Test seam: drop the module-level overlay.
export function __resetSettingsForTests(): void {
  overlay = undefined;
}

async function rpcGetVerifier(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  contractId: string,
): Promise<string | null> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "chaperone-settings-get-verifier",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: "get_verifier",
        args_base64: Buffer.from("{}").toString("base64"),
      },
    }),
  });
  if (!res.ok) throw new Error(`rpc get_verifier -> ${res.status}`);
  const json = (await res.json()) as {
    result?: { result?: unknown };
  };
  const byteArray = json?.result?.result;
  if (!Array.isArray(byteArray)) throw new Error("rpc get_verifier bad shape");
  const decoded: unknown = JSON.parse(Buffer.from(byteArray).toString("utf8"));
  return typeof decoded === "string" ? decoded : null;
}

// Effective verifier key: chain `get_verifier` when a contract id is set
// (plain-`fetch` reader in the `loadChainState` style, never throws), then
// the rotation overlay, else null.
export async function getVerifierKey(
  deps: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const contractId = (
    env.GUARD_CONTRACT_ID ??
    env.NEAR_CONTRACT_ID ??
    ""
  ).trim();
  if (contractId !== "") {
    const rpcUrl =
      ((env.NEAR_RPC_URL ?? "") as string).trim() === ""
        ? "https://rpc.testnet.near.org"
        : ((env.NEAR_RPC_URL ?? "") as string).trim();
    try {
      const chainKey = await rpcGetVerifier(fetchImpl, rpcUrl, contractId);
      if (chainKey !== null) return chainKey;
    } catch {
      // Chain unreachable: fall through to the overlay, never throw.
    }
  }
  if (overlay !== undefined) return overlay;
  return null;
}

async function readKeyFields(request: Request): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  try {
    const url = new URL(request.url);
    url.searchParams.forEach((value, key) => {
      merged[key] = value;
    });
  } catch {
    // Relative URL in tests: no query to merge.
  }
  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return merged;
  }
  if (raw.trim() === "") return merged;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        merged[key] =
          typeof value === "string"
            ? value
            : value === null || value === undefined
              ? ""
              : typeof value === "number" || typeof value === "boolean"
                ? String(value)
                : JSON.stringify(value);
      }
      return merged;
    }
  } catch {
    // Not JSON: fall through to form parsing below.
  }
  try {
    const params = new URLSearchParams(raw);
    let any = false;
    params.forEach((value, key) => {
      any = true;
      merged[key] = value;
    });
    if (any) return merged;
  } catch {
    // Ignore malformed bodies.
  }
  return merged;
}

// Owner-gated verifier-key rotation: missing/unknown session fails closed
// with the exact 401. Accepts `verifier_key`/`verifierKey`/`key`; an empty
// value clears the key to null (mirrors `set_verifier(None)`); non-empty
// values must base58-decode to exactly 32 bytes per
// `contract/src/verifier.rs` (`decode_verifier_key`), else 400.
export async function handleVerifierKeyPost(
  request: Request,
  deps: { env?: Env } = {},
): Promise<NextResponse> {
  const env = deps.env ?? process.env;
  const auth = requireOwner(request, { env });
  if (auth instanceof NextResponse) return auth;
  const fields = await readKeyFields(request);
  const raw =
    fields.verifier_key ?? fields.verifierKey ?? fields.key;
  if (raw === undefined) {
    return NextResponse.json(
      { error: "verifier_key is required" },
      { status: 400 },
    );
  }
  const key = raw.trim();
  if (key === "") {
    overlay = null;
    return NextResponse.json({ ok: true, verifier_key: null }, { status: 200 });
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(key);
  } catch {
    return NextResponse.json(
      { error: "invalid verifier key" },
      { status: 400 },
    );
  }
  if (decoded.length !== 32) {
    return NextResponse.json(
      { error: "invalid verifier key" },
      { status: 400 },
    );
  }
  overlay = key;
  return NextResponse.json({ ok: true, verifier_key: key }, { status: 200 });
}
