import { describe, expect, it } from "vitest";
import { isLiveTier, liveWriteBlocked } from "./guard";
import type { Env } from "./env";

describe("live-tier write gate", () => {
  it("is fixture tier without a contract id", () => {
    expect(isLiveTier({})).toBe(false);
    const env: Env = { GUARD_CONTRACT_ID: "  ", NEAR_CONTRACT_ID: "" };
    expect(isLiveTier(env)).toBe(false);
  });

  it("is live tier with either contract id env", () => {
    expect(isLiveTier({ GUARD_CONTRACT_ID: "guard.testnet" })).toBe(true);
    expect(isLiveTier({ NEAR_CONTRACT_ID: " guard.testnet " })).toBe(true);
  });

  it("blocked body is exactly the wallet-sign error", async () => {
    const res = liveWriteBlocked();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "sign with the owner wallet" });
  });
});
