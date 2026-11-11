import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import bs58 from "bs58";
import {
  __resetSettingsForTests,
  getVerifierKey,
  handleVerifierKeyPost,
} from "./settings";
import type { Env } from "./env";
import SettingsPage from "../app/settings/page";

const EMPTY_ENV: Env = {};

// Live tier: contract id set plus the operator key env the old server
// path used — the server still sends nothing.
const LIVE_ENV: Env = {
  GUARD_CONTRACT_ID: "guard.testnet",
  NEAR_ACCOUNT_ID: "owner.testnet",
  NEAR_PRIVATE_KEY: "ed25519:11un4TfVookQ35dGgFy3nxUCm7qM9yD8i2r9Jd9x9x9x9x9x9x9x9x9x9x9x9x9x9x9",
};

// Deterministic 32-byte ed25519-style public key, base58-encoded.
const GOOD_KEY = bs58.encode(Buffer.alloc(32, 7));
const SHORT_KEY = bs58.encode(Buffer.alloc(16, 1));

function rotateInit(key: string): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verifier_key: key }),
  };
}

function rotateRequest(key: string): Request {
  return new Request("http://localhost/api/settings/verifier-key", rotateInit(key));
}

beforeEach(() => {
  __resetSettingsForTests();
});

describe("verifier-key live tier", () => {
  it("live rotation answers the exact 403 and mutates no overlay", async () => {
    const res = await handleVerifierKeyPost(rotateRequest(GOOD_KEY), {
      env: LIVE_ENV,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "sign with the owner wallet" });
    await expect(getVerifierKey({ env: EMPTY_ENV })).resolves.toBeNull();
  });
});

describe("verifier-key validation", () => {
  it("rejects non-base58 keys with a 400", async () => {
    const res = await handleVerifierKeyPost(
      rotateRequest("not-a-key!!!"),
      { env: EMPTY_ENV },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid verifier key" });
  });

  it("rejects base58 keys that are not 32 bytes with a 400", async () => {
    const res = await handleVerifierKeyPost(rotateRequest(SHORT_KEY), {
      env: EMPTY_ENV,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid verifier key" });
  });

  it("32-byte base58 rotation sticks and reads back", async () => {
    const res = await handleVerifierKeyPost(rotateRequest(GOOD_KEY), {
      env: EMPTY_ENV,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, verifier_key: GOOD_KEY });
    await expect(
      getVerifierKey({ env: EMPTY_ENV }),
    ).resolves.toBe(GOOD_KEY);
  });

  it("empty key clears back to null", async () => {
    await handleVerifierKeyPost(rotateRequest(GOOD_KEY), { env: EMPTY_ENV });
    const cleared = await handleVerifierKeyPost(rotateRequest(""), {
      env: EMPTY_ENV,
    });
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
  });
});
