import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_QUOTE_HEX,
  FIXTURE_SIGNING_ADDRESS,
  cannedNrasResponseFail,
  fixtureReport,
} from "./fixtures.js";
import {
  ACCEPTED_TCB_STATUSES,
  replayRtmr3,
  verifyReport,
  type NormalizedQuote,
  type NrasFetchFn,
} from "./verify.js";

const NONCE = "ab".repeat(32);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function pristineQuote(nonceHex: string): Promise<NormalizedQuote> {
  const identity = Buffer.from(
    FIXTURE_SIGNING_ADDRESS.replace(/^0x/i, ""),
    "hex",
  );
  const appCompose = (
    JSON.parse(
      (fixtureReport(nonceHex).info as { tcb_info: string }).tcb_info,
    ) as { app_compose: string }
  ).app_compose;
  return {
    status: "UpToDate",
    advisoryIds: [],
    tdAttributesByte0: 0,
    reportData: Buffer.concat([
      Buffer.concat([identity, Buffer.alloc(32 - identity.length)]),
      Buffer.from(nonceHex, "hex"),
    ]),
    mrConfigId: Buffer.concat([
      Buffer.from([1]),
      createHash("sha256").update(Buffer.from(appCompose, "utf8")).digest(),
      Buffer.alloc(15),
    ]),
    rtMr3: replayRtmr3(fixtureReport(nonceHex).event_log),
  };
}

describe("replayRtmr3", () => {
  it("replays the pristine fixture log to 48 bytes", () => {
    const rtmr3 = replayRtmr3(fixtureReport(NONCE).event_log);
    expect(rtmr3).toHaveLength(48);
    expect(rtmr3.equals(Buffer.alloc(48))).toBe(false);
  });

  it("ignores non-imr-3 events", () => {
    const withBoot = replayRtmr3(fixtureReport(NONCE).event_log);
    const events = JSON.parse(fixtureReport(NONCE).event_log as string);
    const onlyImr3 = events.filter(
      (event: { imr: number }) => event.imr === 3,
    );
    expect(replayRtmr3(JSON.stringify(onlyImr3)).equals(withBoot)).toBe(true);
  });

  it("throws on a carried digest mismatch", () => {
    const events = JSON.parse(fixtureReport(NONCE).event_log as string);
    events[1].event_payload = "ff";
    expect(() => replayRtmr3(JSON.stringify(events))).toThrow(/digest mismatch/);
  });
});

describe("verifyReport", () => {
  it("accepts the canned valid fixture", async () => {
    const result = await verifyReport(fixtureReport(NONCE), NONCE);
    expect(result).toEqual({
      verified: true,
      signingAddress: FIXTURE_SIGNING_ADDRESS,
    });
    expect(FIXTURE_SIGNING_ADDRESS).toMatch(ADDRESS_RE);
  });

  it("defaults the nonce to the echoed request_nonce", async () => {
    const result = await verifyReport(fixtureReport(NONCE));
    expect(result.verified).toBe(true);
  });

  it("rejects tampered quote bytes with a reason", async () => {
    const report = fixtureReport(NONCE);
    const last = report.intel_quote.slice(-1);
    report.intel_quote = `${report.intel_quote.slice(0, -1)}${last === "e" ? "f" : "e"}`;
    expect(report.intel_quote).not.toBe(FIXTURE_QUOTE_HEX);
    const result = await verifyReport(report, NONCE);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/quote verification failed/i);
  });

  it("rejects a mutated event_log payload with a reason", async () => {
    const report = fixtureReport(NONCE);
    const events = JSON.parse(report.event_log as string);
    events[1].event_payload = "ff";
    report.event_log = JSON.stringify(events);
    const result = await verifyReport(report, NONCE);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/digest mismatch|replay|RTMR3/i);
  });

  it("rejects a replay-shifted event_log with a reason", async () => {
    const report = fixtureReport(NONCE);
    const events = JSON.parse(report.event_log as string);
    events[2].event_payload = "beef";
    report.event_log = JSON.stringify(events);
    const result = await verifyReport(report, NONCE);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/RTMR3/);
  });

  it("rejects a wrong echoed request_nonce with a reason", async () => {
    const report = fixtureReport(NONCE);
    report.request_nonce = "00".repeat(32);
    const result = await verifyReport(report, NONCE);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/echoed nonce/);
  });

  it("rejects a malformed signing_address with a reason", async () => {
    const report = fixtureReport(NONCE);
    report.signing_address = "0x1234";
    const result = await verifyReport(report, {
      nonceHex: NONCE,
      // Bypass fixture auto-detection (keyed on the fixture address) so
      // the shape check itself is exercised against a valid stub.
      verifyQuote: async () => pristineQuote(NONCE),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/signing identity/);
  });

  it("rejects an altered app_compose with a reason", async () => {
    const report = fixtureReport(NONCE);
    report.info = {
      tcb_info: JSON.stringify({ app_compose: "tampered-compose" }),
    };
    const result = await verifyReport(report, NONCE);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/MRCONFIGID/);
  });

  it("rejects an NVIDIA payload nonce mismatch without calling NRAS", async () => {
    const report = fixtureReport(NONCE);
    report.nvidia_payload = JSON.stringify({ nonce: "ff".repeat(32) });
    let calls = 0;
    const countingFetch: NrasFetchFn = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => [] };
    };
    const result = await verifyReport(report, NONCE, {
      nrasFetch: countingFetch,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/nvidia payload nonce mismatch/);
    expect(calls).toBe(0);
  });

  it("rejects a false NRAS verdict with a reason", async () => {
    const report = fixtureReport(NONCE);
    const failingFetch: NrasFetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => cannedNrasResponseFail(),
    });
    const result = await verifyReport(report, NONCE, {
      nrasFetch: failingFetch,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/nvidia attestation verdict/);
  });

  it("rejects a non-accepted TCB status with a reason", async () => {
    const result = await verifyReport(fixtureReport(NONCE), NONCE, {
      verifyQuote: async (quoteBytes: Buffer) => ({
        ...(await pristineQuote(NONCE)),
        tdAttributesByte0: 0,
        status:
          quoteBytes.toString("hex") === FIXTURE_QUOTE_HEX.toLowerCase()
            ? "OutOfDate"
            : "UpToDate",
      }),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/TCB status OutOfDate not accepted/);
    expect(ACCEPTED_TCB_STATUSES).toEqual(["UpToDate"]);
  });

  it("rejects a debug-mode quote with a reason", async () => {
    const result = await verifyReport(fixtureReport(NONCE), NONCE, {
      verifyQuote: async () => ({
        ...(await pristineQuote(NONCE)),
        tdAttributesByte0: 1,
      }),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/debug mode/);
  });
});
