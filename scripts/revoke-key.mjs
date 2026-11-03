#!/usr/bin/env node
// Revoke an agent's guard-scoped function-call key(s).
//
// Signed as the agent by the operator-custody full-access key kept in
// scripts/.agent-keys/ at provision time. Deletes every key whose
// `permission.FunctionCall.receiver_id` equals the guard, then re-queries to
// confirm the key is gone. An already-absent key is success (`already
// revoked`, exit 0).
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import {
  agentAccountId,
  keystorePath,
  readKeystore,
  repoRootFromHere,
} from "./lib/agent-keys.mjs";

const TESTNET_RPC_URL = "https://rpc.testnet.near.org";

function usage() {
  return [
    "Usage: scripts/revoke-key.sh <agent-ref> [options]",
    "",
    "Arguments:",
    "  <agent-ref>            Agent short ref (agent-1) or full id (agent-1.signer.testnet)",
    "",
    "Options:",
    "  --contract <id>        Guard contract account id",
    "                         (default: $NEAR_CONTRACT_ID, else the provision-time keystore value)",
    "  --rpc-url <url>        NEAR RPC endpoint (default: $NEAR_RPC_URL or testnet)",
    "  --account-id <id>      Signer account id for short-ref resolution (default: $NEAR_ACCOUNT_ID)",
    "  --private-key <key>    Unused for signing; kept for parity (default: $NEAR_PRIVATE_KEY)",
    "  --help                 Print this help and exit 0",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--contract" && i + 1 < argv.length) {
      out.contract = argv[(i += 1)];
    } else if (arg === "--rpc-url" && i + 1 < argv.length) {
      out.rpcUrl = argv[(i += 1)];
    } else if (arg === "--account-id" && i + 1 < argv.length) {
      out.accountId = argv[(i += 1)];
    } else if (arg === "--private-key" && i + 1 < argv.length) {
      out.privateKey = argv[(i += 1)];
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    } else if (out.ref === undefined) {
      out.ref = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}\n${usage()}`);
    }
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.ref) {
    console.error(`Missing <agent-ref>\n${usage()}`);
    process.exit(2);
  }

  const parent = args.accountId ?? process.env.NEAR_ACCOUNT_ID;
  let fullId;
  try {
    fullId = agentAccountId(args.ref, parent);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const storePath = keystorePath(repoRootFromHere(), fullId);
  const stored = readKeystore(storePath);
  if (!stored?.operatorPrivateKey) {
    console.error(
      `No keystore entry for ${fullId} at ${storePath}: cannot revoke without the operator key. ` +
        "Provision the agent first.",
    );
    process.exit(2);
  }

  const guardId = args.contract ?? process.env.NEAR_CONTRACT_ID ?? stored.guardContractId;
  if (!guardId) {
    console.error(`Missing guard contract id: pass --contract or set NEAR_CONTRACT_ID.`);
    process.exit(2);
  }

  const rpcUrl = args.rpcUrl ?? process.env.NEAR_RPC_URL ?? TESTNET_RPC_URL;
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const agent = new Account(fullId, provider, KeyPair.fromString(stored.operatorPrivateKey));

  const queryKeys = async () => {
    const res = await provider.query({
      request_type: "view_access_key_list",
      account_id: fullId,
      finality: "final",
    });
    if (!Array.isArray(res.keys)) {
      throw new Error(`Unexpected view_access_key_list response for ${fullId}.`);
    }
    return res.keys;
  };

  const before = await queryKeys();
  const targets = before.filter(
    (key) => key?.access_key?.permission?.FunctionCall?.receiver_id === guardId,
  );
  if (targets.length === 0) {
    console.log(`already revoked ${fullId}: no key scoped to ${guardId}`);
    return;
  }

  for (const key of targets) {
    await agent.deleteKey(key.public_key);
    console.log(`revoked ${fullId}: deleted key ${key.public_key}`);
  }

  const after = await queryKeys();
  const remaining = after.filter(
    (key) => key?.access_key?.permission?.FunctionCall?.receiver_id === guardId,
  );
  if (remaining.length > 0) {
    console.error(
      `Verification failed: ${remaining.length} key(s) still scoped to ${guardId} on ${fullId}.`,
    );
    process.exit(1);
  }
  console.log(`verified ${fullId}: no key scoped to ${guardId} remains`);
}

await main();
