import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixtureCloud, type StartedFixtureCloud } from "./fixture-cloud.js";
import {
  getLastVerified,
  getStatus,
  resetLastVerified,
} from "./preflight.js";
import {
  buildVerdictPayload,
  createVerifyHandler,
  createVerifyStack,
  InMemoryChain,
  resolveVerifierKeys,
  type ChainAdapter,
  type VerifyStack,
} from "./server.js";

const FIVE_NEAR = `5${"0".repeat(24)}`;
const ENV_KEYS = [
  "NEAR_AI_API_KEY",
  "NEAR_AI_MODEL",
  "NEAR_AI_CLOUD_BASE_URL",
  "VERIFY_TAMPER",
  "FIXTURE_TAMPER",
  "VERIFIER_SIGNING_KEY",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let cloud: StartedFixtureCloud | null = null;
let stacks: VerifyStack[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetLastVerified();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key] as string;
  }
  resetLastVerified();
  stacks = [];
  if (cloud !== null) {
    await cloud.close();
    cloud = null;
  }
});

function track(stack: VerifyStack): VerifyStack {
  stacks.push(stack);
  return stack;
}

// Wrap an InMemoryChain counting submitVerdict calls (must stay zero on
// refusal paths).
function spyAdapter(inner: InMemoryChain): {
  adapter: ChainAdapter;
  submissions: Array<{ id: number; consistent: boolean; sig: string }>;
} {
  const submissions: Array<{ id: number; consistent: boolean; sig: string }> =
    [];
  return {
    submissions,
    adapter: {
      getRequest: (id) => inner.getRequest(id),
      submitVerdict: async (id, consistent, sig) => {
        submissions.push({ id, consistent, sig });
        return inner.submitVerdict(id, consistent, sig);
      },
    },
  };
}

describe("buildVerdictPayload", () => {
  it("is byte-identical to the contract canonical payload", () => {
    const payload = buildVerdictPayload(
      {
        request_id: 1,
        agent_id: "agent.near",
        payee: "payee.near",
        amount_yocto: FIVE_NEAR,
        purpose_ref: "invoice-114",
        vendor: "CoreWeave",
        status: "staged",
        reason: null,
      },
      true,
    );
    const expected = Buffer.concat([
      Buffer.from("chaperone-verdict-v1", "utf8"),
      (() => {
        const id = Buffer.alloc(8);
        id.writeBigUInt64LE(1n);
        return id;
      })(),
      Buffer.from("agent.near", "utf8"),
      Buffer.from("payee.near", "utf8"),
      (() => {
        const amount = Buffer.alloc(16);
        const value = BigInt(FIVE_NEAR);
        amount.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
        amount.writeBigUInt64LE((value >> 64n) & 0xffffffffffffffffn, 8);
        return amount;
      })(),
      Buffer.from("invoice-114", "utf8"),
      Buffer.from([1]),
    ]);
    expect(payload.equals(expected)).toBe(true);
    expect(payload.length).toBe(20 + 8 + 10 + 10 + 16 + 11 + 1);
    expect(payload.subarray(0, 20).toString("utf8")).toBe(
      "chaperone-verdict-v1",
    );
    expect(payload[payload.length - 1]).toBe(1);
  });

  it("differs by the trailing verdict byte only", () => {
    const base = {
      request_id: 1,
      agent_id: "agent.near",
      payee: "payee.near",
      amount_yocto: FIVE_NEAR,
      purpose_ref: "invoice-114",
      vendor: "CoreWeave",
      status: "staged",
      reason: null,
    };
    const yes = buildVerdictPayload(base, true);
    const no = buildVerdictPayload(base, false);
    expect(yes.subarray(0, yes.length - 1).equals(no.subarray(0, no.length - 1))).toBe(true);
    expect(no[no.length - 1]).toBe(0);
  });
});

describe("createVerifyHandler local fixture path", () => {
  it("pays staged request 5 with the acceptance shape", async () => {
    const stack = track(createVerifyStack());
    const result = await stack.handle({ request_id: 5 });
    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual([
      "consistent",
      "request_id",
      "signature",
    ]);
    expect(result.body).toMatchObject({ consistent: true, request_id: 5 });
    expect(typeof result.body.signature).toBe("string");
    // Base58 Ed25519 signature, 64 bytes on decode.
    expect(
      Buffer.from(bs58.decode(result.body.signature as string)).length,
    ).toBe(64);
    const stored = await stack.chain.getRequest(5);
    expect(stored?.status).toBe("paid");
  });

  it("never maps a fixture verdict to badge verified", async () => {
    const stack = track(createVerifyStack());
    const result = await stack.handle({ request_id: 5 });
    expect(result.status).toBe(200);
    expect(getLastVerified()?.verified).toBe(true);
    expect(getStatus().badge).toBe("unverifiable");
    expect(getStatus().badge).not.toBe("verified");
    // ...while still exposing a non-empty details string.
    const details = getStatus().details as Record<string, unknown>;
    const strings = Object.values(details).filter(
      (value): value is string => typeof value === "string",
    );
    expect(strings.some((value) => value.length > 0)).toBe(true);
  });

  it("rejects unknown requests with 404", async () => {
    const stack = track(createVerifyStack());
    const result = await stack.handle({ request_id: 99 });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: "Request not found" });
  });

  it("rejects non-staged re-verification with 409", async () => {
    const stack = track(createVerifyStack());
    expect((await stack.handle({ request_id: 5 })).status).toBe(200);
    const again = await stack.handle({ request_id: 5 });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      error: "Request is not staged",
      request_id: 5,
      status: "paid",
    });
  });

  it("rejects invalid request ids with 400", async () => {
    const stack = track(createVerifyStack());
    for (const bad of ["5", 0, -1, 1.5, null, undefined]) {
      const result = await stack.handle({ request_id: bad });
      expect(result.status).toBe(400);
    }
  });

  it("exposes the stored request through view", async () => {
    const stack = track(createVerifyStack());
    const before = await stack.handle.view(5);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ request_id: 5, status: "staged" });
    expect((await stack.handle({ request_id: 5 })).status).toBe(200);
    const after = await stack.handle.view(5);
    expect(after.body).toMatchObject({ request_id: 5, status: "paid" });
    expect((await stack.handle.view(99)).status).toBe(404);
  });

  it("maps a throwing chain read to 502 JSON on view", async () => {
    const failing: ChainAdapter = {
      async getRequest() {
        throw new Error("live chain reads are not implemented");
      },
      async submitVerdict() {
        throw new Error("unreachable");
      },
    };
    const handle = createVerifyHandler({
      chain: failing,
      resolvedKeys: resolveVerifierKeys(),
    });
    const result = await handle.view(5);
    expect(result.status).toBe(502);
    expect(typeof (result.body as Record<string, unknown>).error).toBe(
      "string",
    );
  });

  it("signs with VERIFIER_SIGNING_KEY when configured", async () => {
    const configured = resolveVerifierKeys();
    process.env.VERIFIER_SIGNING_KEY = Buffer.from(
      randomBytes(32),
    ).toString("base64");
    const stack = track(createVerifyStack());
    void configured;
    const result = await stack.handle({ request_id: 5 });
    expect(result.status).toBe(200);
    expect(
      Buffer.from(bs58.decode(result.body.signature as string)).length,
    ).toBe(64);
    expect(stack.keys.testKey).toBe(false);
  });
});

describe("createVerifyHandler HTTP path via fixture cloud", () => {
  it("binds, signs, and submits a consistent judgment", async () => {
    cloud = await startFixtureCloud({ model: "verify-model" });
    const keys = resolveVerifierKeys();
    const inner = new InMemoryChain({
      verifierPublicKey: keys.publicKeyBytes,
    });
    const { adapter, submissions } = spyAdapter(inner);
    const handle = createVerifyHandler({
      chain: adapter,
      resolvedKeys: keys,
      cloudBaseUrl: cloud.url,
      model: cloud.model,
      expectedAddresses: [cloud.walletAddress],
    });
    const result = await handle({ request_id: 5 });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ consistent: true, request_id: 5 });
    expect(submissions).toHaveLength(1);
    expect((await inner.getRequest(5))?.status).toBe("paid");
  });

  it("holds on an inconsistent judgment", async () => {
    cloud = await startFixtureCloud({
      model: "verify-model",
      consistent: false,
    });
    const keys = resolveVerifierKeys();
    const inner = new InMemoryChain({
      verifierPublicKey: keys.publicKeyBytes,
    });
    const handle = createVerifyHandler({
      chain: inner,
      resolvedKeys: keys,
      cloudBaseUrl: cloud.url,
      model: cloud.model,
      expectedAddresses: [cloud.walletAddress],
    });
    const result = await handle({ request_id: 5 });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ consistent: false, request_id: 5 });
    expect((await inner.getRequest(5))?.status).toBe("held");
  });

  it("refuses a tampered response signature without submitting", async () => {
    cloud = await startFixtureCloud({
      model: "verify-model",
      tamperSignature: true,
    });
    const keys = resolveVerifierKeys();
    const inner = new InMemoryChain({
      verifierPublicKey: keys.publicKeyBytes,
    });
    const { adapter, submissions } = spyAdapter(inner);
    const handle = createVerifyHandler({
      chain: adapter,
      resolvedKeys: keys,
      cloudBaseUrl: cloud.url,
      model: cloud.model,
      expectedAddresses: [cloud.walletAddress],
    });
    const result = await handle({ request_id: 5 });
    expect(result.status).toBe(502);
    expect(String(result.body.error)).toMatch(/response hash mismatch/);
    expect(submissions).toHaveLength(0);
    expect((await inner.getRequest(5))?.status).toBe("staged");
  });

  it("refuses a wrong-signer fixture without submitting", async () => {
    cloud = await startFixtureCloud({
      model: "verify-model",
      wrongSigner: true,
    });
    const keys = resolveVerifierKeys();
    const inner = new InMemoryChain({
      verifierPublicKey: keys.publicKeyBytes,
    });
    const { adapter, submissions } = spyAdapter(inner);
    const handle = createVerifyHandler({
      chain: adapter,
      resolvedKeys: keys,
      cloudBaseUrl: cloud.url,
      model: cloud.model,
      expectedAddresses: [cloud.walletAddress],
    });
    const result = await handle({ request_id: 5 });
    expect(result.status).toBe(502);
    expect(String(result.body.error)).toMatch(/does not match/);
    expect(submissions).toHaveLength(0);
    expect((await inner.getRequest(5))?.status).toBe("staged");
  });
});

describe("broken signer badge state", () => {
  it("records unverifiable with a non-empty reason", async () => {
    const stack = track(createVerifyStack());
    const result = await stack.handle({
      request_id: 5,
      tamper: "wrong-signer",
    });
    expect(result.status).toBe(502);
    const status = getStatus();
    expect(status.badge).toBe("unverifiable");
    const details = status.details as { reason?: unknown };
    expect(typeof details.reason).toBe("string");
    expect((details.reason as string).length).toBeGreaterThan(0);
  });

  it("honors the VERIFY_TAMPER env trigger", async () => {
    process.env.VERIFY_TAMPER = "bad-signature";
    const stack = track(createVerifyStack());
    const result = await stack.handle({ request_id: 5 });
    expect(result.status).toBe(502);
    expect(getStatus().badge).toBe("unverifiable");
    expect(
      ((getStatus().details as { reason?: string }).reason ?? "").length,
    ).toBeGreaterThan(0);
  });
});
