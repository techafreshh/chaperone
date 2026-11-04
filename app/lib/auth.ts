import { NextResponse } from "next/server";
import type { Env } from "./env";

// Operator wallet sessions (issue #17). Fixture-first server sessions:
// login mints an opaque httpOnly session cookie, kill/revive and verifier
// key rotation require a valid owner session (fail closed with an exact
// 401 otherwise). Live NEP-413 wallet-signature verification
// (`verifyMessage` from `near-api-js/nep413`) runs only when a signature is
// presented and live RPC is configured; otherwise the fixture branch
// applies (labeled in the login response).

export const SESSION_COOKIE = "chaperone_operator";
const SESSION_MAX_AGE = 60 * 60 * 24;

interface OperatorSession {
  account_id: string;
  owner: boolean;
  created_at: number;
}

const sessions = new Map<string, OperatorSession>();

// Test seam: drop the module-level session store.
export function __resetAuthForTests(): void {
  sessions.clear();
}

// Configured fleet owner: `GUARD_OWNER_ID` first, `NEAR_ACCOUNT_ID` as the
// operator fallback. Empty means the fixture tier (no owner/chain env), in
// which any logged-in session counts as the owner.
export function ownerEnv(env: Env = process.env): string {
  return ((env.GUARD_OWNER_ID ?? env.NEAR_ACCOUNT_ID ?? "") as string).trim();
}

// Parse the `Cookie` header into a name/value map. Never throws: malformed
// headers yield an empty map and the caller fails closed.
function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  try {
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (name !== "" && !out.has(name)) out.set(name, value);
    }
  } catch {
    // Malformed header: fail closed with whatever parsed so far.
  }
  return out;
}

// Session for the request's operator cookie, or null. Never throws.
export function getSession(request: Request): OperatorSession | null {
  try {
    const cookies = parseCookies(request.headers.get("cookie"));
    const token = cookies.get(SESSION_COOKIE);
    if (!token) return null;
    return sessions.get(token) ?? null;
  } catch {
    return null;
  }
}

// Owner gate for kill/revive/rotation routes. Returns the session on
// success, or a `NextResponse` error to return directly: exact 401
// `{"error":"login required"}` on missing/unknown session, 403
// `{"error":"not owner"}` when an owner env is set and the session account
// differs.
export function requireOwner(
  request: Request,
  deps: { env?: Env } = {},
): OperatorSession | NextResponse {
  const session = getSession(request);
  if (!session) {
    return NextResponse.json({ error: "login required" }, { status: 401 });
  }
  const owner = ownerEnv(deps.env ?? process.env);
  if (owner !== "" && session.account_id !== owner) {
    return NextResponse.json({ error: "not owner" }, { status: 403 });
  }
  return session;
}

// Tolerant body reader: JSON first, URL-encoded form fallback (same shape
// as `readBodyMap` in `./fleet`). Query params merge underneath so login
// also accepts `?account_id=...`.
async function readLoginFields(request: Request): Promise<Record<string, string>> {
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

function pickField(body: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (body[key] !== undefined) return body[key];
  }
  return undefined;
}

// Live NEP-413 branch: verify the wallet signature against the chain
// access-key lookup. Dynamic import keeps the offline/CI path free of the
// `near-api-js` bundle cost. Throws (fail closed) on any mismatch or
// transport failure.
async function verifyWalletSignature(
  fields: Record<string, string>,
  accountId: string,
  env: Env,
): Promise<void> {
  const signatureB64 = (pickField(fields, "signature") ?? "").trim();
  const publicKey = (pickField(fields, "publicKey", "public_key") ?? "").trim();
  const message = pickField(fields, "message") ?? `login:${accountId}`;
  const recipient = pickField(fields, "recipient") ?? "chaperone";
  const nonceRaw = (pickField(fields, "nonce") ?? "").trim();
  const rpcUrl =
    ((env.NEAR_RPC_URL ?? "") as string).trim() === ""
      ? "https://rpc.testnet.near.org"
      : ((env.NEAR_RPC_URL ?? "") as string).trim();
  const nep413 = (await import("near-api-js/nep413")) as {
    verifyMessage: (args: {
      signerAccountId: string;
      signerPublicKey: string;
      payload: { message: string; recipient: string; nonce: Uint8Array };
      signature: Uint8Array;
      provider: unknown;
    }) => Promise<void>;
  };
  const root = (await import("near-api-js")) as {
    JsonRpcProvider: new (args: { url: string }) => unknown;
  };
  let signature: Uint8Array;
  try {
    signature = new Uint8Array(Buffer.from(signatureB64, "base64"));
  } catch {
    throw new Error("invalid signature encoding");
  }
  let nonce: Uint8Array;
  if (nonceRaw === "") {
    nonce = new Uint8Array(Buffer.from(`login:${accountId}`, "utf8"));
  } else {
    try {
      nonce = new Uint8Array(Buffer.from(nonceRaw, "base64"));
    } catch {
      nonce = new Uint8Array(Buffer.from(nonceRaw, "utf8"));
    }
  }
  const provider = new root.JsonRpcProvider({ url: rpcUrl });
  await nep413.verifyMessage({
    signerAccountId: accountId,
    signerPublicKey: publicKey,
    payload: { message, recipient, nonce },
    signature,
    provider,
  });
}

function sessionCookieHeader(token: string): string {
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${SESSION_MAX_AGE}`
  );
}

// Login: accept `account_id`/`accountId`/`account` from JSON, form, or
// query. Empty -> 400; owner-env mismatch -> 403. A presented wallet
// signature (`signature` + `publicKey` with live RPC configured) is
// verified via NEP-413 and fails closed; otherwise the fixture branch
// mints the session directly. Answers 200
// `{ok:true, account_id, owner:true, fixture:<bool>}` with the session
// cookie set.
export async function handleLoginPost(
  request: Request,
  deps: { env?: Env } = {},
): Promise<NextResponse> {
  const env = deps.env ?? process.env;
  const fields = await readLoginFields(request);
  const accountId = (
    pickField(fields, "account_id", "accountId", "account") ?? ""
  ).trim();
  if (accountId === "") {
    return NextResponse.json(
      { error: "account_id is required" },
      { status: 400 },
    );
  }
  const owner = ownerEnv(env);
  if (owner !== "" && accountId !== owner) {
    return NextResponse.json({ error: "not owner" }, { status: 403 });
  }
  const signature = (pickField(fields, "signature") ?? "").trim();
  const publicKey = (pickField(fields, "publicKey", "public_key") ?? "").trim();
  const liveRpc = ((env.NEAR_RPC_URL ?? "") as string).trim() !== "";
  let fixture = true;
  if (signature !== "" && publicKey !== "" && liveRpc) {
    try {
      await verifyWalletSignature(fields, accountId, env);
      fixture = false;
    } catch {
      return NextResponse.json({ error: "login required" }, { status: 401 });
    }
  }
  const token = crypto.randomUUID();
  sessions.set(token, {
    account_id: accountId,
    owner: true,
    created_at: Date.now(),
  });
  const res = NextResponse.json(
    { ok: true, account_id: accountId, owner: true, fixture },
    { status: 200 },
  );
  res.headers.set("Set-Cookie", sessionCookieHeader(token));
  return res;
}

// Logout: drop the request's session (if any) and clear the cookie.
export async function handleLogoutPost(request: Request): Promise<NextResponse> {
  try {
    const cookies = parseCookies(request.headers.get("cookie"));
    const token = cookies.get(SESSION_COOKIE);
    if (token) sessions.delete(token);
  } catch {
    // Cookie parsing never blocks logout.
  }
  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.headers.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  return res;
}
