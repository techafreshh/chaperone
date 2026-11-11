import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { capToYocto } from "./books";
import {
  __resetFleetOverlayForTests,
  formatYoctoToNear,
  getFleetState,
  handleAgentsPatch,
  handleAgentsPost,
  setAgentActive,
} from "./fleet";
import type { Env } from "./env";
import { POST as killPost } from "../app/api/agents/[id]/kill/route";
import { POST as revivePost } from "../app/api/agents/[id]/revive/route";

const EMPTY_ENV: Env = {};

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  __resetFleetOverlayForTests();
});

describe("formatYoctoToNear", () => {
  it("round-trips 30 NEAR through capToYocto", () => {
    expect(formatYoctoToNear(capToYocto("30"))).toBe("30");
  });

  it("formats fractional and treasury values exactly", () => {
    expect(formatYoctoToNear(capToYocto("0.5"))).toBe("0.5");
    expect(formatYoctoToNear("125000000000000000000000000")).toBe("125");
    expect(formatYoctoToNear("20000000000000000000000000")).toBe("20");
  });
});

describe("getFleetState merge rule", () => {
  it("chain active:false forces frozen over an active mirror row", async () => {
    const mirrorRows = [
      {
        agent_id: "agent-3",
        allowance_yocto: "50000000000000000000000000",
        cap_yocto: "10000000000000000000000000",
        active: true,
        spent_today_yocto: "0",
        remaining_today_yocto: "50000000000000000000000000",
      },
    ];
    const chainAgents = [
      {
        agent_id: "agent-3",
        daily_allowance_yocto: "50000000000000000000000000",
        per_payment_cap_yocto: "10000000000000000000000000",
        active: false,
        spent_today_yocto: "0",
        remaining_today_yocto: "50000000000000000000000000",
      },
    ];
    const rpcOk = (payload: unknown) => {
      const bytes = Array.from(Buffer.from(JSON.stringify(payload), "utf8"));
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { result: bytes } }),
        text: async () => "",
      } as unknown as Response;
    };
    const impl = (async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).includes("/rest/v1/agents")) {
        return {
          ok: true,
          status: 200,
          json: async () => mirrorRows,
          text: async () => JSON.stringify(mirrorRows),
        } as unknown as Response;
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const method = (JSON.parse(bodyText) as { params?: { method_name?: string } })
        .params?.method_name;
      if (method === "list_agents") return rpcOk(chainAgents);
      if (method === "treasury") return rpcOk("125000000000000000000000000");
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const env: Env = {
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_KEY: "service-key",
      GUARD_CONTRACT_ID: "guard.testnet",
      NEAR_RPC_URL: "https://rpc.testnet.near.org",
    };
    const state = await getFleetState({ fetchImpl: impl, env });
    expect(state.agents.find((agent) => agent.agent_id === "agent-3")?.active).toBe(
      false,
    );
  });
});

describe("getFleetState stub file tier", () => {
  it("FLEET_STUB_FILE agents overlay the fixture values", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-"));
    const file = path.join(dir, "stub.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        agents: [
          {
            agent_id: "agent-1",
            allowance_yocto: capToYocto("999"),
            cap_yocto: capToYocto("10"),
            active: true,
            spent_today_yocto: "0",
            remaining_today_yocto: capToYocto("999"),
          },
          {
            agent_id: "agent-2",
            allowance_yocto: capToYocto("50"),
            cap_yocto: capToYocto("10"),
            active: true,
            spent_today_yocto: "0",
            remaining_today_yocto: capToYocto("50"),
          },
          {
            agent_id: "agent-3",
            allowance_yocto: capToYocto("50"),
            cap_yocto: capToYocto("10"),
            active: false,
            spent_today_yocto: "0",
            remaining_today_yocto: capToYocto("50"),
          },
          {
            agent_id: "agent-4",
            allowance_yocto: capToYocto("50"),
            cap_yocto: capToYocto("10"),
            active: true,
            spent_today_yocto: "0",
            remaining_today_yocto: capToYocto("50"),
          },
        ],
        treasury_yocto: capToYocto("200"),
      }),
    );
    const state = await getFleetState({
      fetchImpl: throwingFetch(),
      env: { FLEET_STUB_FILE: file },
    });
    expect(state.agents).toHaveLength(4);
    expect(
      state.agents.find((agent) => agent.agent_id === "agent-1")?.allowance_yocto,
    ).toBe(capToYocto("999"));
    expect(state.treasuryYocto).toBe(capToYocto("200"));
  });
});

describe("handleAgentsPost overlay round-trip", () => {
  it("POST agent-5 returns 200 and the next getFleetState contains agent-5", async () => {
    const res = await handleAgentsPost(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "agent-5" }),
      }),
      { fetchImpl: throwingFetch(), env: EMPTY_ENV },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; agent_id: string };
    expect(body.ok).toBe(true);
    expect(body.agent_id).toBe("agent-5");

    const state = await getFleetState({ fetchImpl: throwingFetch(), env: EMPTY_ENV });
    expect(state.agents.some((agent) => agent.agent_id === "agent-5")).toBe(true);
  });
});

describe("live tier owner-write gate", () => {
  const LIVE_ENV: Env = {
    GUARD_CONTRACT_ID: "guard.testnet",
    NEAR_ACCOUNT_ID: "owner.testnet",
    NEAR_PRIVATE_KEY:
      "ed25519:11un4TfVookQ35dGgFy3nxUCm7qM9yD8i2r9Jd9x9x9x9x9x9x9x9x9x9x9x9x9x9x9",
  };

  it("agents POST answers the exact 403 and mutates no overlay", async () => {
    const res = await handleAgentsPost(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "agent-9" }),
      }),
      { fetchImpl: throwingFetch(), env: LIVE_ENV },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "sign with the owner wallet",
    });
    const state = await getFleetState({
      fetchImpl: throwingFetch(),
      env: LIVE_ENV,
    });
    expect(state.agents.some((agent) => agent.agent_id === "agent-9")).toBe(
      false,
    );
  });

  it("agents PATCH answers the exact 403", async () => {
    const res = await handleAgentsPatch(
      new Request("http://localhost/api/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "agent-1" }),
      }),
      { fetchImpl: throwingFetch(), env: LIVE_ENV },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "sign with the owner wallet",
    });
  });

  it("kill/revive answer the exact 403 and mutate no overlay", async () => {
    const savedContract = process.env.GUARD_CONTRACT_ID;
    const savedAccount = process.env.NEAR_ACCOUNT_ID;
    const savedKey = process.env.NEAR_PRIVATE_KEY;
    process.env.GUARD_CONTRACT_ID = "guard.testnet";
    process.env.NEAR_ACCOUNT_ID = "owner.testnet";
    process.env.NEAR_PRIVATE_KEY = LIVE_ENV.NEAR_PRIVATE_KEY as string;
    try {
      const killed = await killPost(
        new Request("http://localhost/api/agents/agent-1/kill", {
          method: "POST",
        }),
        { params: Promise.resolve({ id: "agent-1" }) },
      );
      expect(killed.status).toBe(403);
      expect(await killed.json()).toEqual({
        error: "sign with the owner wallet",
      });
      const revived = await revivePost(
        new Request("http://localhost/api/agents/agent-1/revive", {
          method: "POST",
        }),
        { params: Promise.resolve({ id: "agent-1" }) },
      );
      expect(revived.status).toBe(403);
      expect(await revived.json()).toEqual({
        error: "sign with the owner wallet",
      });
      const state = await getFleetState({
        fetchImpl: throwingFetch(),
        env: LIVE_ENV,
      });
      expect(
        state.agents.find((agent) => agent.agent_id === "agent-1")?.active,
      ).toBe(true);
    } finally {
      if (savedContract === undefined) delete process.env.GUARD_CONTRACT_ID;
      else process.env.GUARD_CONTRACT_ID = savedContract;
      if (savedAccount === undefined) delete process.env.NEAR_ACCOUNT_ID;
      else process.env.NEAR_ACCOUNT_ID = savedAccount;
      if (savedKey === undefined) delete process.env.NEAR_PRIVATE_KEY;
      else process.env.NEAR_PRIVATE_KEY = savedKey;
    }
  });
});

describe("chain-wins merge", () => {
  it("chain active:true overrides inactive mirror/stub/overlay rows", async () => {
    // Seed an inactive overlay row for agent-2, then prove the chain view
    // (active:true) still wins and the page never renders it frozen.
    await setAgentActive("agent-2", false, {
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    const mirrorRows = [
      {
        agent_id: "agent-2",
        allowance_yocto: "50000000000000000000000000",
        cap_yocto: "10000000000000000000000000",
        active: false,
        spent_today_yocto: "0",
        remaining_today_yocto: "50000000000000000000000000",
      },
    ];
    const chainAgents = [
      {
        agent_id: "agent-2",
        daily_allowance_yocto: "50000000000000000000000000",
        per_payment_cap_yocto: "10000000000000000000000000",
        active: true,
        spent_today_yocto: "0",
        remaining_today_yocto: "50000000000000000000000000",
      },
    ];
    const rpcOk = (payload: unknown) => {
      const bytes = Array.from(Buffer.from(JSON.stringify(payload), "utf8"));
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { result: bytes } }),
        text: async () => "",
      } as unknown as Response;
    };
    const impl = (async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).includes("/rest/v1/agents")) {
        return {
          ok: true,
          status: 200,
          json: async () => mirrorRows,
          text: async () => JSON.stringify(mirrorRows),
        } as unknown as Response;
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      const method = (JSON.parse(bodyText) as { params?: { method_name?: string } })
        .params?.method_name;
      if (method === "list_agents") return rpcOk(chainAgents);
      if (method === "treasury") return rpcOk("125000000000000000000000000");
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const env: Env = {
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_KEY: "service-key",
      GUARD_CONTRACT_ID: "guard.testnet",
      NEAR_RPC_URL: "https://rpc.testnet.near.org",
    };
    const state = await getFleetState({ fetchImpl: impl, env });
    // The overlay is ignored on the live tier, and the chain view wins:
    // agent-2 must read active even though every other tier says frozen.
    expect(
      state.agents.find((agent) => agent.agent_id === "agent-2")?.active,
    ).toBe(true);
  });
});

describe("fixture kill/revive round-trip", () => {
  it("kill flips agent-1 to frozen and revive flips it back", async () => {
    const killed = await killPost(
      new Request("http://localhost/api/agents/agent-1/kill", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );
    expect(killed.status).toBe(200);
    expect(await killed.json()).toEqual({ active: false });
    const frozen = await getFleetState({
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    expect(
      frozen.agents.find((agent) => agent.agent_id === "agent-1")?.active,
    ).toBe(false);
    const revived = await revivePost(
      new Request("http://localhost/api/agents/agent-1/revive", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );
    expect(revived.status).toBe(200);
    expect(await revived.json()).toEqual({ active: true });
    const active = await getFleetState({
      fetchImpl: throwingFetch(),
      env: EMPTY_ENV,
    });
    expect(
      active.agents.find((agent) => agent.agent_id === "agent-1")?.active,
    ).toBe(true);
  });

  it("kill of an unknown agent is a 404", async () => {
    const res = await killPost(
      new Request("http://localhost/api/agents/nope/kill", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown agent" });
  });
});

describe("getFleetState disabled mirror", () => {
  it("no creds yields fixture agents instead of throwing", async () => {
    const state = await getFleetState({ fetchImpl: throwingFetch(), env: EMPTY_ENV });
    expect(state.agents.map((agent) => agent.agent_id)).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
    ]);
  });
});

describe("getFleetState fixture zero-spent baseline (issue #48)", () => {
  it("agent-1 reads zero spent with a 25 NEAR request fitting remaining", async () => {
    const state = await getFleetState({ fetchImpl: throwingFetch(), env: EMPTY_ENV });
    const agent1 = state.agents.find((agent) => agent.agent_id === "agent-1");
    expect(agent1).toBeDefined();
    expect(agent1?.spent_today_yocto).toBe("0");
    expect(agent1?.remaining_today_yocto).toBe(agent1?.allowance_yocto);
    expect(BigInt(agent1?.remaining_today_yocto ?? "0")).toBeGreaterThanOrEqual(
      BigInt(capToYocto("25")),
    );
    for (const agent of state.agents) {
      const allowance = BigInt(agent.allowance_yocto);
      const spent = BigInt(agent.spent_today_yocto);
      const expected = allowance >= spent ? allowance - spent : BigInt(0);
      expect(BigInt(agent.remaining_today_yocto)).toBe(expected);
    }
  });
});
