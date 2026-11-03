import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startFixtureCloud, type StartedFixtureCloud } from "./fixture-cloud.js";
import {
  buildJudgePrompt,
  extractChatId,
  judgeModel,
  parseConsistent,
} from "./judge.js";

const REQUEST = {
  request_id: 5,
  agent_id: "agent.near",
  payee: "payee.near",
  amount_yocto: `5${"0".repeat(24)}`,
  purpose_ref: "invoice-114",
  vendor: "CoreWeave",
  reason: null,
};

let cloud: StartedFixtureCloud | null = null;

afterEach(async () => {
  if (cloud !== null) {
    await cloud.close();
    cloud = null;
  }
});

describe("buildJudgePrompt", () => {
  it("names vendor, amount, purpose-ref, and the stated reason", () => {
    const messages = buildJudgePrompt(REQUEST);
    const joined = messages.map((m) => m.content).join("\n");
    expect(joined).toContain("CoreWeave");
    expect(joined).toContain("invoice-114");
    expect(joined).toContain(REQUEST.amount_yocto);
    expect(joined).toContain("payee.near");
    expect(joined).toMatch(/single JSON|exactly one JSON/i);
  });

  it("falls back to a purpose-ref reason when none is stored", () => {
    const messages = buildJudgePrompt({ ...REQUEST, reason: null });
    expect(messages[1]?.content).toContain("invoice-114");
  });
});

describe("parseConsistent", () => {
  it("parses a direct JSON verdict", () => {
    expect(parseConsistent('{"consistent": true}')).toEqual({
      consistent: true,
    });
  });

  it("parses fenced and embedded verdicts with objections", () => {
    expect(
      parseConsistent(
        '```json\n{"consistent": false, "objection": "payee mismatch"}\n```',
      ),
    ).toEqual({ consistent: false, objection: "payee mismatch" });
    expect(
      parseConsistent('verdict: {"consistent": true} done'),
    ).toEqual({ consistent: true });
  });

  it("refuses non-JSON output", () => {
    expect(parseConsistent("this is not a judgment object")).toEqual({});
    expect(parseConsistent(undefined)).toEqual({});
  });
});

describe("extractChatId", () => {
  it("reads plain JSON ids", () => {
    expect(extractChatId('{"id":"chatcmpl-1","choices":[]}')).toBe(
      "chatcmpl-1",
    );
    expect(extractChatId('{"choices":[]}')).toBeNull();
  });
});

describe("judgeModel against the fixture cloud", () => {
  it("returns a consistent verdict with byte-identical hashes", async () => {
    cloud = await startFixtureCloud({ model: "judge-model" });
    const result = await judgeModel({
      baseUrl: cloud.url,
      model: cloud.model,
      request: REQUEST,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consistent).toBe(true);
    expect(result.chatId.startsWith("chatcmpl-fixture-")).toBe(true);
    // Exact-bytes hashing: recomputation over the retained strings matches.
    expect(result.requestHash).toBe(
      createHash("sha256").update(result.requestText, "utf8").digest("hex"),
    );
    expect(result.responseHash).toBe(
      createHash("sha256").update(result.responseText, "utf8").digest("hex"),
    );
    expect(result.model).toBe("judge-model");
  });

  it("returns an inconsistent verdict with the objection", async () => {
    cloud = await startFixtureCloud({
      model: "judge-model",
      consistent: false,
      objection: "payee is not on the purpose-ref allowlist",
    });
    const result = await judgeModel({
      baseUrl: cloud.url,
      model: cloud.model,
      request: REQUEST,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consistent).toBe(false);
    expect(result.objection).toContain("allowlist");
  });

  it("refuses malformed model output", async () => {
    cloud = await startFixtureCloud({ malformedContent: true });
    const result = await judgeModel({
      baseUrl: cloud.url,
      model: cloud.model,
      request: REQUEST,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not a JSON consistency verdict/);
    expect(result.transportError).not.toBe(true);
  });

  it("maps transport failures to transportError", async () => {
    const result = await judgeModel({
      baseUrl: cloud?.url ?? "http://127.0.0.1:1",
      model: "judge-model",
      request: REQUEST,
      fetchImpl: (async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.transportError).toBe(true);
    expect(result.reason).toMatch(/boom/);
  });

  it("requires a model", async () => {
    cloud = await startFixtureCloud();
    const result = await judgeModel({
      baseUrl: cloud.url,
      model: "",
      request: REQUEST,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/model is required/);
  });
});
