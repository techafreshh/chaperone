import { describe, expect, it } from "vitest";
import { fetchAttestationStatus } from "./attestation-client";

function okResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

describe("fetchAttestationStatus", () => {
  it("falls back to deterministic-only when the verifier is down", async () => {
    const failing = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchAttestationStatus(failing)).resolves.toEqual({
      badge: "deterministic-only",
    });
  });

  it("falls back on non-ok responses", async () => {
    const down = (async () =>
      ({ ok: false, status: 502 }) as unknown as Response) as unknown as typeof fetch;
    await expect(
      fetchAttestationStatus(down, "http://127.0.0.1:9/attestation/status"),
    ).resolves.toEqual({ badge: "deterministic-only" });
  });

  it("falls back on malformed bodies", async () => {
    const malformed = (async () => okResponse({ badge: "bogus" })) as unknown as typeof fetch;
    await expect(fetchAttestationStatus(malformed)).resolves.toEqual({
      badge: "deterministic-only",
    });
  });

  it("passes valid badge states through", async () => {
    for (const badge of ["verified", "unverifiable", "deterministic-only"]) {
      const fetchImpl = (async () =>
        okResponse({ badge, details: {} })) as unknown as typeof fetch;
      await expect(fetchAttestationStatus(fetchImpl)).resolves.toEqual({
        badge,
        details: {},
      });
    }
  });
});
