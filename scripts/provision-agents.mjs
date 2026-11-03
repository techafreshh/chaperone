#!/usr/bin/env node
// Provision locked agent sub-accounts and register them on the guard.
//
// Custody model: each `agent-<i>.<signer>` account ends with exactly two
// keys — one operator-custody FULL-ACCESS key (private key in
// scripts/.agent-keys/, never given to the agent) plus the agent's
// FUNCTION-CALL key scoped to `request_payment` on the guard. "Locked" means
// the agent principal only ever receives the function-call credential; the
// retained operator key is what makes later `revoke-key` possible.
//
// ALLOWANCE GOTCHA (see scripts/README.md): the explicit non-zero
// `--allowance` below is a real budget cap on the off-chain `AddKey` path.
// `allowance: 0` there means a ZERO budget (every tx fails), NOT unlimited.
// The "0 means unlimited" rule applies ONLY to the contract
// `promise_batch_action_add_key_with_function_call` path, which these scripts
// do not use. Never pass 0 here.
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import {
  DEFAULT_DAILY_ALLOWANCE_YOCTO,
  DEFAULT_INITIAL_BALANCE_YOCTO,
  DEFAULT_PER_PAYMENT_CAP_YOCTO,
  FC_ALLOWANCE_YOCTO,
  FC_METHOD_NAMES,
  agentAccountId,
  assertAllowanceYocto,
  keystorePath,
  nearToYoctoString,
  parseCount,
  readKeystore,
  repoRootFromHere,
  writeKeystore,
} from "./lib/agent-keys.mjs";

const TESTNET_RPC_URL = "https://rpc.testnet.near.org";
const TERA_GAS = 10n ** 12n;
const CALL_GAS = 30n * TERA_GAS;

function usage() {
  return [
    "Usage: scripts/provision-agents.sh --count <n> --contract <guard-id> [options]",
    "",
    "Options:",
    "  --count <n>            How many agent-<i> sub-accounts to provision (required, >= 1)",
    "  --contract <id>        Guard contract account id (required; or $NEAR_CONTRACT_ID)",
    "  --rpc-url <url>        NEAR RPC endpoint (default: $NEAR_RPC_URL or testnet)",
    "  --account-id <id>      Signer account id: sub-account parent and guard owner",
    "                         (default: $NEAR_ACCOUNT_ID)",
    "  --private-key <key>    Signer private key ed25519:... (default: $NEAR_PRIVATE_KEY)",
    "  --initial-balance <n>  Fresh sub-account funding in NEAR (default: 0.5)",
    "  --allowance <yocto>    Agent key gas allowance, explicit non-zero yocto string",
    `                         (default: ${FC_ALLOWANCE_YOCTO})`,
    "  --daily-allowance <n>  On-chain daily allowance in NEAR (default: 50)",
    "  --per-payment-cap <n>  On-chain per-payment cap in NEAR (default: 10)",
    "  --payee <id>           Allowlisted payee (repeatable, default: none)",
    "  --help                 Print this help and exit 0",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { payees: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--count" && i + 1 < argv.length) {
      out.count = argv[(i += 1)];
    } else if (arg === "--contract" && i + 1 < argv.length) {
      out.contract = argv[(i += 1)];
    } else if (arg === "--rpc-url" && i + 1 < argv.length) {
      out.rpcUrl = argv[(i += 1)];
    } else if (arg === "--account-id" && i + 1 < argv.length) {
      out.accountId = argv[(i += 1)];
    } else if (arg === "--private-key" && i + 1 < argv.length) {
      out.privateKey = argv[(i += 1)];
    } else if (arg === "--initial-balance" && i + 1 < argv.length) {
      out.initialBalance = argv[(i += 1)];
    } else if (arg === "--allowance" && i + 1 < argv.length) {
      out.allowance = argv[(i += 1)];
    } else if (arg === "--daily-allowance" && i + 1 < argv.length) {
      out.dailyAllowance = argv[(i += 1)];
    } else if (arg === "--per-payment-cap" && i + 1 < argv.length) {
      out.perPaymentCap = argv[(i += 1)];
    } else if (arg === "--payee" && i + 1 < argv.length) {
      out.payees.push(argv[(i += 1)]);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return out;
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

async function listAccessKeys(provider, accountId) {
  const res = await provider.query({
    request_type: "view_access_key_list",
    account_id: accountId,
    finality: "final",
  });
  if (!Array.isArray(res.keys)) {
    throw new Error(`Unexpected view_access_key_list response for ${accountId}.`);
  }
  return res.keys;
}

function functionCallPermission(key) {
  return key?.access_key?.permission?.FunctionCall ?? null;
}

function isGuardKey(key, guardId) {
  return functionCallPermission(key)?.receiver_id === guardId;
}

function isFullAccess(key) {
  return key?.access_key?.permission === "FullAccess";
}

// Fail-closed lock check: the account must hold exactly the operator
// full-access key plus the agent's guard-scoped function-call key.
function assertLocked(keys, fullId, operatorPublicKey, agentPublicKey, guardId) {
  const problems = [];
  if (keys.length !== 2) {
    problems.push(`expected exactly 2 keys, found ${keys.length}`);
  }
  const operatorKey = keys.find((key) => key.public_key === operatorPublicKey);
  if (!operatorKey || !isFullAccess(operatorKey)) {
    problems.push("operator full-access key missing");
  }
  const agentKey = keys.find((key) => key.public_key === agentPublicKey);
  const permission = agentKey ? functionCallPermission(agentKey) : null;
  if (!permission || permission.receiver_id !== guardId) {
    problems.push("agent function-call key missing or mis-scoped");
  } else {
    const allowance = String(permission.allowance ?? "");
    if (!/^\d+$/.test(allowance) || !/[1-9]/.test(allowance)) {
      problems.push("agent key allowance is not an explicit non-zero string");
    }
    const methods = permission.method_names ?? [];
    if (!FC_METHOD_NAMES.every((method) => methods.includes(method))) {
      problems.push(`agent key method_names must include ${FC_METHOD_NAMES.join(",")}`);
    }
  }
  const foreignFullAccess = keys.some(
    (key) => key.public_key !== operatorPublicKey && isFullAccess(key),
  );
  if (foreignFullAccess) {
    problems.push("unexpected extra full-access key present");
  }
  if (problems.length > 0) {
    throw new Error(`Lock verification failed for ${fullId}: ${problems.join("; ")}.`);
  }
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

  let count;
  try {
    if (args.count === undefined) {
      throw new Error(`Missing required --count <n>\n${usage()}`);
    }
    count = parseCount(args.count);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const guardId = args.contract ?? process.env.NEAR_CONTRACT_ID;
  if (!guardId) {
    console.error(`Missing required --contract <id> (or set NEAR_CONTRACT_ID)\n${usage()}`);
    process.exit(2);
  }
  const rpcUrl = args.rpcUrl ?? process.env.NEAR_RPC_URL ?? TESTNET_RPC_URL;
  const signerId = args.accountId ?? process.env.NEAR_ACCOUNT_ID;
  const signerKey = args.privateKey ?? process.env.NEAR_PRIVATE_KEY;
  if (!signerId || !signerKey) {
    console.error(
      "Missing signer credentials: pass --account-id/--private-key or set NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY.",
    );
    process.exit(2);
  }

  let initialBalanceYocto = DEFAULT_INITIAL_BALANCE_YOCTO;
  let dailyAllowanceYocto = DEFAULT_DAILY_ALLOWANCE_YOCTO;
  let perPaymentCapYocto = DEFAULT_PER_PAYMENT_CAP_YOCTO;
  let allowanceYocto = FC_ALLOWANCE_YOCTO;
  try {
    if (args.initialBalance !== undefined) {
      initialBalanceYocto = nearToYoctoString(args.initialBalance, "--initial-balance");
    }
    if (args.dailyAllowance !== undefined) {
      dailyAllowanceYocto = nearToYoctoString(args.dailyAllowance, "--daily-allowance");
    }
    if (args.perPaymentCap !== undefined) {
      perPaymentCapYocto = nearToYoctoString(args.perPaymentCap, "--per-payment-cap");
    }
    if (args.allowance !== undefined) {
      allowanceYocto = assertAllowanceYocto(args.allowance);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const repoRoot = repoRootFromHere();
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const master = new Account(signerId, provider, KeyPair.fromString(signerKey));

  const provisioned = [];
  for (let i = 1; i <= count; i += 1) {
    const fullId = agentAccountId(`agent-${i}`, signerId);
    const storePath = keystorePath(repoRoot, fullId);
    const stored = readKeystore(storePath);

    const operatorKeyPair = stored?.operatorPrivateKey
      ? KeyPair.fromString(stored.operatorPrivateKey)
      : KeyPair.fromRandom("ed25519");
    const operatorPublicKey = operatorKeyPair.getPublicKey().toString();

    if (await accountExists(provider, fullId)) {
      console.log(`exists ${fullId}: account already exists`);
    } else {
      await master.createSubAccount({
        accountOrPrefix: fullId,
        publicKey: operatorPublicKey,
        nearToTransfer: BigInt(initialBalanceYocto),
      });
      console.log(`created ${fullId}`);
    }

    const agent = new Account(fullId, provider, operatorKeyPair);
    let keys = await listAccessKeys(provider, fullId);

    let agentKeyPair = null;
    let agentPublicKey = null;
    if (stored?.agentPrivateKey) {
      const candidate = KeyPair.fromString(stored.agentPrivateKey);
      const candidatePub = candidate.getPublicKey().toString();
      const onChain = keys.find((key) => key.public_key === candidatePub);
      if (onChain && isGuardKey(onChain, guardId)) {
        agentKeyPair = candidate;
        agentPublicKey = candidatePub;
        console.log(`exists ${fullId}: agent key already scoped to ${guardId}`);
      }
    }
    if (!agentKeyPair) {
      const fresh = KeyPair.fromRandom("ed25519");
      const freshPub = fresh.getPublicKey().toString();
      try {
        await agent.addFunctionCallAccessKey({
          publicKey: freshPub,
          contractId: guardId,
          methodNames: [...FC_METHOD_NAMES],
          allowance: BigInt(allowanceYocto),
        });
      } catch (err) {
        const message = err?.message ?? String(err);
        if (!message.includes("AddKeyAlreadyExists")) {
          throw err;
        }
      }
      agentKeyPair = fresh;
      agentPublicKey = freshPub;
      console.log(`added ${fullId}: function-call key scoped to ${guardId}`);
    }

    // Drop stale guard-scoped keys so exactly one agent key remains.
    keys = await listAccessKeys(provider, fullId);
    for (const key of keys) {
      if (key.public_key !== agentPublicKey && isGuardKey(key, guardId)) {
        await agent.deleteKey(key.public_key);
        console.log(`removed ${fullId}: stale key ${key.public_key}`);
      }
    }

    const agents = await listAgents(provider, guardId);
    if (agents.some((entry) => entry.agent_id === fullId)) {
      console.log(`skipped ${fullId}: already registered`);
    } else {
      await master.callFunction({
        contractId: guardId,
        methodName: "register_agent",
        args: {
          agent_id: fullId,
          daily_allowance_yocto: dailyAllowanceYocto,
          per_payment_cap_yocto: perPaymentCapYocto,
          payee_allowlist: args.payees,
        },
        gas: CALL_GAS,
      });
      console.log(`registered ${fullId}`);
    }

    keys = await listAccessKeys(provider, fullId);
    assertLocked(keys, fullId, operatorPublicKey, agentPublicKey, guardId);
    console.log(`locked ${fullId}: operator full-access + guard function-call key only`);

    writeKeystore(storePath, {
      accountId: fullId,
      guardContractId: guardId,
      operatorPublicKey,
      operatorPrivateKey: operatorKeyPair.toString(),
      agentPublicKey,
      agentPrivateKey: agentKeyPair.toString(),
      allowanceYocto,
    });
    provisioned.push(fullId);
  }

  const onChain = await listAgents(provider, guardId);
  const missing = provisioned.filter(
    (id) => !onChain.some((entry) => entry.agent_id === id),
  );
  if (missing.length > 0) {
    console.error(`Verification failed: missing from list_agents: ${missing.join(", ")}.`);
    process.exit(1);
  }
  console.log(`verified ${provisioned.length} agents on ${guardId}`);
}

await main();
