#!/usr/bin/env node
// Mirrors every entry in app/data/books.json on-chain via the owner-gated
// `register_purpose_ref` of a deployed chaperone guard contract.
// Idempotent: entries whose register fails with "already registered" are skipped.
// Usage: node scripts/seed-books.mjs --contract <contract-id> [--rpc-url <url>]
//        [--account-id <id>] [--private-key ed25519:...]
// Env fallbacks: NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY. Default RPC: testnet.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";

const TESTNET_RPC_URL = "https://rpc.testnet.near.org";
const TERA_GAS = 10n ** 12n;
const CALL_GAS = 30n * TERA_GAS;

function usage() {
  return [
    "Usage: node scripts/seed-books.mjs --contract <contract-id> [options]",
    "",
    "Options:",
    "  --contract <id>     Guard contract account id (required)",
    "  --rpc-url <url>     NEAR RPC endpoint (default: https://rpc.testnet.near.org)",
    "  --account-id <id>   Signer account id (default: $NEAR_ACCOUNT_ID; must own the contract)",
    "  --private-key <key> Signer private key ed25519:... (default: $NEAR_PRIVATE_KEY)",
    "  --help              Print this help and exit 0",
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
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return out;
}

function capToYocto(capNear) {
  if (typeof capNear !== "string" || !/^\d+(\.\d+)?$/.test(capNear)) {
    throw new Error(`Invalid cap_near: ${JSON.stringify(capNear)}`);
  }
  const [whole, frac = ""] = capNear.split(".");
  if (frac.length > 24) {
    throw new Error(`Invalid cap_near: ${JSON.stringify(capNear)}`);
  }
  const padded = (frac + "0".repeat(24)).slice(0, 24);
  const normalized = whole.replace(/^0+(?=\d)/, "");
  return (BigInt(normalized) * 10n ** 24n + BigInt(padded || "0")).toString();
}

function loadBooks() {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "app", "data", "books.json");
  const entries = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`No book entries found at ${path}`);
  }
  for (const entry of entries) {
    if (
      typeof entry?.id !== "string" ||
      typeof entry?.vendor !== "string" ||
      typeof entry?.payee !== "string" ||
      entry.payee.trim() === "" ||
      typeof entry?.cap_near !== "string"
    ) {
      throw new Error(`Malformed book entry: ${JSON.stringify(entry)}`);
    }
  }
  return entries;
}

async function listPurposeRefs(provider, contractId) {
  const argsBase64 = Buffer.from(JSON.stringify({})).toString("base64");
  const res = await provider.query({
    request_type: "call_function",
    account_id: contractId,
    method_name: "list_purpose_refs",
    args_base64: argsBase64,
    finality: "final",
  });
  const raw = Buffer.from(res.result).toString();
  return JSON.parse(raw);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const contractId = args.contract;
  if (!contractId) {
    console.error(`Missing required --contract <id>\n${usage()}`);
    process.exit(2);
  }
  const rpcUrl = args.rpcUrl ?? process.env.NEAR_RPC_URL ?? TESTNET_RPC_URL;
  const accountId = args.accountId ?? process.env.NEAR_ACCOUNT_ID;
  const privateKey = args.privateKey ?? process.env.NEAR_PRIVATE_KEY;
  if (!accountId || !privateKey) {
    console.error(
      "Missing signer credentials: pass --account-id/--private-key or set NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY.",
    );
    process.exit(2);
  }

  const entries = loadBooks();
  const keyPair = KeyPair.fromString(privateKey);
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const account = new Account(accountId, provider, keyPair);

  // The suite good payee may be overridden per run (--good-payee /
  // $SUITE_GOOD_PAYEE): bind the gate ref invoice-114 to it so the
  // wrong-payee live gate keeps firing. Other sample invoices keep
  // their books.json payees.
  const suiteGoodPayee = (process.env.SUITE_GOOD_PAYEE ?? "").trim();
  for (const entry of entries) {
    const maxAmountYocto = capToYocto(entry.cap_near);
    const payee = entry.id === "invoice-114" && suiteGoodPayee !== "" ? suiteGoodPayee : entry.payee;
    try {
      await account.callFunction({
        contractId,
        methodName: "register_purpose_ref",
        args: {
          ref_id: entry.id,
          vendor: entry.vendor,
          payee,
          max_amount_yocto: maxAmountYocto,
        },
        gas: CALL_GAS,
      });
      console.log(`registered ${entry.id} (${entry.vendor} -> ${payee})`);
    } catch (err) {
      const message = err?.message ?? String(err);
      if (message.includes("already registered")) {
        console.log(`skipped ${entry.id}: already registered`);
        continue;
      }
      throw err;
    }
  }

  const refs = await listPurposeRefs(provider, contractId);
  const targetRaw = entries.find((entry) => entry.id === "invoice-114");
  const target = targetRaw ? { ...targetRaw, payee: targetRaw.id === "invoice-114" && suiteGoodPayee !== "" ? suiteGoodPayee : targetRaw.payee } : undefined;
  const onChain = Array.isArray(refs)
    ? refs.find((ref) => ref.ref_id === "invoice-114")
    : undefined;
  if (!target || !onChain || onChain.vendor !== target.vendor || onChain.payee !== target.payee) {
    console.error("Verification failed: invoice-114 missing or vendor/payee mismatch on-chain.");
    process.exit(1);
  }
  console.log(`verified invoice-114 vendor=${onChain.vendor} payee=${onChain.payee}`);
}

await main();
