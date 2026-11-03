import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DAILY_ALLOWANCE_YOCTO,
  DEFAULT_PER_PAYMENT_CAP_YOCTO,
  FC_ALLOWANCE_YOCTO,
  FC_METHOD_NAMES,
  agentAccountId,
  assertAllowanceYocto,
  isNonZeroYoctoString,
  keystorePath,
  nearToYoctoString,
  parseCount,
  readKeystore,
  writeKeystore,
} from "./agent-keys.mjs";

describe("agentAccountId", () => {
  it("derives a short ref under the parent signer", () => {
    assert.equal(agentAccountId("agent-1", "signer.testnet"), "agent-1.signer.testnet");
    assert.equal(agentAccountId("agent-12", "signer.testnet"), "agent-12.signer.testnet");
  });

  it("passes a fully-qualified id through unchanged", () => {
    assert.equal(
      agentAccountId("agent-1.signer.testnet", "signer.testnet"),
      "agent-1.signer.testnet",
    );
  });

  it("rejects uppercase instead of silently lowercasing", () => {
    assert.throws(() => agentAccountId("Agent-1", "signer.testnet"), /lowercase/);
    assert.throws(
      () => agentAccountId("AGENT-1.SIGNER.TESTNET", "signer.testnet"),
      /lowercase/,
    );
  });

  it("rejects bare names and bad parents", () => {
    assert.throws(() => agentAccountId("agent", "signer.testnet"), /Invalid agent ref/);
    assert.throws(() => agentAccountId("", "signer.testnet"), /non-empty/);
    assert.throws(() => agentAccountId("agent-1", undefined), /parent account id/);
    assert.throws(() => agentAccountId("agent-1", "UPPER.testnet"), /Invalid NEAR account id/);
  });
});

describe("allowance validation", () => {
  it("accepts the default explicit non-zero allowance", () => {
    assert.equal(isNonZeroYoctoString(FC_ALLOWANCE_YOCTO), true);
    assert.equal(assertAllowanceYocto(FC_ALLOWANCE_YOCTO), FC_ALLOWANCE_YOCTO);
  });

  it("rejects zero, blank-padded zero, decimals, empty and non-strings", () => {
    for (const bad of ["0", "00", "000", "12.5", "", "  ", "1 NEAR", "0x10", null, undefined, 0, 250]) {
      assert.equal(isNonZeroYoctoString(bad), false, JSON.stringify(bad));
    }
    assert.throws(() => assertAllowanceYocto("0"), /non-zero/);
  });
});

describe("nearToYoctoString", () => {
  it("converts the documented defaults exactly", () => {
    assert.equal(nearToYoctoString("0.5"), "500000000000000000000000");
    assert.equal(nearToYoctoString("50"), DEFAULT_DAILY_ALLOWANCE_YOCTO);
    assert.equal(nearToYoctoString("10"), DEFAULT_PER_PAYMENT_CAP_YOCTO);
  });

  it("rejects malformed amounts", () => {
    for (const bad of ["", "abc", "-1", "1.2.3", "0.0000000000000000000000001"]) {
      assert.throws(() => nearToYoctoString(bad), /Invalid/, JSON.stringify(bad));
    }
  });
});

describe("FC_METHOD_NAMES", () => {
  it("binds the agent key to request_payment only", () => {
    assert.deepEqual(FC_METHOD_NAMES, ["request_payment"]);
  });
});

describe("parseCount", () => {
  it("accepts positive integers", () => {
    assert.equal(parseCount("4"), 4);
    assert.equal(parseCount(1), 1);
  });

  it("rejects 0, NaN and fractions", () => {
    for (const bad of ["0", 0, "NaN", "abc", undefined, "2.5", "-3", ""]) {
      assert.throws(() => parseCount(bad), /Invalid --count/, JSON.stringify(bad));
    }
  });
});

describe("keystore round-trip", () => {
  it("writes and reads back an entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-keys-"));
    const fullId = "agent-1.signer.testnet";
    const path = keystorePath(dir, fullId);
    assert.ok(path.endsWith(join("scripts", ".agent-keys", `${fullId}.json`)));

    const entry = {
      accountId: fullId,
      guardContractId: "guard.signer.testnet",
      operatorPublicKey: "ed25519:6E8s4PdArVf3MYs5A4v6Q8rT",
      operatorPrivateKey: "ed25519:secret",
      agentPublicKey: "ed25519:agent-pub",
      agentPrivateKey: "ed25519:agent-secret",
      allowanceYocto: FC_ALLOWANCE_YOCTO,
    };
    writeKeystore(path, entry);
    assert.deepEqual(readKeystore(path), entry);
  });

  it("returns null for a missing entry and throws on malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-keys-"));
    assert.equal(readKeystore(join(dir, "scripts", ".agent-keys", "nope.json")), null);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.throws(() => readKeystore(bad), /Malformed keystore/);
  });
});
