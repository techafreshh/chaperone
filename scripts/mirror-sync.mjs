#!/usr/bin/env node
// Supabase mirror sync CLI (issue #12): one-shot (`--once`) or polling
// mirror of the on-chain guard contract (agents, requests, verdicts,
// audit events) into PostgREST. Read-only against NEAR: the mirror is
// never authoritative for payment.
// Usage: node scripts/mirror-sync.mjs --once
//        node scripts/mirror-sync.mjs --stub stub.json --once
import { JsonRpcProvider } from "near-api-js";
import {
  createSupabaseStore,
  loadStubChain,
  parseMirrorArgs,
  resolveMirrorConfig,
  syncMirror,
  usage,
  DEFAULT_POLL_MS,
} from "./lib/mirror.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Live chain adapter over unsigned view calls, mirroring the
// `seed-books.mjs` `listPurposeRefs` view-call shape.
function createLiveChain(provider, contractId) {
  async function view(methodName, args) {
    const argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64");
    const res = await provider.query({
      request_type: "call_function",
      account_id: contractId,
      method_name: methodName,
      args_base64: argsBase64,
      finality: "final",
    });
    return JSON.parse(Buffer.from(res.result).toString());
  }
  return {
    async listAgents() {
      return view("list_agents", {});
    },
    async getRequest(id) {
      return view("get_request", { request_id: id });
    },
  };
}

function formatCounts(counts) {
  return (
    `agents=${counts.agents} requests=${counts.requests} ` +
    `verdicts=${counts.verdicts} audit_events=${counts.auditEvents}`
  );
}

async function main() {
  const args = parseMirrorArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const config = resolveMirrorConfig(process.env, args);
  if (config.disabled) {
    console.log(`mirror disabled: ${config.reason}`);
    return;
  }

  const stubPath = args.stub ?? process.env.MIRROR_STUB_FILE ?? null;
  let chain;
  if (stubPath !== null) {
    chain = loadStubChain(stubPath);
  } else {
    if (!config.contractId) {
      console.error(
        `Missing guard contract: pass --contract <id> or set NEAR_CONTRACT_ID.\n${usage()}`,
      );
      process.exit(2);
    }
    const provider = new JsonRpcProvider({ url: config.rpcUrl });
    chain = createLiveChain(provider, config.contractId);
  }

  const store = createSupabaseStore({
    url: config.url,
    serviceKey: config.serviceKey,
    fetchImpl: globalThis.fetch,
  });

  if (args.once) {
    try {
      const counts = await syncMirror({ chain, store, config });
      console.log(`mirror sync complete: ${formatCounts(counts)}`);
    } catch (err) {
      console.error(`mirror sync failed: ${err?.message ?? String(err)}`);
      process.exit(1);
    }
    return;
  }

  const pollMs = Number(process.env.MIRROR_POLL_MS ?? DEFAULT_POLL_MS);
  for (;;) {
    try {
      const counts = await syncMirror({ chain, store, config });
      console.log(`mirror sync complete: ${formatCounts(counts)}`);
    } catch (err) {
      console.error(`mirror sync failed: ${err?.message ?? String(err)}`);
    }
    await sleep(Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_POLL_MS);
  }
}

await main();
