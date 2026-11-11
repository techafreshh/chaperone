// Offline tests for the evidence re-checker (issue #66).
// Pure `node:test` + `assert/strict` plus a stub HTTP server: helpers are
// unit-tested with a locally signed bundle (ethers `Wallet`), then the
// script itself is spawned as a child process against the stub for the four
// acceptance vectors (matching bundle, one-byte mutation, wrong signer,
// fixture bundle).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import {
  canonicalBundle,
  recoverEvidenceSigner,
  sha256HexText,
  signedEvidenceText,
} from "./verify-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "verify-evidence.mjs");

const MODEL = "qwen3-30b-fixture";

async function makeBundle({ signer, address, fixture = false, chatId = "chatcmpl-test-1" }) {
  const requestHash = createHash("sha256").update("request-bytes", "utf8").digest("hex");
  const responseHash = createHash("sha256").update("response-bytes", "utf8").digest("hex");
  const message = `${MODEL}:${requestHash}:${responseHash}`;
  const signature = await signer.signMessage(message);
  return {
    chat_id: chatId,
    filtered: false,
    fixture,
    model: MODEL,
    preflight_nonce: "nonce-1",
    request_sha256: requestHash,
    response_sha256: responseHash,
    signature,
    signing_address: address,
  };
}

function bundleHash(bundle) {
  return createHash("sha256").update(canonicalBundle(bundle), "utf8").digest("hex");
}

describe("canonicalBundle / sha256HexText", () => {
  it("sorts keys with no whitespace (canonicalEvidence semantics)", () => {
    assert.equal(canonicalBundle({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(
      canonicalBundle({ model: "m", chat_id: "c", fixture: true }),
      '{"chat_id":"c","fixture":true,"model":"m"}',
    );
  });

  it("is order-insensitive, so the committed hash is stable", () => {
    const a = { chat_id: "c", fixture: true, model: MODEL };
    const b = { model: MODEL, fixture: true, chat_id: "c" };
    assert.equal(canonicalBundle(a), canonicalBundle(b));
    assert.equal(sha256HexText(canonicalBundle(a)), bundleHash(b));
  });
});

describe("signedEvidenceText / recoverEvidenceSigner", () => {
  it("uses the <model>:<request>:<response> grammar and recovers the signer", async () => {
    const wallet = Wallet.createRandom();
    const bundle = await makeBundle({ signer: wallet, address: wallet.address });
    assert.equal(
      signedEvidenceText(bundle),
      `${MODEL}:${bundle.request_sha256}:${bundle.response_sha256}`,
    );
    assert.equal(recoverEvidenceSigner(bundle).toLowerCase(), wallet.address.toLowerCase());
  });
});

describe("verify-evidence.mjs acceptance vectors", () => {
  let server = null;
  let base = "";
  // Mutable stub state per vector: the served bundle plus the recorded hash.
  const state = { bundle: null, expectedHash: null };

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/api/evidence/5") {
        if (state.bundle === null) return json(404, { error: "evidence not found" });
        return json(200, state.bundle);
      }
      if (url.pathname === "/api/verify" || url.pathname === "/verify") {
        if (url.searchParams.get("request_id") !== "5" || state.expectedHash === null) {
          return json(404, { error: "Request not found" });
        }
        return json(200, { request_id: 5, status: "paid", evidence_sha256: state.expectedHash });
      }
      if (url.pathname === "/api/requests") {
        if (state.expectedHash === null) return json(200, []);
        return json(200, [{ request_id: 5, evidence_sha256: state.expectedHash }]);
      }
      return json(404, { error: "not found" });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // Async spawn (never spawnSync): the stub server lives on this process's
  // event loop, so blocking it would deadlock the child waiting on HTTP.
  function run() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, "5", "--base-url", base]);
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

  it("matching bundle exits 0 with hash PASS and signer PASS", async () => {
    const wallet = Wallet.createRandom();
    state.bundle = await makeBundle({ signer: wallet, address: wallet.address });
    state.expectedHash = bundleHash(state.bundle);
    const result = await run();
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^fetch: PASS/m);
    assert.match(result.stdout, /^hash: PASS/m);
    assert.match(result.stdout, /^signer: PASS/m);
    assert.match(result.stdout, /^attestation: PASS/m);
  });

  it("one changed byte FAILs the hash step with a non-zero exit", async () => {
    const wallet = Wallet.createRandom();
    const original = await makeBundle({ signer: wallet, address: wallet.address });
    state.expectedHash = bundleHash(original);
    state.bundle = { ...original, chat_id: `${original.chat_id}X` };
    const result = await run();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^hash: FAIL/m);
  });

  it("a signature from another key FAILs the signer step", async () => {
    const issuer = Wallet.createRandom();
    const attested = Wallet.createRandom();
    state.bundle = await makeBundle({ signer: issuer, address: attested.address });
    state.expectedHash = bundleHash(state.bundle);
    const result = await run();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^hash: PASS/m);
    assert.match(result.stdout, /^signer: FAIL/m);
  });

  it("a fixture bundle prints attestation fixture and never PASS", async () => {
    const wallet = Wallet.createRandom();
    state.bundle = await makeBundle({
      signer: wallet,
      address: wallet.address,
      fixture: true,
    });
    state.expectedHash = bundleHash(state.bundle);
    const result = await run();
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^hash: PASS/m);
    assert.match(result.stdout, /^signer: PASS/m);
    const attestation = result.stdout.match(/^attestation: .*$/m);
    assert.ok(attestation !== null);
    assert.equal(attestation[0], "attestation: fixture");
  });
});
