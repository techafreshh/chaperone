// Offline tests for the sandbox verifier (issue #21).
// Pure `node:test` + `assert/strict`, no WASM, no sandbox binary, no
// `npm install`: the helpers under test import only Node builtins and the
// builtins-only `agent-keys` module.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REJECT_REASONS,
  expectedRejectReason,
  isGuardScopedKeyShape,
  nearToYocto,
  parseSandboxArgs,
  sandboxUsage,
  u128ToBigInt,
} from "./sandbox-verify.mjs";
import { FC_ALLOWANCE_YOCTO, FC_METHOD_NAMES } from "./lib/agent-keys.mjs";

function scopedKey(guardId, overrides = {}) {
  return {
    public_key: "ed25519:abc",
    access_key: {
      nonce: 0,
      permission: {
        FunctionCall: {
          allowance: FC_ALLOWANCE_YOCTO,
          receiver_id: guardId,
          method_names: [...FC_METHOD_NAMES],
        },
      },
    },
    ...(overrides.access_key ? { access_key: overrides.access_key } : {}),
  };
}

describe("parseSandboxArgs", () => {
  it("--help exits through the help flag", () => {
    assert.equal(parseSandboxArgs(["--help"]).help, true);
  });

  it("accepts --wasm and rejects unknowns", () => {
    assert.equal(parseSandboxArgs(["--wasm", "a.wasm"]).wasm, "a.wasm");
    assert.throws(() => parseSandboxArgs(["--live"]), /Unknown argument/);
  });

  it("usage documents the SKIP contract", () => {
    assert.match(sandboxUsage(), /SKIP/);
    assert.match(sandboxUsage(), /--wasm/);
  });
});

describe("expectedRejectReason", () => {
  it("maps each sandbox gate to the contract reason", () => {
    assert.equal(expectedRejectReason("overAllowance"), "ExceedsPerPaymentCap");
    assert.equal(expectedRejectReason("allowlist"), "PayeeNotAllowlisted");
    assert.equal(expectedRejectReason("purposeRef"), "PurposeRefNotFound");
    assert.equal(expectedRejectReason("inactive"), "AgentInactive");
  });

  it("stays byte-identical to the guard reason strings", () => {
    assert.equal(REJECT_REASONS.overAllowance, "ExceedsPerPaymentCap");
    assert.ok(REJECT_REASONS.purposeRef.includes("PurposeRef"));
  });

  it("rejects unknown gates", () => {
    assert.throws(() => expectedRejectReason("nope"), /Unknown sandbox gate/);
  });
});

describe("nearToYocto", () => {
  it("scales whole NEAR to exact yocto strings", () => {
    assert.equal(nearToYocto(2), "2000000000000000000000000");
    assert.equal(nearToYocto(0), "0");
    assert.equal(nearToYocto(10), "10000000000000000000000000");
  });
});

describe("u128ToBigInt", () => {
  it("reads decimal strings and U128 wrappers", () => {
    assert.equal(u128ToBigInt("2000000000000000000000000", "t"), 2000000000000000000000000n);
    assert.equal(u128ToBigInt({ U128: "5" }, "t"), 5n);
    assert.equal(u128ToBigInt({ u128: "7" }, "t"), 7n);
  });

  it("rejects non-numeric shapes", () => {
    assert.throws(() => u128ToBigInt("1.5", "treasury"), /bad U128 shape/);
    assert.throws(() => u128ToBigInt(null, "treasury"), /bad U128 shape/);
  });
});

describe("isGuardScopedKeyShape", () => {
  const guard = "guard.test.near";

  it("accepts the exact lock shape", () => {
    assert.equal(isGuardScopedKeyShape(scopedKey(guard), guard), true);
  });

  it("rejects wrong receiver, zero allowance and missing methods", () => {
    assert.equal(isGuardScopedKeyShape(scopedKey("other.test.near"), guard), false);
    assert.equal(
      isGuardScopedKeyShape(
        { access_key: { permission: { FunctionCall: { allowance: "0", receiver_id: guard, method_names: [...FC_METHOD_NAMES] } } } },
        guard,
      ),
      false,
    );
    assert.equal(
      isGuardScopedKeyShape(
        { access_key: { permission: { FunctionCall: { allowance: FC_ALLOWANCE_YOCTO, receiver_id: guard, method_names: [] } } } },
        guard,
      ),
      false,
    );
  });

  it("rejects full-access keys and malformed entries", () => {
    assert.equal(
      isGuardScopedKeyShape({ access_key: { permission: "FullAccess" } }, guard),
      false,
    );
    assert.equal(isGuardScopedKeyShape(null, guard), false);
    assert.equal(isGuardScopedKeyShape({}, guard), false);
  });
});
