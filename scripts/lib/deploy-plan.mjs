// Pure testnet deploy/fund planners (issue #21).
// This module must stay import-free apart from Node.js builtins and the
// sibling `./agent-keys.mjs` (itself builtins-only), so the offline
// `node:test` suite runs without `npm install`. Only the thin
// `scripts/deploy-testnet.mjs` / `scripts/fund-testnet.mjs` CLIs import
// `near-api-js` for the live paths; everything here takes plain values and
// returns printable command lines, never touching network or disk.
import { agentAccountId } from "./agent-keys.mjs";

export const TESTNET_RPC_URL = "https://rpc.testnet.near.org";
export const DEFAULT_AGENT_COUNT = 4;
export const DEFAULT_WASM_PATH =
  "contract/target/wasm32-unknown-unknown/release/chaperone_guard.wasm";

// Faucet endpoint and request shape, isolated in one place: the NEAR docs
// only describe a web-form faucet, so the exact helper URL/payload is the
// documented churn point — when it changes, only this constant and
// `buildFaucetPayload` change with it.
export const FAUCET_URL = "https://helper.nearprotocol.com/account";
export const FAUCET_METHOD = "POST";

// Re-exported so CLIs and tests share one spelling of the modes.
export const MODES = ["dry-run", "sandbox", "live"];

// Balance below which an agent is topped up, and the top-up size when the
// operator does not pass `--threshold`/`--amount` (0.1 NEAR trigger,
// 1 NEAR top-up, as explicit non-zero yocto strings).
export const DEFAULT_TOPUP_TRIGGER_YOCTO = "100000000000000000000000";
export const DEFAULT_TOPUP_AMOUNT_YOCTO = "1000000000000000000000000";

export function deployUsage() {
  return [
    "Usage: scripts/deploy-testnet.sh [--live|--sandbox|--dry-run] [options]",
    "",
    "Modes (default: --dry-run, zero mutation):",
    "  --dry-run      Print the exact live command sequence and exit 0",
    "  --sandbox      Run scripts/sandbox-verify.mjs (near-workspaces, offline-tolerant)",
    "  --live         Build WASM, deploy, seed books, provision agents (needs creds)",
    "",
    "Options:",
    "  --contract <id>     Guard contract account id (or $NEAR_CONTRACT_ID)",
    "  --account-id <id>   Signer account id: guard owner and agent parent",
    "                      (default: $NEAR_ACCOUNT_ID)",
    "  --private-key <key> Signer private key ed25519:... (default: $NEAR_PRIVATE_KEY)",
    "  --rpc-url <url>     NEAR RPC endpoint (default: $NEAR_RPC_URL or testnet)",
    "  --count <n>         Agents to provision (default: 4)",
    "  --wasm <path>       Guard WASM (default: contract/target/.../chaperone_guard.wasm)",
    "  --help              Print this help and exit 0",
  ].join("\n");
}

export function parseDeployArgs(argv) {
  const out = {
    help: false,
    mode: null,
    contract: null,
    accountId: null,
    privateKey: null,
    rpcUrl: null,
    count: null,
    wasm: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--dry-run") {
      if (out.mode !== null) throw new Error("Conflicting modes: pass only one of --dry-run/--sandbox/--live.");
      out.mode = "dry-run";
    } else if (arg === "--sandbox") {
      if (out.mode !== null) throw new Error("Conflicting modes: pass only one of --dry-run/--sandbox/--live.");
      out.mode = "sandbox";
    } else if (arg === "--live") {
      if (out.mode !== null) throw new Error("Conflicting modes: pass only one of --dry-run/--sandbox/--live.");
      out.mode = "live";
    } else if (arg === "--contract" && i + 1 < argv.length) {
      out.contract = argv[(i += 1)];
    } else if (arg === "--account-id" && i + 1 < argv.length) {
      out.accountId = argv[(i += 1)];
    } else if (arg === "--private-key" && i + 1 < argv.length) {
      out.privateKey = argv[(i += 1)];
    } else if (arg === "--rpc-url" && i + 1 < argv.length) {
      out.rpcUrl = argv[(i += 1)];
    } else if (arg === "--count" && i + 1 < argv.length) {
      out.count = argv[(i += 1)];
    } else if (arg === "--wasm" && i + 1 < argv.length) {
      out.wasm = argv[(i += 1)];
    } else {
      throw new Error(`Unknown argument: ${arg}\n${deployUsage()}`);
    }
  }
  return out;
}

// Ordered live command sequence printed by `--dry-run` and executed by
// `--live`: build the guard WASM, deploy it, register each agent, seed the
// books, provision locked agent keys, then assert `list_agents` shows all
// `count` agents. Pure formatting — no mutation.
export function buildDryRunPlan({ contractId, signerId, count, rpcUrl, wasmPath }) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`buildDryRunPlan needs a positive integer count, got ${JSON.stringify(count)}.`);
  }
  if (typeof contractId !== "string" || contractId === "") {
    throw new Error("buildDryRunPlan needs a contractId.");
  }
  if (typeof signerId !== "string" || signerId === "") {
    throw new Error("buildDryRunPlan needs a signerId.");
  }
  const lines = [
    `cargo build -p chaperone-guard --target wasm32-unknown-unknown --release`,
    `deploy ${wasmPath} -> ${contractId} (signed by ${signerId} via ${rpcUrl})`,
  ];
  for (let i = 1; i <= n; i += 1) {
    const agentId = agentAccountId(`agent-${i}`, signerId);
    lines.push(`register_agent ${agentId} on ${contractId}`);
  }
  lines.push(`node scripts/seed-books.mjs --contract ${contractId}`);
  lines.push(`node scripts/provision-agents.mjs --count ${n} --contract ${contractId}`);
  lines.push(`assert list_agents(${contractId}) contains ${n} agents`);
  return lines;
}

export function fundUsage() {
  return [
    "Usage: scripts/fund-testnet.sh [--live|--dry-run] [options]",
    "",
    "Modes (default: --dry-run when creds are absent, zero mutation):",
    "  --dry-run      Print the fund plan (view_account, faucet POST, transfer) and exit 0",
    "  --live         Query balances, faucet-top-up below threshold, else signer transfer",
    "",
    "Options:",
    "  --contract <id>     Guard contract account id (or $NEAR_CONTRACT_ID)",
    "  --account-id <id>   Signer account id funding the top-ups (or $NEAR_ACCOUNT_ID)",
    "  --private-key <key> Signer private key ed25519:... (or $NEAR_PRIVATE_KEY)",
    "  --rpc-url <url>     NEAR RPC endpoint (default: $NEAR_RPC_URL or testnet)",
    "  --agent <id>        Agent account to fund (repeatable; default: agent-1..N of --count)",
    "  --count <n>         Agents to fund as agent-<i>.<signer> (default: 4)",
    "  --threshold <yocto> Top up when balance is below this (explicit non-zero yocto string)",
    `                      (default: ${DEFAULT_TOPUP_TRIGGER_YOCTO})`,
    "  --amount <yocto>    Top-up size (explicit non-zero yocto string)",
    `                      (default: ${DEFAULT_TOPUP_AMOUNT_YOCTO})`,
    "  --faucet-url <url>  Faucet endpoint override (default: the FAUCET_URL constant)",
    "  --help              Print this help and exit 0",
  ].join("\n");
}

export function parseFundArgs(argv) {
  const out = {
    help: false,
    live: false,
    dryRun: false,
    contract: null,
    accountId: null,
    privateKey: null,
    rpcUrl: null,
    agents: [],
    count: null,
    threshold: null,
    amount: null,
    faucetUrl: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--live") {
      out.live = true;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--contract" && i + 1 < argv.length) {
      out.contract = argv[(i += 1)];
    } else if (arg === "--account-id" && i + 1 < argv.length) {
      out.accountId = argv[(i += 1)];
    } else if (arg === "--private-key" && i + 1 < argv.length) {
      out.privateKey = argv[(i += 1)];
    } else if (arg === "--rpc-url" && i + 1 < argv.length) {
      out.rpcUrl = argv[(i += 1)];
    } else if (arg === "--agent" && i + 1 < argv.length) {
      out.agents.push(argv[(i += 1)]);
    } else if (arg === "--count" && i + 1 < argv.length) {
      out.count = argv[(i += 1)];
    } else if (arg === "--threshold" && i + 1 < argv.length) {
      out.threshold = argv[(i += 1)];
    } else if (arg === "--amount" && i + 1 < argv.length) {
      out.amount = argv[(i += 1)];
    } else if (arg === "--faucet-url" && i + 1 < argv.length) {
      out.faucetUrl = argv[(i += 1)];
    } else {
      throw new Error(`Unknown argument: ${arg}\n${fundUsage()}`);
    }
  }
  if (out.live && out.dryRun) {
    throw new Error("Conflicting modes: pass only one of --dry-run/--live.");
  }
  return out;
}

// Faucet request shape for one account: POST {url} with
// {newAccountId, newAccountPublicKey}. Kept beside FAUCET_URL so docs
// churn touches this one function.
export function buildFaucetPayload({ accountId, publicKey, faucetUrl = FAUCET_URL }) {
  if (typeof accountId !== "string" || accountId === "") {
    throw new Error("buildFaucetPayload needs an accountId.");
  }
  if (typeof publicKey !== "string" || publicKey === "") {
    throw new Error("buildFaucetPayload needs a publicKey.");
  }
  return {
    url: faucetUrl,
    method: FAUCET_METHOD,
    headers: { "Content-Type": "application/json" },
    body: { newAccountId: accountId, newAccountPublicKey: publicKey },
  };
}

// Printable fund plan: per agent, the balance `view_account` query, the
// faucet POST fired when below threshold, then the signer-transfer
// fallback. Pure formatting — no mutation.
export function buildFundPlan({ agents, signerId, rpcUrl, thresholdYocto, topupYocto, faucetUrl = FAUCET_URL }) {
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error("buildFundPlan needs a non-empty agents list.");
  }
  if (typeof signerId !== "string" || signerId === "") {
    throw new Error("buildFundPlan needs a signerId.");
  }
  const lines = [];
  for (const agentId of agents) {
    lines.push(`view_account ${agentId} via ${rpcUrl} (top up below ${thresholdYocto} yocto)`);
    lines.push(`${FAUCET_METHOD} ${faucetUrl} {"newAccountId":"${agentId}"} (faucet top-up)`);
    lines.push(`transfer ${topupYocto} yocto from ${signerId} to ${agentId} (signer fallback)`);
  }
  return lines;
}

// Resolve `--agent` refs plus `--count`-derived `agent-<i>.<signer>` ids
// into fully-qualified account ids. Short refs expand under the signer;
// anything else passes through `agentAccountId` validation unchanged.
export function resolveFundAgents({ agents, count, signerId }) {
  const n = count === null || count === undefined ? DEFAULT_AGENT_COUNT : Number(count);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --count ${JSON.stringify(count)}: expected a positive integer.`);
  }
  const out = [];
  for (const ref of agents ?? []) {
    out.push(agentAccountId(ref, signerId));
  }
  if (out.length === 0) {
    for (let i = 1; i <= n; i += 1) {
      out.push(agentAccountId(`agent-${i}`, signerId));
    }
  }
  return out;
}
