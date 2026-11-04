#!/usr/bin/env node
// Testnet funding entry point (issue #21): make sure every fleet agent can
// afford to transact. Without credentials the CLI prints SKIP and exits 0
// (merge tier needs no live secrets); `--dry-run` prints the view_account
// / faucet-POST / signer-transfer plan with zero mutation. Only `--live`
// with credentials queries balances and tops up agents below `--threshold`:
// first via the faucet, falling back to a signer transfer.
// Usage: scripts/fund-testnet.sh [--live|--dry-run] [options]
import {
  DEFAULT_TOPUP_AMOUNT_YOCTO,
  DEFAULT_TOPUP_TRIGGER_YOCTO,
  FAUCET_METHOD,
  FAUCET_URL,
  TESTNET_RPC_URL,
  buildFaucetPayload,
  buildFundPlan,
  fundUsage,
  parseFundArgs,
  resolveFundAgents,
} from "./lib/deploy-plan.mjs";
import { assertAllowanceYocto } from "./lib/agent-keys.mjs";

const SKIP_MESSAGE =
  "SKIP: NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY unset — fund-testnet needs a funded signer; re-run with creds or --live after funding.";

async function queryBalanceYocto(provider, accountId) {
  const res = await provider.query({
    request_type: "view_account",
    account_id: accountId,
    finality: "final",
  });
  const amount = res?.amount;
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
    throw new Error(`Unexpected view_account response for ${accountId}.`);
  }
  return amount;
}

async function runLive({ agents, signerId, signerKey, rpcUrl, thresholdYocto, topupYocto, faucetUrl }) {
  // Live-only imports: --help/--dry-run/SKIP never need root deps.
  const { Account, JsonRpcProvider, KeyPair } = await import("near-api-js");

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const signer = new Account(signerId, provider, KeyPair.fromString(signerKey));
  const threshold = BigInt(thresholdYocto);
  const topup = BigInt(topupYocto);

  for (const agentId of agents) {
    let balance;
    try {
      balance = BigInt(await queryBalanceYocto(provider, agentId));
    } catch (err) {
      console.error(`fund ${agentId}: cannot read balance (${err?.message ?? err}); skipping.`);
      continue;
    }
    if (balance >= threshold) {
      console.log(`fund ${agentId}: balance ${balance} yocto >= threshold, no top-up.`);
      continue;
    }
    // Below threshold: try the faucet first (best-effort, docs-churn URL).
    let faucetOk = false;
    try {
      const keys = await provider.query({
        request_type: "view_access_key_list",
        account_id: agentId,
        finality: "final",
      });
      const fullAccess = (keys?.keys ?? []).find((key) => key?.access_key?.permission === "FullAccess");
      if (fullAccess) {
        const payload = buildFaucetPayload({
          accountId: agentId,
          publicKey: fullAccess.public_key,
          faucetUrl,
        });
        const res = await fetch(payload.url, {
          method: payload.method,
          headers: payload.headers,
          body: JSON.stringify(payload.body),
        });
        faucetOk = res.ok;
        console.log(
          `fund ${agentId}: faucet ${FAUCET_METHOD} -> ${res.status} (balance ${balance} yocto).`,
        );
      } else {
        console.log(`fund ${agentId}: no full-access key for faucet payload; using signer transfer.`);
      }
    } catch (err) {
      console.log(`fund ${agentId}: faucet attempt failed (${err?.message ?? err}); using signer transfer.`);
    }
    if (!faucetOk) {
      try {
        // near-api-js v7: `transfer` defaults to native NEAR.
        await signer.transfer({ receiverId: agentId, amount: topup });
        console.log(`fund ${agentId}: signer transfer ${topupYocto} yocto complete.`);
      } catch (err) {
        console.error(`fund ${agentId}: signer transfer failed (${err?.message ?? err}).`);
        process.exit(1);
      }
    }
  }
}

async function main() {
  let args;
  try {
    args = parseFundArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    console.log(fundUsage());
    return;
  }

  const rpcUrl = args.rpcUrl ?? process.env.NEAR_RPC_URL ?? TESTNET_RPC_URL;
  const signerId = args.accountId ?? process.env.NEAR_ACCOUNT_ID;
  const signerKey = args.privateKey ?? process.env.NEAR_PRIVATE_KEY;

  let thresholdYocto = DEFAULT_TOPUP_TRIGGER_YOCTO;
  let topupYocto = DEFAULT_TOPUP_AMOUNT_YOCTO;
  try {
    if (args.threshold !== null) thresholdYocto = assertAllowanceYocto(args.threshold, "--threshold");
    if (args.amount !== null) topupYocto = assertAllowanceYocto(args.amount, "--amount");
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const faucetUrl = args.faucetUrl ?? FAUCET_URL;

  // Illustrative default keeps the plan concrete; env vars override when set.
  const planSignerId = signerId ?? "signer.testnet";
  const agents = resolveFundAgents({
    agents: args.agents,
    count: args.count,
    signerId: planSignerId,
  });

  // No creds: SKIP (exit 0) unless the operator explicitly asked for --live.
  // Either way this path prints the dry-run plan with zero mutation.
  if (!signerId || !signerKey) {
    if (args.live) {
      console.error(
        "Missing signer credentials for --live: pass --account-id/--private-key or set NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY.",
      );
      process.exit(2);
    }
    console.log(SKIP_MESSAGE);
    console.log("# fund-testnet --dry-run: zero mutation, exact live funding sequence");
    for (const line of buildFundPlan({
      agents,
      signerId: planSignerId,
      rpcUrl,
      thresholdYocto,
      topupYocto,
      faucetUrl,
    })) {
      console.log(line);
    }
    return;
  }

  if (!args.live) {
    // Creds present but no --live: still only print the plan (safe default).
    console.log("# fund-testnet: creds present, no --live — printing plan only (zero mutation)");
    for (const line of buildFundPlan({ agents, signerId, rpcUrl, thresholdYocto, topupYocto, faucetUrl })) {
      console.log(line);
    }
    console.log("# re-run with --live to execute");
    return;
  }

  try {
    await runLive({ agents, signerId, signerKey, rpcUrl, thresholdYocto, topupYocto, faucetUrl });
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}

await main();
