#!/usr/bin/env node
// Testnet deploy entry point (issue #21): build the guard WASM, deploy it,
// seed the books, provision locked agent sub-accounts, and assert the
// fleet reads back — or print that exact sequence without touching
// anything. Merge tier needs no live secrets: without credentials (and
// without `--live`) the CLI prints the `--dry-run` plan and exits 0;
// `--sandbox` runs the offline-tolerant `near-workspaces` round trip;
// only `--live` touches testnet and fails closed without credentials.
// Usage: scripts/deploy-testnet.sh [--live|--sandbox|--dry-run] [options]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentAccountId } from "./lib/agent-keys.mjs";
import {
  DEFAULT_AGENT_COUNT,
  DEFAULT_WASM_PATH,
  TESTNET_RPC_URL,
  buildDryRunPlan,
  deployUsage,
  parseDeployArgs,
} from "./lib/deploy-plan.mjs";

const TERA_GAS = 10n ** 12n;
const CALL_GAS = 30n * TERA_GAS;

function scriptDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function repoRoot() {
  return join(scriptDir(), "..");
}

function runHelper(script, args) {
  const res = spawnSync(process.execPath, [join(scriptDir(), script), ...args], {
    stdio: "inherit",
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    console.error(`${script} failed with exit ${res.status}.`);
    process.exit(res.status ?? 1);
  }
}

function parseCount(raw) {
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    console.error(`Invalid --count ${JSON.stringify(raw)}: expected a positive integer.`);
    process.exit(2);
  }
  return count;
}

function isMissingAccountError(err) {
  const message = err?.message ?? String(err);
  return (
    message.includes("does not exist") ||
    message.includes("UNKNOWN_ACCOUNT") ||
    message.includes("AccountDoesNotExist")
  );
}

async function accountExists(provider, accountId) {
  try {
    await provider.query({
      request_type: "view_account",
      account_id: accountId,
      finality: "final",
    });
    return true;
  } catch (err) {
    if (isMissingAccountError(err)) {
      return false;
    }
    throw err;
  }
}

async function listAgents(provider, contractId) {
  const argsBase64 = Buffer.from(JSON.stringify({})).toString("base64");
  const res = await provider.query({
    request_type: "call_function",
    account_id: contractId,
    method_name: "list_agents",
    args_base64: argsBase64,
    finality: "final",
  });
  const decoded = JSON.parse(Buffer.from(res.result).toString());
  if (!Array.isArray(decoded)) {
    throw new Error(`Unexpected list_agents response: ${JSON.stringify(decoded)}`);
  }
  return decoded;
}

async function runLive({ contractId, signerId, signerKey, rpcUrl, count, wasmPath }) {
  // Live-only imports: --help/--dry-run/--sandbox never need root deps.
  const { Account, JsonRpcProvider, KeyPair } = await import("near-api-js");

  const wasmAbs = resolve(repoRoot(), wasmPath);
  if (!existsSync(wasmAbs)) {
    console.error(
      `Building guard WASM (${wasmPath} missing): cargo build -p chaperone-guard --target wasm32-unknown-unknown --release`,
    );
    const build = spawnSync(
      "cargo",
      ["build", "-p", "chaperone-guard", "--target", "wasm32-unknown-unknown", "--release"],
      { cwd: repoRoot(), stdio: "inherit" },
    );
    if (build.error) {
      throw build.error;
    }
    if (build.status !== 0) {
      console.error(`cargo build failed with exit ${build.status}.`);
      process.exit(build.status ?? 1);
    }
  }
  if (!existsSync(wasmAbs)) {
    console.error(`Guard WASM still missing at ${wasmAbs} after cargo build.`);
    process.exit(1);
  }
  const code = readFileSync(wasmAbs);

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const signerKeyPair = KeyPair.fromString(signerKey);
  const signer = new Account(signerId, provider, signerKeyPair);

  if (contractId === signerId) {
    await signer.deployContract(code);
    console.log(`deployed ${contractId} (owner account)`);
  } else if (await accountExists(provider, contractId)) {
    const contract = new Account(contractId, provider, signerKeyPair);
    await contract.deployContract(code);
    console.log(`deployed ${contractId} (existing account, signer key)`);
  } else if (contractId.endsWith(`.${signerId}`)) {
    const created = KeyPair.fromRandom("ed25519");
    await signer.createSubAccount({
      accountOrPrefix: contractId,
      publicKey: created.getPublicKey().toString(),
      nearToTransfer: 5n * 10n ** 24n,
    });
    console.log(`created ${contractId}`);
    const contract = new Account(contractId, provider, created);
    await contract.deployContract(code);
    console.log(`deployed ${contractId} (fresh sub-account)`);
  } else {
    console.error(
      `Cannot deploy: ${contractId} does not exist and is not a sub-account of ${signerId}. ` +
        `Create it first, or pass --contract ${signerId} to deploy onto the owner account.`,
    );
    process.exit(1);
  }

  runHelper("seed-books.mjs", ["--contract", contractId, "--rpc-url", rpcUrl, "--account-id", signerId, "--private-key", signerKey]);
  runHelper("provision-agents.mjs", [
    "--count", String(count),
    "--contract", contractId,
    "--rpc-url", rpcUrl,
    "--account-id", signerId,
    "--private-key", signerKey,
  ]);

  const onChain = await listAgents(provider, contractId);
  const expected = [];
  for (let i = 1; i <= count; i += 1) {
    expected.push(agentAccountId(`agent-${i}`, signerId));
  }
  const missing = expected.filter((id) => !onChain.some((entry) => entry.agent_id === id));
  if (missing.length > 0) {
    console.error(`Verification failed: list_agents is missing ${missing.join(", ")}.`);
    process.exit(1);
  }
  console.log(`verified list_agents contains ${count} agents on ${contractId}`);
}

async function main() {
  let args;
  try {
    args = parseDeployArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    console.log(deployUsage());
    return;
  }

  const mode = args.mode ?? "dry-run";
  const rpcUrl = args.rpcUrl ?? process.env.NEAR_RPC_URL ?? TESTNET_RPC_URL;
  const wasmPath = args.wasm ?? DEFAULT_WASM_PATH;
  const count = args.count === null ? DEFAULT_AGENT_COUNT : parseCount(args.count);

  if (mode === "sandbox") {
    const res = spawnSync(
      process.execPath,
      [join(scriptDir(), "sandbox-verify.mjs"), ...(args.wasm ? ["--wasm", args.wasm] : [])],
      { stdio: "inherit" },
    );
    if (res.error) {
      throw res.error;
    }
    process.exit(res.status ?? 1);
  }

  if (mode === "dry-run") {
    // Illustrative defaults keep the plan concrete (valid account ids for
    // the agent-<i> derivation); env vars override when set.
    const signerId = args.accountId ?? process.env.NEAR_ACCOUNT_ID ?? "signer.testnet";
    const contractId = args.contract ?? process.env.NEAR_CONTRACT_ID ?? `guard.${signerId}`;
    console.log("# deploy-testnet --dry-run: zero mutation, exact live command sequence");
    for (const line of buildDryRunPlan({ contractId, signerId, count, rpcUrl, wasmPath })) {
      console.log(line);
    }
    console.log("# re-run with --live (needs NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY) to execute");
    return;
  }

  // --live: fail closed without credentials or contract.
  const contractId = args.contract ?? process.env.NEAR_CONTRACT_ID;
  if (!contractId) {
    console.error(`Missing required --contract <id> for --live (or set NEAR_CONTRACT_ID)\n${deployUsage()}`);
    process.exit(2);
  }
  const signerId = args.accountId ?? process.env.NEAR_ACCOUNT_ID;
  const signerKey = args.privateKey ?? process.env.NEAR_PRIVATE_KEY;
  if (!signerId || !signerKey) {
    console.error(
      "Missing signer credentials for --live: pass --account-id/--private-key or set NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY.",
    );
    process.exit(2);
  }
  try {
    await runLive({ contractId, signerId, signerKey, rpcUrl, count, wasmPath });
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}

await main();
