import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetAuthForTests,
  handleLoginPost,
  handleLogoutPost,
  requireOwner,
  SESSION_COOKIE,
} from "./auth";
import type { Env } from "./env";
import {
  __resetFleetOverlayForTests,
  getFleetState,
} from "./fleet";
import { POST as killPost } from "../app/api/agents/[id]/kill/route";
import { POST as revivePost } from "../app/api/agents/[id]/revive/route";

const EMPTY_ENV: Env = {};

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch;
}

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(SESSION_COOKIE);
  const token = setCookie.split(";")[0]?.split("=")[1] ?? "";
  expect(token).not.toBe("");
  return `${SESSION_COOKIE}=${token}`;
}

function authed(url: string, cookie: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), cookie },
  });
}

beforeEach(() => {
  __resetAuthForTests();
  __resetFleetOverlayForTests();
  delete process.env.GUARD_OWNER_ID;
  delete process.env.NEAR_ACCOUNT_ID;
});

describe("requireOwner gating", () => {
  it("unauthenticated kill fails closed with the exact 401 body", async () => {
    const res = await killPost(
      new Request("http://localhost/api/agents/agent-1/kill", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "login required" });
  });

  it("unknown bearer token fails closed with the exact 401 body", async () => {
    const gated = requireOwner(
      new Request("http://localhost/api/agents/agent-1/kill", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=bogus` },
      }),
      { env: EMPTY_ENV },
    );
    expect(gated).not.toBeNull();
    if (gated instanceof Response) {
      expect(gated.status).toBe(401);
      expect(await gated.json()).toEqual({ error: "login required" });
    } else {
      throw new Error("expected a 401 response");
    }
  });
});

describe("fixture login", () => {
  it("JSON account_id mints a session cookie", async () => {
    const res = await handleLoginPost(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: "owner.testnet" }),
      }),
      { env: EMPTY_ENV },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.account_id).toBe("owner.testnet");
    expect(body.fixture).toBe(true);
    sessionCookieFrom(res);
  });

  it("query-string login works without a body", async () => {
    const res = await handleLoginPost(
      new Request("http://localhost/api/auth/login?account_id=owner.testnet", {
        method: "GET",
      }),
      { env: EMPTY_ENV },
    );
    expect(res.status).toBe(200);
    sessionCookieFrom(res);
  });

  it("empty account_id is a 400", async () => {
    const res = await handleLoginPost(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { env: EMPTY_ENV },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "account_id is required" });
  });

  it("owner-env mismatch is a 403", async () => {
    const res = await handleLoginPost(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: "mallory.testnet" }),
      }),
      { env: { GUARD_OWNER_ID: "owner.testnet" } },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not owner" });
  });
});

describe("owner kill/revive round-trip", () => {
  async function loginCookie(): Promise<string> {
    const res = await handleLoginPost(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: "owner.testnet" }),
      }),
      { env: EMPTY_ENV },
    );
    return sessionCookieFrom(res);
  }

  it("owner kill flips agent-1 to frozen and revive flips it back", async () => {
    const cookie = await loginCookie();
    const killed = await killPost(
      authed("http://localhost/api/agents/agent-1/kill", cookie, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );
    expect(killed.status).toBe(200);
    expect(await killed.json()).toEqual({ active: false });

    const frozen = await getFleetState({ fetchImpl: throwingFetch(), env: EMPTY_ENV });
    expect(
      frozen.agents.find((agent) => agent.agent_id === "agent-1")?.active,
    ).toBe(false);

    const revived = await revivePost(
      authed("http://localhost/api/agents/agent-1/revive", cookie, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );
    expect(revived.status).toBe(200);
    expect(await revived.json()).toEqual({ active: true });

    const active = await getFleetState({ fetchImpl: throwingFetch(), env: EMPTY_ENV });
    expect(
      active.agents.find((agent) => agent.agent_id === "agent-1")?.active,
    ).toBe(true);
  });

  it("authed kill of an unknown agent is a 404", async () => {
    const cookie = await loginCookie();
    const res = await killPost(
      authed("http://localhost/api/agents/nope/kill", cookie, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown agent" });
  });

  it("logout clears the session so the next kill fails closed", async () => {
    const cookie = await loginCookie();
    const out = await handleLogoutPost(
      authed("http://localhost/api/auth/logout", cookie, { method: "POST" }),
    );
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });

    const res = await killPost(
      authed("http://localhost/api/agents/agent-1/kill", cookie, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "login required" });
  });
});
