// Offline tests for the testnet deploy/fund planners (issue #21).
// Pure `node:test` + `assert/strict`, no network, no `npm install`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_COUNT,
  DEFAULT_TOPUP_AMOUNT_YOCTO,
  DEFAULT_TOPUP_TRIGGER_YOCTO,
  FAUCET_METHOD,
  FAUCET_URL,
  TESTNET_RPC_URL,
  buildDryRunPlan,
  buildFaucetPayload,
  buildFundPlan,
  deployUsage,
  fundUsage,
  parseDeployArgs,
  parseFundArgs,
  resolveFundAgents,
} from "./deploy-plan.mjs";
import { assertAllowanceYocto } from "./agent-keys.mjs";

describe("parseDeployArgs", () => {
  it("--help exits through the help flag", () => {
    assert.equal(parseDeployArgs(["--help"]).help, true);
    assert.equal(parseDeployArgs(["-h"]).help, true);
  });

  it("defaults to no mode (dry-run by the CLI when creds are absent)", () => {
    const args = parseDeployArgs([]);
    assert.equal(args.mode, null);
    assert.equal(args.help, false);
  });

  it("accepts each mode once and rejects conflicting modes", () => {
    assert.equal(parseDeployArgs(["--dry-run"]).mode, "dry-run");
    assert.equal(parseDeployArgs(["--sandbox"]).mode, "sandbox");
    assert.equal(parseDeployArgs(["--live"]).mode, "live");
    assert.throws(() => parseDeployArgs(["--live", "--dry-run"]), /Conflicting modes/);
    assert.throws(() => parseDeployArgs(["--sandbox", "--live"]), /Conflicting modes/);
  });

  it("parses contract/count/wasm flags and rejects unknowns", () => {
    const args = parseDeployArgs(["--contract", "guard.s.testnet", "--count", "4"]);
    assert.equal(args.contract, "guard.s.testnet");
    assert.equal(args.count, "4");
    assert.throws(() => parseDeployArgs(["--bogus"]), /Unknown argument/);
  });

  it("usage mentions all three modes", () => {
    assert.match(deployUsage(), /--dry-run/);
    assert.match(deployUsage(), /--sandbox/);
    assert.match(deployUsage(), /--live/);
  });
});

describe("buildDryRunPlan", () => {
  const base = {
    contractId: "guard.signer.testnet",
    signerId: "signer.testnet",
    count: 4,
    rpcUrl: TESTNET_RPC_URL,
    wasmPath: "contract/target/wasm32-unknown-unknown/release/chaperone_guard.wasm",
  };

  it("emits deploy -> register_agent x4 -> seed -> provision -> assert, in order", () => {
    const plan = buildDryRunPlan(base);
    assert.equal(plan.length, 2 + 4 + 3);
    assert.match(plan[0], /^cargo build -p chaperone-guard/);
    assert.match(plan[1], /deploy .* -> guard\.signer\.testnet/);
    assert.match(plan[2], /register_agent agent-1\.signer\.testnet/);
    assert.match(plan[5], /register_agent agent-4\.signer\.testnet/);
    assert.match(plan[6], /seed-books\.mjs --contract guard\.signer\.testnet/);
    assert.match(plan[7], /provision-agents\.mjs --count 4 --contract guard\.signer\.testnet/);
    assert.match(plan[8], /assert list_agents.*contains 4 agents/);
  });

  it("scales register_agent lines with --count", () => {
    const plan = buildDryRunPlan({ ...base, count: 2 });
    assert.equal(plan.filter((line) => line.startsWith("register_agent")).length, 2);
    assert.match(plan[plan.length - 1], /contains 2 agents/);
  });

  it("rejects bad counts and missing ids", () => {
    assert.throws(() => buildDryRunPlan({ ...base, count: 0 }), /positive integer/);
    assert.throws(() => buildDryRunPlan({ ...base, count: "x" }), /positive integer/);
    assert.throws(() => buildDryRunPlan({ ...base, contractId: "" }), /contractId/);
    assert.throws(() => buildDryRunPlan({ ...base, signerId: "" }), /signerId/);
  });
});

describe("parseFundArgs", () => {
  it("--help exits through the help flag", () => {
    assert.equal(parseFundArgs(["--help"]).help, true);
  });

  it("rejects conflicting --live --dry-run and unknown flags", () => {
    assert.throws(() => parseFundArgs(["--live", "--dry-run"]), /Conflicting/);
    assert.throws(() => parseFundArgs(["--nope"]), /Unknown argument/);
  });

  it("collects repeatable --agent refs and validates amounts as non-zero yocto", () => {
    const args = parseFundArgs(["--agent", "agent-1", "--amount", "1000", "--threshold", "5"]);
    assert.deepEqual(args.agents, ["agent-1"]);
    assert.equal(assertAllowanceYocto(args.amount, "--amount"), "1000");
    assert.equal(assertAllowanceYocto(args.threshold, "--threshold"), "5");
  });

  it("rejects a zero top-up amount (allowance 0 means zero budget)", () => {
    assert.throws(() => assertAllowanceYocto("0", "--amount"), /non-zero/);
  });

  it("usage documents the funding sources", () => {
    assert.match(fundUsage(), /faucet/);
    assert.match(fundUsage(), /--amount/);
  });
});

describe("buildFaucetPayload", () => {
  it("isolates the faucet URL, method and body shape in one object", () => {
    const payload = buildFaucetPayload({ accountId: "agent-1.s.testnet", publicKey: "ed25519:abc" });
    assert.equal(payload.url, FAUCET_URL);
    assert.equal(payload.method, FAUCET_METHOD);
    assert.equal(payload.body.newAccountId, "agent-1.s.testnet");
    assert.equal(payload.body.newAccountPublicKey, "ed25519:abc");
  });

  it("honours a faucet URL override", () => {
    const payload = buildFaucetPayload({
      accountId: "a",
      publicKey: "k",
      faucetUrl: "https://faucet.example/claim",
    });
    assert.equal(payload.url, "https://faucet.example/claim");
  });

  it("requires account and key", () => {
    assert.throws(() => buildFaucetPayload({ accountId: "", publicKey: "k" }), /accountId/);
    assert.throws(() => buildFaucetPayload({ accountId: "a", publicKey: "" }), /publicKey/);
  });
});

describe("buildFundPlan", () => {
  it("shows view_account, faucet POST, then signer transfer per agent", () => {
    const plan = buildFundPlan({
      agents: ["agent-1.signer.testnet", "agent-2.signer.testnet"],
      signerId: "signer.testnet",
      rpcUrl: TESTNET_RPC_URL,
      thresholdYocto: DEFAULT_TOPUP_TRIGGER_YOCTO,
      topupYocto: DEFAULT_TOPUP_AMOUNT_YOCTO,
    });
    assert.equal(plan.length, 6);
    assert.match(plan[0], /view_account agent-1\.signer\.testnet/);
    assert.match(plan[1], new RegExp(`POST ${FAUCET_URL.replace(/[./]/g, (c) => `\\${c}`)}`));
    assert.match(plan[2], /transfer .* from signer\.testnet to agent-1\.signer\.testnet/);
    assert.match(plan[3], /view_account agent-2\.signer\.testnet/);
  });

  it("rejects empty agent lists and missing signers", () => {
    assert.throws(() => buildFundPlan({ agents: [], signerId: "s", rpcUrl: "r", thresholdYocto: "1", topupYocto: "1" }), /non-empty/);
    assert.throws(() => buildFundPlan({ agents: ["a"], signerId: "", rpcUrl: "r", thresholdYocto: "1", topupYocto: "1" }), /signerId/);
  });
});

describe("resolveFundAgents", () => {
  it("derives agent-1..N under the signer by default", () => {
    assert.deepEqual(resolveFundAgents({ agents: [], count: null, signerId: "s.testnet" }), [
      "agent-1.s.testnet",
      "agent-2.s.testnet",
      "agent-3.s.testnet",
      "agent-4.s.testnet",
    ]);
    assert.equal(DEFAULT_AGENT_COUNT, 4);
  });

  it("expands short refs and passes full ids through", () => {
    assert.deepEqual(
      resolveFundAgents({ agents: ["agent-2", "custom.s.testnet"], count: "4", signerId: "s.testnet" }),
      ["agent-2.s.testnet", "custom.s.testnet"],
    );
  });

  it("rejects bad counts", () => {
    assert.throws(() => resolveFundAgents({ agents: [], count: "0", signerId: "s.testnet" }), /positive integer/);
  });
});
