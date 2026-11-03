import { Wallet } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareHashes,
  fetchCompletionSignature,
  sha256HexText,
  verifyBinding,
} from "./bind.js";
import { startFixtureCloud, type StartedFixtureCloud } from "./fixture-cloud.js";

let cloud: StartedFixtureCloud | null = null;

afterEach(async () => {
  if (cloud !== null) {
    await cloud.close();
    cloud = null;
  }
});

async function judgedPair(model: string): Promise<{
  chatId: string;
  requestHash: string;
  responseHash: string;
}> {
  if (cloud === null) throw new Error("fixture cloud not started");
  const body = JSON.stringify({ model, messages: [] });
  const response = await fetch(`${cloud.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const responseText = await response.text();
  const chatId = (JSON.parse(responseText) as { id: string }).id;
  return {
    chatId,
    requestHash: sha256HexText(body),
    responseHash: sha256HexText(responseText),
  };
}

describe("compareHashes", () => {
  it("accepts the 3-part provider_tee form", () => {
    const compared = compareHashes("m:req:res", "req", "res", "m");
    expect(compared).toMatchObject({
      valid: true,
      requestHashMatch: true,
      responseHashMatch: true,
      modelIdMatch: true,
    });
  });

  it("accepts the 2-part gateway form with null model match", () => {
    const compared = compareHashes("req:res", "req", "res", "m");
    expect(compared.valid).toBe(true);
    expect(compared.modelIdMatch).toBeNull();
  });

  it("rejects a model id mismatch", () => {
    const compared = compareHashes("other:req:res", "req", "res", "m");
    expect(compared.valid).toBe(false);
    expect(compared.modelIdMatch).toBe(false);
    expect(compared.reason).toMatch(/model id mismatch/);
  });

  it("rejects a response hash mismatch", () => {
    const compared = compareHashes("m:req:bad", "req", "res", "m");
    expect(compared.valid).toBe(false);
    expect(compared.responseHashMatch).toBe(false);
    expect(compared.reason).toMatch(/response hash mismatch/);
  });

  it("rejects malformed signed text", () => {
    const compared = compareHashes("a:b:c:d", "req", "res", "m");
    expect(compared.valid).toBe(false);
    expect(compared.reason).toMatch(/2 or 3/);
  });
});

describe("verifyBinding", () => {
  it("recovers the signer case-insensitively", async () => {
    const wallet = Wallet.createRandom();
    const signature = await wallet.signMessage("hello");
    const upper = await verifyBinding({
      text: "hello",
      signature,
      expectedAddresses: [wallet.address.toUpperCase()],
    });
    expect(upper.verified).toBe(true);
    expect(upper.recoveredAddress).toBe(wallet.address);
  });

  it("refuses an unexpected signer with a reason", async () => {
    const wallet = Wallet.createRandom();
    const other = Wallet.createRandom();
    const signature = await wallet.signMessage("hello");
    const result = await verifyBinding({
      text: "hello",
      signature,
      expectedAddresses: [other.address],
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/does not match attested address/);
  });

  it("refuses an empty expected-address set", async () => {
    const result = await verifyBinding({
      text: "hello",
      signature: "0x00",
      expectedAddresses: [],
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/no attested signing address/);
  });
});

describe("fixture-cloud signature line", () => {
  it("valid pair passes hash comparison and signer recovery", async () => {
    cloud = await startFixtureCloud({ model: "bind-model" });
    const { chatId, requestHash, responseHash } = await judgedPair(
      cloud.model,
    );
    const sig = await fetchCompletionSignature({
      baseUrl: cloud.url,
      chatId,
      model: cloud.model,
      retries: 3,
      retryDelayMs: 5,
    });
    expect(sig.signing_address).toBe(cloud.walletAddress);
    expect(sig.signature_kind).toBe("provider_tee");
    const compared = compareHashes(
      sig.text,
      requestHash,
      responseHash,
      cloud.model,
    );
    expect(compared.valid).toBe(true);
    const binding = await verifyBinding({
      text: sig.text,
      signature: sig.signature,
      expectedAddresses: [cloud.walletAddress],
    });
    expect(binding.verified).toBe(true);
  });

  it("a tampered response signature refuses the verdict", async () => {
    cloud = await startFixtureCloud({
      model: "bind-model",
      tamperSignature: true,
    });
    const { chatId, requestHash, responseHash } = await judgedPair(
      cloud.model,
    );
    const sig = await fetchCompletionSignature({
      baseUrl: cloud.url,
      chatId,
      model: cloud.model,
      retries: 3,
      retryDelayMs: 5,
    });
    // The caller must not submit: hash comparison already fails.
    let submissions = 0;
    const compared = compareHashes(
      sig.text,
      requestHash,
      responseHash,
      cloud.model,
    );
    expect(compared.valid).toBe(false);
    expect(compared.reason).toMatch(/response hash mismatch/);
    if (compared.valid) submissions += 1;
    expect(submissions).toBe(0);
  });

  it("a wrong-signer fixture refuses recovery match", async () => {
    cloud = await startFixtureCloud({ model: "bind-model", wrongSigner: true });
    const { chatId, requestHash, responseHash } = await judgedPair(
      cloud.model,
    );
    const sig = await fetchCompletionSignature({
      baseUrl: cloud.url,
      chatId,
      model: cloud.model,
      retries: 3,
      retryDelayMs: 5,
    });
    expect(
      compareHashes(sig.text, requestHash, responseHash, cloud.model).valid,
    ).toBe(true);
    const binding = await verifyBinding({
      text: sig.text,
      signature: sig.signature,
      expectedAddresses: [cloud.walletAddress],
    });
    expect(binding.verified).toBe(false);
    expect(binding.reason).toMatch(/does not match/);
  });

  it("retries transient 404s before serving the signature", async () => {
    cloud = await startFixtureCloud({ model: "bind-model", flaky404: 2 });
    const { chatId } = await judgedPair(cloud.model);
    const sig = await fetchCompletionSignature({
      baseUrl: cloud.url,
      chatId,
      model: cloud.model,
      retries: 5,
      retryDelayMs: 5,
    });
    expect(sig.text).toContain(cloud.model);
    expect(cloud.signatureHits()).toBeGreaterThanOrEqual(3);
  });

  it("gives up after exhausting retries on unknown chat ids", async () => {
    cloud = await startFixtureCloud({ model: "bind-model" });
    await expect(
      fetchCompletionSignature({
        baseUrl: cloud.url,
        chatId: "chatcmpl-unknown",
        model: cloud.model,
        retries: 2,
        retryDelayMs: 5,
      }),
    ).rejects.toThrow(/status 404/);
  });
});
