// Render the README "Live deployment" section from deployments/testnet.json
// (issue #67). The operator writes that file after the live deploy; it is
// not part of the repo. This script rewrites only the text between
// `<!-- deployment:start -->` and `<!-- deployment:end -->` in README.md:
// without the file the section reads exactly `Not deployed yet.`, with the
// file it lists the contract id, owner, agents, hosted app URL, and one
// line per attack gate with nearblocks transaction links. Nothing outside
// the markers is ever touched.
//
// Usage: node scripts/readme-deployment.mjs [--file PATH] [--readme PATH] [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEPLOYMENT_START = "<!-- deployment:start -->";
export const DEPLOYMENT_END = "<!-- deployment:end -->";
export const NOT_DEPLOYED = "Not deployed yet.";
export const NEARBLOCKS_TX_URL = "https://testnet.nearblocks.io/txns";
export const DEFAULT_DEPLOYMENT_FILE = "deployments/testnet.json";

// The live attack gates, in GATE_DEFS order
// (`scripts/lib/attack-gates.mjs`): over-allowance and allowlist are
// BLOCKED on-chain, purpose-mismatch is HELD, clean-transit is PAID.
export const DEPLOYMENT_GATES = [
  "over-allowance",
  "allowlist",
  "purpose-mismatch",
  "clean-transit",
];

export function deploymentUsage() {
  return [
    "usage: node scripts/readme-deployment.mjs [--file PATH] [--readme PATH] [--check]",
    "",
    "  Rewrites only the text between <!-- deployment:start --> and",
    "  <!-- deployment:end --> in README.md from a deployments/testnet.json",
    "  file written by the operator after the live deploy. Without that file",
    "  the section reads exactly \"Not deployed yet.\".",
    "",
    "  --file      deployment JSON path (default: deployments/testnet.json)",
    "  --readme    README path to update (default: README.md at the repo root)",
    "  --check     exit 1 when the section differs, without writing",
    "  --help      print this help and exit 0",
  ].join("\n");
}

export function parseReadmeDeploymentArgs(argv) {
  const out = { help: false, check: false, file: null, readme: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--check") {
      out.check = true;
    } else if (arg === "--file" || arg === "--readme") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a path value`);
      }
      out[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith("--file=") || arg.startsWith("--readme=")) {
      const eq = arg.indexOf("=");
      const value = arg.slice(eq + 1);
      if (value === "") {
        throw new Error(`${arg.slice(0, eq)} needs a path value`);
      }
      out[arg.slice(2, eq)] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

export function txUrl(hash) {
  return `${NEARBLOCKS_TX_URL}/${hash}`;
}

// Tolerate both the canonical snake_case schema and camelCase aliases so a
// hand-written operator file still renders: a gate entry is either a
// `{request_id, tx, verdict_tx}` object or a bare transaction hash string.
function gateEntry(entry) {
  if (typeof entry === "string") {
    return { requestId: "?", tx: entry, verdictTx: null };
  }
  const fields = entry !== null && typeof entry === "object" ? entry : {};
  return {
    requestId: fields.request_id ?? fields.requestId ?? fields.id ?? "?",
    tx: fields.tx ?? fields.hash ?? fields.tx_hash ?? null,
    verdictTx: fields.verdict_tx ?? fields.verdictTx ?? null,
  };
}

function renderGateLine(key, entry) {
  const { requestId, tx, verdictTx } = gateEntry(entry);
  let line = `- ${key}: request_id=${requestId}`;
  if (tx !== null && tx !== "") {
    line += `, tx ${txUrl(tx)}`;
  }
  if (verdictTx !== null && verdictTx !== "") {
    line += ` (verdict_tx ${txUrl(verdictTx)})`;
  }
  return line;
}

export function renderDeploymentSection(data) {
  if (data === null || data === undefined) {
    return NOT_DEPLOYED;
  }
  const contractId = data.contract_id ?? data.contractId ?? data.contract ?? null;
  const owner = data.owner ?? data.owner_id ?? data.ownerId ?? null;
  const deployedAt = data.deployed_at ?? data.deployedAt ?? null;
  const appUrl =
    data.app_url ?? data.appUrl ?? data.hosted_app_url ?? data.hostedAppUrl ?? null;
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const gates =
    data.gates !== null && typeof data.gates === "object" && !Array.isArray(data.gates)
      ? data.gates
      : {};
  const lines = [];
  if (contractId !== null && contractId !== "") {
    lines.push(`Contract: \`${contractId}\``);
  }
  if (owner !== null && owner !== "") {
    lines.push(`Owner: \`${owner}\``);
  }
  if (deployedAt !== null && deployedAt !== "") {
    lines.push(`Deployed at: \`${deployedAt}\``);
  }
  if (appUrl !== null && appUrl !== "") {
    lines.push(`App: ${appUrl}`);
  }
  if (agents.length > 0) {
    lines.push(`Agents: ${agents.map((agent) => `\`${agent}\``).join(", ")}`);
  }
  const ordered = [
    ...DEPLOYMENT_GATES,
    ...Object.keys(gates).filter((key) => !DEPLOYMENT_GATES.includes(key)),
  ];
  const gateLines = [];
  for (const key of ordered) {
    if (!(key in gates)) {
      continue;
    }
    gateLines.push(renderGateLine(key, gates[key]));
  }
  if (gateLines.length > 0) {
    lines.push("Attack gates (testnet):");
    lines.push(...gateLines);
  }
  if (lines.length === 0) {
    return NOT_DEPLOYED;
  }
  return lines.join("\n");
}

export function updateReadmeBody(readmeText, body) {
  const start = readmeText.indexOf(DEPLOYMENT_START);
  const end = readmeText.indexOf(DEPLOYMENT_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `README is missing the ${DEPLOYMENT_START} / ${DEPLOYMENT_END} markers.`,
    );
  }
  const before = readmeText.slice(0, start + DEPLOYMENT_START.length);
  const after = readmeText.slice(end);
  return `${before}\n${body}\n${after}`;
}

function defaultPaths() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return {
    file: join(root, DEFAULT_DEPLOYMENT_FILE),
    readme: join(root, "README.md"),
  };
}

export async function runReadmeDeployment(argv = process.argv.slice(2)) {
  const parsed = parseReadmeDeploymentArgs(argv);
  if (parsed.help === true) {
    console.log(deploymentUsage());
    return 0;
  }
  const defaults = defaultPaths();
  const filePath = resolve(parsed.file ?? defaults.file);
  const readmePath = resolve(parsed.readme ?? defaults.readme);
  let data = null;
  try {
    data = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Cannot read ${filePath}: ${error.message}`);
    }
    data = null;
  }
  const body = renderDeploymentSection(data);
  const readmeText = readFileSync(readmePath, "utf8");
  const updated = updateReadmeBody(readmeText, body);
  if (updated === readmeText) {
    console.log("Live deployment section is already up to date.");
    return 0;
  }
  if (parsed.check === true) {
    console.log("Live deployment section differs; run without --check to update it.");
    return 1;
  }
  writeFileSync(readmePath, updated);
  console.log(`Updated the Live deployment section in ${readmePath}.`);
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await runReadmeDeployment();
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    console.error(deploymentUsage());
    process.exitCode = 2;
  }
}
