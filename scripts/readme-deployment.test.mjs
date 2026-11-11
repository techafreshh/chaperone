// Tests for the README live-deployment renderer (issue #67).
// Pure `node:test` + `assert/strict` plus an end-to-end spawn: unit tests
// cover the missing-input constant, a sample object rendering the contract
// id with four nearblocks links in gate order, and marker preservation;
// the e2e copies a fixture README with sentinel text outside the markers
// into a temp dir, runs the script with `--file`/`--readme`, and asserts
// the sentinels survive while the marker body changes (and that a
// missing-file run renders exactly `Not deployed yet.`).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPLOYMENT_END,
  DEPLOYMENT_START,
  NOT_DEPLOYED,
  parseReadmeDeploymentArgs,
  renderDeploymentSection,
  updateReadmeBody,
} from "./readme-deployment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "readme-deployment.mjs");

const SAMPLE = {
  contract_id: "chaperone.testnet",
  owner: "signer.testnet",
  deployed_at: "2026-11-14T12:00:00Z",
  app_url: "https://chaperone.example.testnet",
  agents: [
    "agent-1.signer.testnet",
    "agent-2.signer.testnet",
    "agent-3.signer.testnet",
    "agent-4.signer.testnet",
  ],
  gates: {
    "over-allowance": { request_id: 1, tx: "AAA111AAA111AAA111AAA111AAA111AAA111AAA111AAA111AAA111AAA1" },
    allowlist: { request_id: 2, tx: "BBB222BBB222BBB222BBB222BBB222BBB222BBB222BBB222BBB222BBB2" },
    "purpose-mismatch": {
      request_id: 3,
      tx: "CCC333CCC333CCC333CCC333CCC333CCC333CCC333CCC333CCC333CCC3",
      verdict_tx: "VVV333VVV333VVV333VVV333VVV333VVV333VVV333VVV333VVV333VVV3",
    },
    "clean-transit": {
      request_id: 4,
      tx: "DDD444DDD444DDD444DDD444DDD444DDD444DDD444DDD444DDD444DDD4",
      verdict_tx: "VVV444VVV444VVV444VVV444VVV444VVV444VVV444VVV444VVV444VVV4",
    },
  },
};

function fixtureReadme(body) {
  return [
    "# CHAPERONE",
    "",
    "sentinel-before",
    "",
    "## Live deployment",
    "",
    DEPLOYMENT_START,
    body,
    DEPLOYMENT_END,
    "",
    "sentinel-after",
    "",
  ].join("\n");
}

describe("renderDeploymentSection", () => {
  it("renders exactly Not deployed yet. for a missing input", () => {
    assert.equal(renderDeploymentSection(null), NOT_DEPLOYED);
    assert.equal(renderDeploymentSection(undefined), NOT_DEPLOYED);
    assert.equal(NOT_DEPLOYED, "Not deployed yet.");
  });

  it("lists the contract id, owner, app URL, and agents", () => {
    const body = renderDeploymentSection(SAMPLE);
    assert.match(body, /`chaperone\.testnet`/);
    assert.match(body, /`signer\.testnet`/);
    assert.match(body, /https:\/\/chaperone\.example\.testnet/);
    assert.match(body, /`agent-1\.signer\.testnet`/);
    assert.match(body, /2026-11-14T12:00:00Z/);
  });

  it("renders one request_id line per gate with nearblocks links, in gate order", () => {
    const body = renderDeploymentSection(SAMPLE);
    const links = body.match(/https:\/\/testnet\.nearblocks\.io\/txns\/[A-Za-z0-9]+/g);
    assert.ok(links !== null && links.length >= 4);
    for (const key of ["over-allowance", "allowlist", "purpose-mismatch", "clean-transit"]) {
      assert.match(body, new RegExp(`^- ${key}: request_id=\\d+`, "m"));
    }
    const order = ["over-allowance", "allowlist", "purpose-mismatch", "clean-transit"].map(
      (key) => body.indexOf(`- ${key}:`),
    );
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.match(body, /request_id=1/);
    assert.match(body, /request_id=4/);
  });
});

describe("updateReadmeBody", () => {
  it("replaces only the text between the markers", () => {
    const before = fixtureReadme("stale body");
    const after = updateReadmeBody(before, "fresh body");
    assert.match(after, new RegExp(`${DEPLOYMENT_START}\nfresh body\n${DEPLOYMENT_END}`));
    assert.ok(!after.includes("stale body"));
    const [prefix] = before.split(DEPLOYMENT_START);
    const [, suffix] = before.split(DEPLOYMENT_END);
    assert.ok(after.startsWith(prefix));
    assert.ok(after.endsWith(suffix));
    assert.ok(after.includes("sentinel-before"));
    assert.ok(after.includes("sentinel-after"));
  });

  it("is idempotent: re-rendering the same body changes nothing", () => {
    const once = updateReadmeBody(fixtureReadme("stale"), renderDeploymentSection(null));
    assert.equal(updateReadmeBody(once, renderDeploymentSection(null)), once);
    const live = updateReadmeBody(fixtureReadme("stale"), renderDeploymentSection(SAMPLE));
    assert.equal(updateReadmeBody(live, renderDeploymentSection(SAMPLE)), live);
  });

  it("throws when the markers are absent", () => {
    assert.throws(() => updateReadmeBody("# no markers here\n", "body"), /markers/);
  });
});

describe("parseReadmeDeploymentArgs", () => {
  it("supports --help, --check, --file, and --readme, and rejects unknown flags", () => {
    assert.equal(parseReadmeDeploymentArgs(["--help"]).help, true);
    assert.equal(parseReadmeDeploymentArgs([]).check, false);
    assert.equal(parseReadmeDeploymentArgs(["--check"]).check, true);
    assert.deepEqual(parseReadmeDeploymentArgs(["--file", "a.json", "--readme", "R.md"]), {
      help: false,
      check: false,
      file: "a.json",
      readme: "R.md",
    });
    assert.equal(parseReadmeDeploymentArgs(["--file=a.json"]).file, "a.json");
    assert.throws(() => parseReadmeDeploymentArgs(["--live"]), /Unknown argument/);
    assert.throws(() => parseReadmeDeploymentArgs(["positional"]), /Unknown argument/);
  });
});

describe("readme-deployment.mjs end to end", () => {
  let dir = null;
  let readmePath = null;
  let samplePath = null;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "readme-deployment-"));
    readmePath = join(dir, "README.md");
    samplePath = join(dir, "testnet.json");
    writeFileSync(samplePath, JSON.stringify(SAMPLE));
  });

  after(() => {
    if (dir !== null) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Async spawn (never spawnSync): mirrors verify-evidence.test.mjs so a
  // future stub server on this event loop could never deadlock.
  function run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  it("--help exits 0", async () => {
    const result = await run(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--file/);
  });

  it("sample file lists the contract id and nearblocks links; sentinels survive", async () => {
    writeFileSync(readmePath, fixtureReadme("stale body"));
    const result = await run(["--file", samplePath, "--readme", readmePath]);
    assert.equal(result.status, 0);
    const updated = readFileSync(readmePath, "utf8");
    assert.ok(updated.includes("sentinel-before"));
    assert.ok(updated.includes("sentinel-after"));
    assert.ok(!updated.includes("stale body"));
    assert.match(updated, /`chaperone\.testnet`/);
    assert.match(updated, /https:\/\/testnet\.nearblocks\.io\/txns\//);
    assert.match(updated, new RegExp(`${DEPLOYMENT_START}\nContract: `));
  });

  it("missing file renders exactly Not deployed yet.", async () => {
    writeFileSync(readmePath, fixtureReadme("stale body"));
    const result = await run([
      "--file",
      join(dir, "does-not-exist.json"),
      "--readme",
      readmePath,
    ]);
    assert.equal(result.status, 0);
    const updated = readFileSync(readmePath, "utf8");
    assert.ok(updated.includes("sentinel-before"));
    assert.ok(updated.includes("sentinel-after"));
    const body = updated
      .split(DEPLOYMENT_START)[1]
      .split(DEPLOYMENT_END)[0]
      .trim();
    assert.equal(body, "Not deployed yet.");
  });
});
