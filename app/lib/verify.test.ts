import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetEvidenceBundlesForTests,
  getEvidenceBundle,
} from "../../verifier/src/server";
import {
  handleEvidenceGet,
  resetVerifyStack,
} from "./verify";

beforeEach(() => {
  resetVerifyStack();
  __resetEvidenceBundlesForTests();
});

describe("handleEvidenceGet (issue #66)", () => {
  it("returns 400 for non-positive-integer ids", async () => {
    for (const bad of ["5", 0, -1, 1.5, null, undefined]) {
      const result = await handleEvidenceGet(bad);
      expect(result.status).toBe(400);
    }
  });

  it("returns 404 for unjudged ids", async () => {
    const missing = await handleEvidenceGet(5);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: "evidence not found",
    });
    const unknown = await handleEvidenceGet(99);
    expect(unknown.status).toBe(404);
  });

  it("serves the judged bundle after POST /verify judges it", async () => {
    const { handleVerifyPost } = await import("./verify");
    const judged = await handleVerifyPost(
      new Request("http://localhost/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: 5 }),
      }),
    );
    expect(judged.status).toBe(200);
    const stored = getEvidenceBundle(5);
    expect(stored).not.toBeNull();
    const result = await handleEvidenceGet(5);
    expect(result.status).toBe(200);
    const bundle = (await result.json()) as Record<string, unknown>;
    expect(Object.keys(bundle).sort()).toEqual([
      "chat_id",
      "filtered",
      "fixture",
      "model",
      "preflight_nonce",
      "request_sha256",
      "response_sha256",
      "signature",
      "signing_address",
    ]);
    expect(bundle).toEqual(stored);
  });
});
