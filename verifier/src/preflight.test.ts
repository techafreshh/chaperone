import { afterEach, describe, expect, it } from "vitest";
import { fixtureReport } from "./fixtures.js";
import {
  getLastVerified,
  getStatus,
  resetLastVerified,
  runPreflight,
} from "./preflight.js";
import type { NrasFetchFn } from "./verify.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^[0-9a-f]{64}$/;

const savedApiKey = process.env.NEAR_AI_API_KEY;
const savedModel = process.env.NEAR_AI_MODEL;

afterEach(() => {
  resetLastVerified();
  if (savedApiKey === undefined) delete process.env.NEAR_AI_API_KEY;
  else process.env.NEAR_AI_API_KEY = savedApiKey;
  if (savedModel === undefined) delete process.env.NEAR_AI_MODEL;
  else process.env.NEAR_AI_MODEL = savedModel;
});

const cannedNrasFetch: NrasFetchFn = async () => ({
  ok: true,
  status: 200,
  json: async () => (await import("./fixtures.js")).cannedNrasResponse(),
});

// Live-mode upstream mock: answers with a gateway + model candidate built
// around the nonce the client actually sent, capturing request URLs.
function mockUpstream(captured: string[], tamper?: (body: any) => void) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    captured.push(url);
    const nonce = new URL(url).searchParams.get("nonce") ?? "";
    const body = {
      gateway_attestation: fixtureReport(nonce),
      model_attestations: [fixtureReport(nonce)],
    };
    tamper?.(body);
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  };
}

describe("runPreflight fixture mode", () => {
  it("returns verified:true with a 42-char signing address", async () => {
    const result = await runPreflight({ apiKey: "", model: "qwen3-30b" });
    expect(result.verified).toBe(true);
    expect(result.signing_address).toMatch(ADDRESS_RE);
    expect(result.request_nonce).toMatch(NONCE_RE);
    expect(result.model).toBe("qwen3-30b");
    expect(result.fixture).toBe(true);
  });

  it("uses fresh nonces per call", async () => {
    const first = await runPreflight({ apiKey: "" });
    const second = await runPreflight({ apiKey: "" });
    expect(first.request_nonce).toMatch(NONCE_RE);
    expect(second.request_nonce).toMatch(NONCE_RE);
    expect(first.request_nonce).not.toBe(second.request_nonce);
  });

  it("falls back to the fixture model sentinel without a configured model", async () => {
    delete process.env.NEAR_AI_MODEL;
    const result = await runPreflight({ apiKey: "" });
    expect(result.verified).toBe(true);
    expect(result.model).toBe("fixture-model");
  });

  it("records fixture results as un-verifiable badge state", async () => {
    await runPreflight({ apiKey: "", model: "qwen3-30b" });
    expect(getLastVerified()?.verified).toBe(true);
    const status = getStatus();
    expect(status.badge).toBe("unverifiable");
    expect(status.details.fixture).toBe(true);
  });
});

describe("runPreflight live mode (mocked upstream)", () => {
  it("echoes the sent nonce and keeps nonces fresh across calls", async () => {
    const captured: string[] = [];
    const first = await runPreflight({
      apiKey: "test-key",
      model: "qwen3-30b",
      fetchImpl: mockUpstream(captured) as unknown as typeof fetch,
      nrasFetch: cannedNrasFetch,
    });
    const second = await runPreflight({
      apiKey: "test-key",
      model: "qwen3-30b",
      fetchImpl: mockUpstream(captured) as unknown as typeof fetch,
      nrasFetch: cannedNrasFetch,
    });
    expect(captured).toHaveLength(2);
    const sentNonces = captured.map(
      (url) => new URL(url).searchParams.get("nonce") ?? "",
    );
    expect(sentNonces[0]).toMatch(NONCE_RE);
    expect(sentNonces[1]).toMatch(NONCE_RE);
    expect(sentNonces[0]).not.toBe(sentNonces[1]);
    expect(first.request_nonce).toBe(sentNonces[0]);
    expect(second.request_nonce).toBe(sentNonces[1]);
    for (const result of [first, second]) {
      expect(result.verified).toBe(true);
      expect(result.signing_address).toMatch(ADDRESS_RE);
      expect(result.fixture).toBe(false);
      expect(result.model).toBe("qwen3-30b");
    }
    const request = new URL(captured[0]);
    expect(request.searchParams.get("provider")).toBe("near");
    expect(request.searchParams.get("signing_algo")).toBe("ecdsa");
    expect(request.searchParams.get("model")).toBe("qwen3-30b");
  });

  it("sends the aliasing-suppression header", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: any) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      const nonce =
        new URL(String(input)).searchParams.get("nonce") ?? "00".repeat(32);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          gateway_attestation: fixtureReport(nonce),
          model_attestations: [fixtureReport(nonce)],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await runPreflight({
      apiKey: "test-key",
      model: "qwen3-30b",
      fetchImpl,
      nrasFetch: cannedNrasFetch,
    });
    expect(seen[0]?.["x-no-aliasing"]).toBe("true");
  });

  it("rejects tampered upstream quotes with a reason", async () => {
    const result = await runPreflight({
      apiKey: "test-key",
      model: "qwen3-30b",
      fetchImpl: mockUpstream([], (body) => {
        body.gateway_attestation.intel_quote =
          `ff${body.gateway_attestation.intel_quote.slice(2)}`;
      }) as unknown as typeof fetch,
      nrasFetch: cannedNrasFetch,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(getLastVerified()?.verified).toBe(false);
    expect(getStatus().badge).toBe("unverifiable");
  });

  it("marks live success as verified badge state", async () => {
    const captured: string[] = [];
    await runPreflight({
      apiKey: "test-key",
      model: "qwen3-30b",
      fetchImpl: mockUpstream(captured) as unknown as typeof fetch,
      nrasFetch: cannedNrasFetch,
    });
    expect(getStatus().badge).toBe("verified");
  });

  it("maps transport errors to transportError without touching the store", async () => {
    const failing = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const result = await runPreflight({
      apiKey: "test-key",
      model: "qwen3-30b",
      fetchImpl: failing,
    });
    expect(result.verified).toBe(false);
    expect(result.transportError).toBe(true);
    expect(result.reason).toMatch(/boom/);
    expect(getLastVerified()).toBeNull();
    expect(getStatus().badge).toBe("deterministic-only");
  });

  it("requires a model for live preflight", async () => {
    delete process.env.NEAR_AI_MODEL;
    const result = await runPreflight({ apiKey: "test-key" });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/model is required/);
  });
});
