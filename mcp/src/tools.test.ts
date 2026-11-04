// Acceptance vectors for the MCP guard tools (fixture-only, no network).
import { describe, expect, it } from "vitest";
import {
  amountNearToYocto,
  attestations,
  createFixtureAdapter,
  pending,
  policyGet,
  requestPayment,
  type ToolDeps,
} from "./tools.js";

function deps(): ToolDeps {
  // Fresh fixture per test: no shared state, no env, no network.
  return { env: {}, adapter: createFixtureAdapter() };
}

describe("policy_get", () => {
  it("returns daily_allowance_yocto and active for agent-1", async () => {
    const result = await policyGet({ agent_id: "agent-1" }, deps());
    expect(result.isError).toBeUndefined();
    const body = result.structuredContent as Record<string, unknown>;
    expect(typeof body.daily_allowance_yocto).toBe("string");
    expect(body.daily_allowance_yocto).toBe("50000000000000000000000000");
    expect(body.active).toBe(true);
  });

  it("defaults to agent-1 when agent_id is omitted", async () => {
    const result = await policyGet({}, deps());
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as Record<string, unknown>).agent_id).toBe(
      "agent-1",
    );
  });

  it("isError naming an unknown agent", async () => {
    const result = await policyGet({ agent_id: "ghost" }, deps());
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("ghost");
  });
});

describe("request_payment", () => {
  it("rejects the over-cap vector with the verbatim on-chain reason", async () => {
    const result = await requestPayment(
      {
        payee: "x.near",
        amount_near: "400",
        purpose_ref: "invoice-114",
        vendor: "X",
      },
      deps(),
    );
    expect(result.isError).toBeUndefined();
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.status).toBe("rejected");
    expect(body.reason).toBe("ExceedsPerPaymentCap");
  });

  it("stages a clean small request", async () => {
    const result = await requestPayment(
      {
        payee: "good.near",
        amount_near: "0.5",
        purpose_ref: "invoice-114",
        vendor: "CoreWeave",
      },
      deps(),
    );
    expect(result.isError).toBeUndefined();
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.status).toBe("staged");
    expect(body.request_id).toBe(7);
  });
});

describe("pending", () => {
  it("lists held request 6 with a non-empty objection", async () => {
    const result = await pending({}, deps());
    expect(result.isError).toBeUndefined();
    const body = result.structuredContent as {
      pending: { request_id: number; objection: string }[];
    };
    const row = body.pending.find((entry) => entry.request_id === 6);
    expect(row).toBeDefined();
    expect(typeof row?.objection).toBe("string");
    expect((row?.objection as string).length).toBeGreaterThan(0);
  });
});

describe("attestations", () => {
  it("returns badge plus details for request 5", async () => {
    const result = await attestations({ request_id: 5 }, deps());
    expect(result.isError).toBeUndefined();
    const body = result.structuredContent as Record<string, unknown>;
    expect(typeof body.badge).toBe("string");
    expect(body.signing_address ?? body.details).toBeDefined();
    expect(String(body.signing_address ?? body.details).length).toBeGreaterThan(0);
  });

  it("isError for an unknown request id", async () => {
    const result = await attestations({ request_id: 999 }, deps());
    expect(result.isError).toBe(true);
  });
});

describe("amount_near conversion", () => {
  it("converts 0.5 to exact yocto", async () => {
    expect(amountNearToYocto("0.5")).toBe("500000000000000000000000");
  });
});
