// Pure, dependency-free helpers shared by the agent provisioning scripts.
// This module must stay import-free (Node.js builtins only) so the offline
// `node:test` suite runs without `npm install`.
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The only contract method an agent key may ever call.
export const FC_METHOD_NAMES = ["request_payment"];

// Explicit on-chain key allowance for the agent function-call key, in yoctoNEAR
// (0.25 NEAR). This MUST stay an explicit non-zero decimal string, see below.
export const FC_ALLOWANCE_YOCTO = "250000000000000000000000";

// Default funding for a fresh agent sub-account, in yoctoNEAR (0.5 NEAR).
export const DEFAULT_INITIAL_BALANCE_YOCTO = "500000000000000000000000";

// On-chain per-agent policy defaults applied via `register_agent`, in yoctoNEAR.
// These mirror the guard contract's own test constants: 50 NEAR daily
// allowance and a 10 NEAR per-payment cap.
export const DEFAULT_DAILY_ALLOWANCE_YOCTO = "50000000000000000000000000";
export const DEFAULT_PER_PAYMENT_CAP_YOCTO = "10000000000000000000000000";

// Directory (relative to the repo root) holding per-agent key custody files.
// Never committed: it contains live private keys.
export const KEYSTORE_DIR_NAME = ".agent-keys";

// ---------------------------------------------------------------------------
// Allowance gotcha. Off-chain `AddKey` and the contract key-creation path
// treat allowance `0` differently:
//   - Off-chain `AddKey` (used by these scripts): `allowance: 0` means a ZERO
//     budget, so every transaction signed by the key fails; omitting the
//     allowance means UNLIMITED. Always pass an explicit non-zero string.
//   - Contract `promise_batch_action_add_key_with_function_call` (NOT used
//     here): `allowance: 0` is special-cased to mean unlimited.
// Confusing the two either bricks the agent key or grants unlimited gas.
// ---------------------------------------------------------------------------

const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const SHORT_REF_RE = /^agent-(\d+)$/;

function assertValidAccountId(id) {
  if (typeof id !== "string" || !ACCOUNT_ID_RE.test(id)) {
    throw new Error(`Invalid NEAR account id: ${JSON.stringify(id)}`);
  }
  for (const part of id.split(".")) {
    if (part.length === 0 || part.length > 64) {
      throw new Error(`Invalid NEAR account id: ${JSON.stringify(id)}`);
    }
  }
  return id;
}

function assertValidParent(parent) {
  if (typeof parent !== "string" || parent.length === 0) {
    throw new Error(
      "A parent account id is required to resolve a short agent ref " +
        "(pass --account-id or set NEAR_ACCOUNT_ID).",
    );
  }
  return assertValidAccountId(parent);
}

// Resolve an agent reference to a fully-qualified sub-account id.
// Accepts the short form `agent-1` (expanded under `parent`) or a full id
// such as `agent-1.signer.testnet` passed through unchanged. Uppercase input
// is rejected instead of silently lowercased: NEAR account ids are lowercase,
// and quiet case-folding would derive a different account than the operator
// typed.
export function agentAccountId(ref, parent) {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("Agent ref must be a non-empty string.");
  }
  if (ref !== ref.toLowerCase()) {
    throw new Error(
      `Invalid agent ref ${JSON.stringify(ref)}: account ids are lowercase.`,
    );
  }
  const short = SHORT_REF_RE.exec(ref);
  if (short) {
    assertValidParent(parent);
    return `${short[0]}.${parent}`;
  }
  if (ref.includes(".")) {
    return assertValidAccountId(ref);
  }
  throw new Error(
    `Invalid agent ref ${JSON.stringify(ref)}: expected "agent-<n>" or a ` +
      "fully-qualified account id.",
  );
}

// True only for explicit non-zero yoctoNEAR decimal strings ("1", "250...0").
// Rejects "0", "00", decimals ("12.5"), empty strings and non-strings.
export function isNonZeroYoctoString(value) {
  return (
    typeof value === "string" &&
    /^\d+$/.test(value) &&
    /[1-9]/.test(value)
  );
}

export function assertAllowanceYocto(value, flag = "--allowance") {
  if (!isNonZeroYoctoString(value)) {
    throw new Error(
      `Invalid ${flag} ${JSON.stringify(value)}: pass an explicit non-zero ` +
        "yoctoNEAR decimal string. Note 0 means a zero budget (every tx " +
        "fails) on the off-chain AddKey path, not unlimited.",
    );
  }
  return value;
}

// Convert a decimal NEAR string ("0.5", "50") to a yoctoNEAR decimal string.
export function nearToYoctoString(amountNear, flag = "amount") {
  if (typeof amountNear !== "string" || !/^\d+(\.\d+)?$/.test(amountNear)) {
    throw new Error(`Invalid ${flag} ${JSON.stringify(amountNear)}: expected a decimal NEAR amount.`);
  }
  const [whole, frac = ""] = amountNear.split(".");
  if (frac.length > 24) {
    throw new Error(`Invalid ${flag} ${JSON.stringify(amountNear)}: more than 24 decimal places.`);
  }
  const padded = (frac + "0".repeat(24)).slice(0, 24);
  const normalized = whole.replace(/^0+(?=\d)/, "");
  return (BigInt(normalized) * 10n ** 24n + BigInt(padded || "0")).toString();
}

// Parse `--count` into a positive integer. Rejects 0, NaN, fractions.
export function parseCount(raw) {
  const count = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid --count ${JSON.stringify(raw)}: expected a positive integer.`);
  }
  return count;
}

// Repo root derived from this file's location (<root>/scripts/lib/).
export function repoRootFromHere() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..");
}

export function keystoreDir(repoRoot) {
  return join(repoRoot, "scripts", KEYSTORE_DIR_NAME);
}

export function keystorePath(repoRoot, fullAccountId) {
  assertValidAccountId(fullAccountId);
  return join(keystoreDir(repoRoot), `${fullAccountId}.json`);
}

// Read a keystore entry. Returns null when the file does not exist; throws
// on malformed JSON so a corrupt entry fails closed instead of being ignored.
export function readKeystore(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Malformed keystore file at ${filePath}: ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Malformed keystore file at ${filePath}: expected a JSON object.`);
  }
  return parsed;
}

// Write a keystore entry, creating the directory as needed. The file holds
// live private keys, so it is created with mode 0o600.
export function writeKeystore(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}
