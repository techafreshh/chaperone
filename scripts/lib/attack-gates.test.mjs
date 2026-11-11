import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GATE_DEFS,
  SUITE_DEFAULTS,
  buildVerdictPayload,
  formatGateLine,
  gatePrefix,
  isAlreadyRegisteredMessage,
  resolveGuardId,
  txHashOf,
  waitForRequestStatus,
} from "./attack-gates.mjs";

const ONE_NEAR = 1_000_000_000_000_000_000_000_000n;

describe("resolveGuardId", () => {
  it("prefers --contract over GUARD_CONTRACT_ID over NEAR_CONTRACT_ID", () => {
    const env = { GUARD_CONTRACT_ID: "guard.env", NEAR_CONTRACT_ID: "legacy.env" };
    assert.equal(resolveGuardId(env, "flag.guard"), "flag.guard");
    assert.equal(resolveGuardId(env, undefined), "guard.env");
    assert.equal(resolveGuardId({ NEAR_CONTRACT_ID: "legacy.env" }, undefined), "legacy.env");
  });

  it("throws when every source is empty", () => {
    assert.throws(() => resolveGuardId({}, undefined), /Missing guard contract id/);
    assert.throws(() => resolveGuardId({ GUARD_CONTRACT_ID: "  " }, undefined), /Missing guard/);
    assert.throws(() => resolveGuardId({}, ""), /Missing guard/);
  });
});

describe("gate line contract", () => {
  it("pins the four exact acceptance prefixes", () => {
    const prefixes = GATE_DEFS.map(gatePrefix);
    assert.deepEqual(prefixes, [
      "GATE over-allowance: BLOCKED",
      "GATE allowlist: BLOCKED",
      "GATE purpose-mismatch: HELD",
      "GATE clean-transit: PAID",
    ]);
  });

  it("emits request_id= and tx= on one line", () => {
    for (const def of GATE_DEFS) {
      const line = formatGateLine(def, { requestId: 12, tx: "AbC123" });
      assert.ok(line.startsWith(gatePrefix(def)), line);
      assert.ok(line.includes("request_id=12"), line);
      assert.ok(line.includes("tx=AbC123"), line);
      assert.equal(line.split("\n").length, 1);
    }
  });

  it("appends verdict_tx and attestation extras for held/paid lines", () => {
    const held = GATE_DEFS.find((def) => def.key === "purpose-mismatch");
    const line = formatGateLine(held, {
      requestId: 3,
      tx: "stage-tx",
      verdictTx: "verdict-tx",
      extra: "attestation=verifier:ABC sig:DEF",
    });
    assert.ok(line.includes("verdict_tx=verdict-tx"), line);
    assert.ok(line.includes("attestation=verifier:ABC sig:DEF"), line);
    assert.ok(line.startsWith("GATE purpose-mismatch: HELD"), line);
  });
});

describe("txHashOf", () => {
  it("reads FinalExecutionOutcome transaction_outcome.id first", () => {
    assert.equal(txHashOf({ transaction_outcome: { id: "aaa" }, transaction: { hash: "bbb" } }), "aaa");
  });

  it("falls back to transaction.hash", () => {
    assert.equal(txHashOf({ transaction: { hash: "bbb" }, hash: "ccc" }), "bbb");
  });

  it("falls back to a bare hash", () => {
    assert.equal(txHashOf({ hash: "ccc" }), "ccc");
  });

  it("throws when no hash is present", () => {
    assert.throws(() => txHashOf({}), /transaction hash/);
    assert.throws(() => txHashOf(null), /transaction hash/);
  });
});

describe("buildVerdictPayload", () => {
  // Mirrors the `canonical_payload_is_byte_stable` vector in
  // `contract/src/verifier.rs`: 5 NEAR, invoice-114, consistent.
  function stableRequest() {
    return {
      request_id: 1,
      agent_id: "agent.near",
      payee: "payee.near",
      amount_yocto: (5n * ONE_NEAR).toString(),
      purpose_ref: "invoice-114",
    };
  }

  function expectedVector(consistent) {
    const parts = [];
    parts.push(Buffer.from("chaperone-verdict-v1", "utf8"));
    const id = Buffer.alloc(8);
    id.writeBigUInt64LE(1n);
    parts.push(id);
    parts.push(Buffer.from("agent.near", "utf8"));
    parts.push(Buffer.from("payee.near", "utf8"));
    const amount = Buffer.alloc(16);
    amount.writeBigUInt64LE((5n * ONE_NEAR) & 0xffffffffffffffffn, 0);
    amount.writeBigUInt64LE(((5n * ONE_NEAR) >> 64n) & 0xffffffffffffffffn, 8);
    parts.push(amount);
    parts.push(Buffer.from("invoice-114", "utf8"));
    parts.push(Buffer.from([consistent ? 1 : 0]));
    return Buffer.concat(parts);
  }

  it("matches the contract byte-stability vector", () => {
    const payload = buildVerdictPayload(stableRequest(), true);
    assert.deepEqual(Buffer.from(payload), expectedVector(true));
    assert.equal(payload.length, 20 + 8 + 10 + 10 + 16 + 11 + 1);
    assert.deepEqual(Array.from(payload.slice(0, 20)), Array.from(Buffer.from("chaperone-verdict-v1")));
    assert.equal(payload[payload.length - 1], 1);
  });

  it("differs between consistent/inconsistent only in the trailing byte", () => {
    const yes = buildVerdictPayload(stableRequest(), true);
    const no = buildVerdictPayload(stableRequest(), false);
    assert.equal(yes.length, no.length);
    assert.deepEqual(yes.slice(0, yes.length - 1), no.slice(0, no.length - 1));
    assert.equal(yes[yes.length - 1], 1);
    assert.equal(no[no.length - 1], 0);
  });

  it("rejects malformed requests and out-of-range amounts", () => {
    assert.throws(() => buildVerdictPayload({ ...stableRequest(), request_id: 0 }, true), /request_id/);
    assert.throws(() => buildVerdictPayload({ ...stableRequest(), agent_id: "" }, true), /agent_id/);
    assert.throws(() => buildVerdictPayload({ ...stableRequest(), amount_yocto: "12.5" }, true), /amount_yocto/);
    assert.throws(
      () => buildVerdictPayload({ ...stableRequest(), amount_yocto: (1n << 128n).toString() }, true),
      /out of range/,
    );
  });
});

describe("waitForRequestStatus", () => {
  it("returns the record once a wanted status appears", async () => {
    const reads = [
      { request_id: 9, status: "paying" },
      { request_id: 9, status: "paying" },
      { request_id: 9, status: "paid" },
    ];
    const sleeps = [];
    const record = await waitForRequestStatus(
      async () => reads.shift(),
      9,
      ["paid"],
      { delayMs: 5, sleep: async (ms) => void sleeps.push(ms) },
    );
    assert.equal(record.status, "paid");
    assert.equal(sleeps.length, 2);
  });

  it("accepts any of several terminal statuses without sleeping", async () => {
    const sleeps = [];
    const record = await waitForRequestStatus(
      async () => ({ request_id: 9, status: "failed" }),
      9,
      ["paid", "failed"],
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    assert.equal(record.status, "failed");
    assert.equal(sleeps.length, 0);
  });

  it("throws a labeled timeout naming the last status seen", async () => {
    await assert.rejects(
      () =>
        waitForRequestStatus(
          async () => ({ request_id: 9, status: "paying" }),
          9,
          ["paid"],
          { tries: 3, sleep: async () => {} },
        ),
      /Timed out waiting for request 9.*last saw paying/,
    );
  });
});

describe("isAlreadyRegisteredMessage", () => {
  it("matches the seed-books skip idiom", () => {
    assert.equal(isAlreadyRegisteredMessage("Failed: already registered"), true);
    assert.equal(isAlreadyRegisteredMessage("something else"), false);
    assert.equal(isAlreadyRegisteredMessage(null), false);
  });
});

describe("SUITE_DEFAULTS", () => {
  it("pins the documented gate amounts and payees", () => {
    assert.equal(SUITE_DEFAULTS.overAllowanceNear, "20");
    assert.equal(SUITE_DEFAULTS.allowlistProbeNear, "1");
    assert.equal(SUITE_DEFAULTS.stagedNear, "5");
    assert.equal(SUITE_DEFAULTS.goodPayee, "good.testnet");
    assert.equal(SUITE_DEFAULTS.attackerPayee, "attacker.testnet");
    assert.equal(SUITE_DEFAULTS.evilPayee, "evil.testnet");
  });
});
