import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import bs58 from "bs58";
import { __resetAuthForTests, handleLoginPost, SESSION_COOKIE } from "./auth";
import {
  __resetSettingsForTests,
  getVerifierKey,
  handleVerifierKeyPost,
} from "./settings";
import SettingsPage from "../app/settings/page";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

// Deterministic 32-byte ed25519-style public key, base58-encoded.
const GOOD_KEY = bs58.encode(Buffer.alloc(32, 7));
const SHORT_KEY = bs58.encode(Buffer.alloc(16, 1));

async function loginCookie(): Promise<string> {
  const res = await handleLoginPost(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: "owner.testnet" }),
    }),
    { env: EMPTY_ENV },
  );
  const setCookie = res.headers.get("set-cookie") ?? "";
  const token = setCookie.split(";")[0]?.split("=")[1] ?? "";
  return `${SESSION_COOKIE}=${token}`;
}

function authed(url: string, cookie: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), cookie },
  });
}

function rotateInit(key: string): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verifier_key: key }),
  };
}

beforeEach(() => {
  __resetAuthForTests();
  __resetSettingsForTests();
  delete process.env.GUARD_OWNER_ID;
  delete process.env.NEAR_ACCOUNT_ID;
  delete process.env.GUARD_CONTRACT_ID;
});

describe("verifier-key rotation gating", () => {
  it("unauthenticated rotation fails closed with the exact 401 body", async () => {
    const res = await handleVerifierKeyPost(
      new Request("http://localhost/api/settings/verifier-key", rotateInit(GOOD_KEY)),
      { env: EMPTY_ENV },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "login required" });
  });

  it("non-owner rotation is a 403 when an owner env is set", async () => {
    const cookie = await loginCookie();
    const res = await handleVerifierKeyPost(
      authed(
        "http://localhost/api/settings/verifier-key",
        cookie,
        rotateInit(GOOD_KEY),
      ),
      { env: { GUARD_OWNER_ID: "someone-else.testnet" } as NodeJS.ProcessEnv },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not owner" });
  });
});

describe("verifier-key validation", () => {
  it("rejects non-base58 keys with a 400", async () => {
    const cookie = await loginCookie();
    const res = await handleVerifierKeyPost(
      authed(
        "http://localhost/api/settings/verifier-key",
        cookie,
        rotateInit("not-a-key!!!"),
      ),
      { env: EMPTY_ENV },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid verifier key" });
  });

  it("rejects base58 keys that are not 32 bytes with a 400", async () => {
    const cookie = await loginCookie();
    const res = await handleVerifierKeyPost(
      authed(
        "http://localhost/api/settings/verifier-key",
        cookie,
        rotateInit(SHORT_KEY),
      ),
      { env: EMPTY_ENV },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid verifier key" });
  });

  it("32-byte base58 rotation sticks and reads back", async () => {
    const cookie = await loginCookie();
    const res = await handleVerifierKeyPost(
      authed(
        "http://localhost/api/settings/verifier-key",
        cookie,
        rotateInit(GOOD_KEY),
      ),
      { env: EMPTY_ENV },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, verifier_key: GOOD_KEY });
    await expect(
      getVerifierKey({ env: EMPTY_ENV }),
    ).resolves.toBe(GOOD_KEY);
  });

  it("empty key clears back to null", async () => {
    const cookie = await loginCookie();
    await handleVerifierKeyPost(
      authed(
        "http://localhost/api/settings/verifier-key",
        cookie,
        rotateInit(GOOD_KEY),
      ),
      { env: EMPTY_ENV },
    );
    const cleared = await handleVerifierKeyPost(
      authed(
        "http://localhost/api/settings/verifier-key",
        cookie,
        rotateInit(""),
      ),
      { env: EMPTY_ENV },
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true, verifier_key: null });
    await expect(getVerifierKey({ env: EMPTY_ENV })).resolves.toBeNull();
  });
});

describe("settings page markup", () => {
  it("static markup contains the verifier copy and badge preview", async () => {
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain("verifier");
    expect(html).toContain("badge-preview");
    expect(html).toContain("Settings");
    expect(html).toContain("verifier_key");
    expect(html).toContain("account_id");
  });
});
