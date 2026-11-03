import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import bs58 from "bs58";
import { Wallet } from "ethers";
import {
  buildJudgePrompt,
  CLOUD_BASE_URL_DEFAULT,
  judgeModel,
} from "./judge.js";
import {
  compareHashes,
  fetchCompletionSignature,
  sha256HexText,
  verifyBinding,
} from "./bind.js";
import { getLastVerified, recordJudgeOutcome } from "./preflight.js";

// Verifier judge-bind-sign-submit pipeline as a framework-agnostic
// factory. `POST /verify` in the Next service is a thin route over
// `createVerifyHandler()`: load the staged request via the chain adapter,
// judge request-vs-reason through the catalog model, bind the completion to
// the attested TEE instance (hash comparison + EIP-191 signer recovery vs
// the stored address), Ed25519-sign the canonical verdict payload, submit
// on-chain, and record badge state. Fixture/test-key verdicts never map to
// badge `verified` (honesty rule).

export interface PaymentRequestShape {
  request_id: number;
  agent_id: string;
  payee: string;
  amount_yocto: string;
  purpose_ref: string;
  vendor: string;
  status: string;
  reason?: string | null;
}

export interface ChainAdapter {
  getRequest(requestId: number): Promise<PaymentRequestShape | null>;
  submitVerdict(
    requestId: number,
    consistent: boolean,
    signatureBase58: string,
  ): Promise<{ status: string }>;
}

export interface SeedRequest {
  request_id: number;
  agent_id?: string;
  payee?: string;
  amount_yocto?: string;
  purpose_ref?: string;
  vendor?: string;
}

const FIVE_NEAR_YOCTO = `5${"0".repeat(24)}`;

// In-memory chain fixture: seeds staged requests (ids 1-6, so the probe's
// request 5 exists) and enforces contract-identical submit semantics —
// staged-only transitions plus Ed25519 verification against the registered
// verifier key (mirrors `submit_verdict`: "Request not found",
// "Request is not staged", "Invalid verdict signature").
export class InMemoryChain implements ChainAdapter {
  private readonly requests = new Map<number, PaymentRequestShape>();
  private readonly verifierPublicKey: Buffer;

  constructor(opts?: {
    seeds?: SeedRequest[];
    verifierPublicKey?: Uint8Array;
  }) {
    const seeds: SeedRequest[] = opts?.seeds ??
      [1, 2, 3, 4, 5, 6].map((id) => ({ request_id: id }));
    for (const seed of seeds) {
      this.requests.set(seed.request_id, {
        request_id: seed.request_id,
        agent_id: seed.agent_id ?? "agent.near",
        payee: seed.payee ?? "payee.near",
        amount_yocto: seed.amount_yocto ?? FIVE_NEAR_YOCTO,
        purpose_ref: seed.purpose_ref ?? "invoice-114",
        vendor: seed.vendor ?? "CoreWeave",
        status: "staged",
        reason: null,
      });
    }
    this.verifierPublicKey = Buffer.from(
      opts?.verifierPublicKey ??
        (() => {
          throw new Error("InMemoryChain requires a verifierPublicKey");
        })(),
    );
    if (this.verifierPublicKey.length !== 32)
      throw new Error("Invalid verifier public key");
  }

  async getRequest(requestId: number): Promise<PaymentRequestShape | null> {
    const record = this.requests.get(requestId);
    return record === undefined ? null : { ...record };
  }

  async submitVerdict(
    requestId: number,
    consistent: boolean,
    signatureBase58: string,
  ): Promise<{ status: string }> {
    const record = this.requests.get(requestId);
    if (record === undefined) throw new Error("Request not found");
    if (record.status !== "staged") throw new Error("Request is not staged");
    let signature: Buffer;
    try {
      signature = Buffer.from(bs58.decode(signatureBase58));
    } catch {
      throw new Error("Invalid verdict signature");
    }
    if (signature.length !== 64) throw new Error("Invalid verdict signature");
    const payload = buildVerdictPayload(record, consistent);
    const publicKey = createPublicKey({
      key: spkiDer(this.verifierPublicKey),
      format: "der",
      type: "spki",
    });
    if (!cryptoVerify(null, payload, publicKey, signature))
      throw new Error("Invalid verdict signature");
    record.status = consistent ? "paid" : "held";
    record.reason = null;
    return { status: record.status };
  }
}

// Canonical verdict payload, byte-identical to PRD §10.1 and the
// dependency `canonical_verdict_payload` (`contract/src/verifier.rs`):
// `domain || le_u64(id) || agent || payee || le_u128(amount) || ref ||
// byte` with verdict byte 1 for consistent, 0 for inconsistent.
export function buildVerdictPayload(
  request: PaymentRequestShape,
  consistent: boolean,
): Buffer {
  const domain = Buffer.from("chaperone-verdict-v1", "utf8");
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(request.request_id));
  const amount = toLe128(request.amount_yocto);
  return Buffer.concat([
    domain,
    id,
    Buffer.from(request.agent_id, "utf8"),
    Buffer.from(request.payee, "utf8"),
    amount,
    Buffer.from(request.purpose_ref, "utf8"),
    Buffer.from([consistent ? 1 : 0]),
  ]);
}

function toLe128(amountYocto: string): Buffer {
  if (!/^\d+$/.test(amountYocto)) throw new Error("invalid amount_yocto");
  const amount = BigInt(amountYocto);
  const mask64 = BigInt("0xffffffffffffffff");
  if (amount >= BigInt(1) << BigInt(128))
    throw new Error("amount_yocto out of range");
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(amount & mask64, 0);
  out.writeBigUInt64LE((amount >> BigInt(64)) & mask64, 8);
  return out;
}

function pkcs8Der(seed: Uint8Array): Buffer {
  // PKCS#8 DER prefix for an Ed25519 seed (RFC 8410).
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return Buffer.concat([prefix, Buffer.from(seed)]);
}

function spkiDer(publicKey: Uint8Array): Buffer {
  // SubjectPublicKeyInfo for Ed25519 (RFC 8410): SEQUENCE { SEQUENCE {
  // OID 1.3.101.112 }, BIT STRING { 0x00 || key } }.
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return Buffer.concat([prefix, Buffer.from(publicKey)]);
}

export interface VerifierKeys {
  privateKey: KeyObject;
  publicKeyBytes: Uint8Array;
  publicKeyBase58: string;
  // True when the key is an ephemeral test key (no VERIFIER_SIGNING_KEY).
  testKey: boolean;
}

// Resolve the Ed25519 verdict signing key: `VERIFIER_SIGNING_KEY` (raw
// 32 bytes as base64, hex, or base58) when set, else an ephemeral test key
// generated in-process. Ed25519 signing logic is identical either way.
export function resolveVerifierKeys(
  explicit?: string | Uint8Array,
): VerifierKeys {
  const raw = explicit ?? process.env.VERIFIER_SIGNING_KEY ?? "";
  if (
    (typeof raw === "string" && raw === "") ||
    (raw instanceof Uint8Array && raw.length === 0)
  ) {
    return fromSeed(randomBytes(32), true);
  }
  if (raw instanceof Uint8Array) {
    if (raw.length !== 32) throw new Error("invalid VERIFIER_SIGNING_KEY");
    return fromSeed(raw, false);
  }
  const text = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text))
    return fromSeed(Buffer.from(text, "hex"), false);
  try {
    const decoded = Buffer.from(text, "base64");
    if (decoded.length === 32 && roundTripsBase64(text, decoded))
      return fromSeed(decoded, false);
  } catch {
    // Fall through to base58.
  }
  try {
    const decoded = Buffer.from(bs58.decode(text));
    if (decoded.length === 32) return fromSeed(decoded, false);
  } catch {
    // Fall through to the error below.
  }
  throw new Error("invalid VERIFIER_SIGNING_KEY");
}

function roundTripsBase64(text: string, decoded: Buffer): boolean {
  return decoded.toString("base64") === text.replace(/\s+/g, "");
}

function fromSeed(seed: Uint8Array, testKey: boolean): VerifierKeys {
  if (seed.length !== 32) throw new Error("invalid VERIFIER_SIGNING_KEY");
  const privateKey = createPrivateKey({
    key: pkcs8Der(seed),
    format: "der",
    type: "pkcs8",
  });
  const publicDer = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  const publicKeyBytes = new Uint8Array(
    publicDer.subarray(publicDer.length - 32),
  );
  return {
    privateKey,
    publicKeyBytes,
    publicKeyBase58: bs58.encode(publicKeyBytes),
    testKey,
  };
}

// Ed25519-sign the canonical payload; the contract decodes the base58
// signature with `bs58`.
export function signVerdictPayload(
  payload: Buffer,
  keys: VerifierKeys,
): string {
  const signature = cryptoSign(null, payload, keys.privateKey);
  return bs58.encode(new Uint8Array(signature));
}

export type VerifyTamper = "wrong-signer" | "bad-signature";

function normalizeTamper(value: unknown): VerifyTamper | undefined {
  return value === "wrong-signer" || value === "bad-signature"
    ? value
    : undefined;
}

function readTamperEnv(): VerifyTamper | undefined {
  return normalizeTamper(process.env.VERIFY_TAMPER) ??
    normalizeTamper(process.env.FIXTURE_TAMPER);
}

export interface VerifyHandlerOptions {
  chain?: ChainAdapter;
  fetchImpl?: typeof fetch;
  cloudBaseUrl?: string;
  model?: string;
  apiKey?: string;
  signingKey?: string | Uint8Array;
  expectedAddresses?: string[];
  tamper?: VerifyTamper;
  seeds?: SeedRequest[];
  // Pre-resolved signing keys (set by `createVerifyStack` so the handler
  // signs with the same key the chain verifies against). Prefer the stack
  // over hand-wiring this field.
  resolvedKeys?: VerifierKeys;
}

export interface VerifyRequestInput {
  request_id?: unknown;
  tamper?: unknown;
}

export interface VerifyResponse {
  status: number;
  body: Record<string, unknown>;
}

export type VerifyHandler =
  & ((req: VerifyRequestInput) => Promise<VerifyResponse>)
  & {
    view(requestId: unknown): Promise<VerifyResponse>;
    chain: ChainAdapter;
  };

export interface VerifyStack {
  handle: VerifyHandler;
  chain: InMemoryChain;
  keys: VerifierKeys;
  model: string;
}

// Build a matched handler + in-memory chain pair: the chain's registered
// verifier key is derived from the same signing key the handler signs
// with. Prefer this over hand-wiring the two separately.
export function createVerifyStack(opts: VerifyHandlerOptions = {}): VerifyStack {
  const keys = opts.resolvedKeys ?? resolveVerifierKeys(opts.signingKey);
  const chain = opts.chain instanceof InMemoryChain
    ? opts.chain
    : new InMemoryChain({
      seeds: opts.seeds,
      verifierPublicKey: keys.publicKeyBytes,
    });
  const model = opts.model ?? process.env.NEAR_AI_MODEL ?? "";
  const handle = createVerifyHandler({ ...opts, chain, resolvedKeys: keys });
  return { handle, chain, keys, model };
}

export function createVerifyHandler(
  opts: VerifyHandlerOptions & { chain: ChainAdapter },
): VerifyHandler;
export function createVerifyHandler(opts?: VerifyHandlerOptions): VerifyHandler;
export function createVerifyHandler(
  opts: VerifyHandlerOptions = {},
): VerifyHandler {
  let keys: VerifierKeys | null = opts.resolvedKeys ?? null;
  let chain: ChainAdapter;
  if (opts.chain !== undefined) {
    chain = opts.chain;
  } else {
    const resolved = resolveVerifierKeys(opts.signingKey);
    keys = resolved;
    chain = new InMemoryChain({
      seeds: opts.seeds,
      verifierPublicKey: resolved.publicKeyBytes,
    });
  }
  // Fixture TEE wallet for the no-key local judgment path: the canned
  // judgment is "issued" by this wallet, so binding targets it.
  const fixtureWallet = Wallet.createRandom();

  const handle = (async (req: VerifyRequestInput): Promise<VerifyResponse> => {
    const requestId = req.request_id;
    if (
      typeof requestId !== "number" ||
      !Number.isInteger(requestId) ||
      requestId <= 0
    ) {
      return {
        status: 400,
        body: { error: "request_id must be a positive integer" },
      };
    }
    const tamper = normalizeTamper(req.tamper) ??
      normalizeTamper(opts.tamper) ?? readTamperEnv();

    let record: PaymentRequestShape | null;
    try {
      record = await chain.getRequest(requestId);
    } catch (error) {
      return {
        status: 502,
        body: {
          error: `chain lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          request_id: requestId,
        },
      };
    }
    if (record === null) {
      return {
        status: 404,
        body: { error: "Request not found", request_id: requestId },
      };
    }
    if (record.status !== "staged") {
      return {
        status: 409,
        body: {
          error: "Request is not staged",
          request_id: requestId,
          status: record.status,
        },
      };
    }

    const apiKey = opts.apiKey ?? process.env.NEAR_AI_API_KEY ?? "";
    const cloudBaseUrl = opts.cloudBaseUrl ??
      process.env.NEAR_AI_CLOUD_BASE_URL ?? CLOUD_BASE_URL_DEFAULT;
    const baseOverridden = opts.cloudBaseUrl !== undefined ||
      process.env.NEAR_AI_CLOUD_BASE_URL !== undefined;
    const httpJudge = apiKey !== "" || baseOverridden;
    const model = opts.model ?? process.env.NEAR_AI_MODEL ?? "";
    const judgeFixture = apiKey === "";
    const judgeModelId = httpJudge ? model : (model !== "" ? model : "fixture-model");

    // 1. Judge request vs reason.
    let consistent: boolean;
    let chatId: string;
    let requestHash: string;
    let responseHash: string;
    if (httpJudge) {
      const judged = await judgeModel({
        baseUrl: cloudBaseUrl,
        model,
        apiKey,
        request: {
          request_id: record.request_id,
          agent_id: record.agent_id,
          payee: record.payee,
          amount_yocto: record.amount_yocto,
          purpose_ref: record.purpose_ref,
          vendor: record.vendor,
          reason: record.reason,
        },
        fetchImpl: opts.fetchImpl,
      });
      if (!judged.ok) {
        // Transport failures leave badge state untouched (mirror the
        // preflight `transportError` mapping); only evidence that exists
        // but refuses to parse is recorded.
        if (judged.transportError === true) {
          return {
            status: 502,
            body: { error: judged.reason, request_id: requestId },
          };
        }
        recordJudgeOutcome({
          verified: false,
          reason: `judge: ${judged.reason}`,
          model: judgeModelId,
          fixture: true,
        });
        return {
          status: 502,
          body: { error: judged.reason, request_id: requestId },
        };
      }
      consistent = judged.consistent;
      chatId = judged.chatId;
      requestHash = judged.requestHash;
      responseHash = judged.responseHash;
    } else {
      // No-key local fixture judgment: deterministic consistent verdict
      // with exact-bytes hashing identical to the HTTP path.
      const requestText = JSON.stringify({
        model: judgeModelId,
        messages: buildJudgePrompt({
          request_id: record.request_id,
          agent_id: record.agent_id,
          payee: record.payee,
          amount_yocto: record.amount_yocto,
          purpose_ref: record.purpose_ref,
          vendor: record.vendor,
          reason: record.reason,
        }),
      });
      chatId = `chatcmpl-local-${randomBytes(8).toString("hex")}`;
      const responseText = JSON.stringify({
        id: chatId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: judgeModelId,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify({ consistent: true }) },
            finish_reason: "stop",
          },
        ],
      });
      requestHash = sha256HexText(requestText);
      responseHash = sha256HexText(responseText);
      consistent = true;
    }

    // 2. Fetch the completion signature (HTTP) or issue the fixture one.
    let text: string;
    let signature: string;
    try {
      if (httpJudge) {
        const fetched = await fetchCompletionSignature({
          baseUrl: cloudBaseUrl,
          chatId,
          model,
          apiKey,
          fetchImpl: opts.fetchImpl,
        });
        text = fetched.text;
        signature = fetched.signature;
      } else {
        const signedText = `${judgeModelId}:${requestHash}:${responseHash}`;
        text = signedText;
        signature = await fixtureWallet.signMessage(signedText);
      }
    } catch (error) {
      return {
        status: 502,
        body: {
          error: error instanceof Error ? error.message : String(error),
          request_id: requestId,
        },
      };
    }

    // 3. Bind: hash comparison, then signer recovery vs stored address.
    const effectiveResponseHash = tamper === "bad-signature"
      ? flipFirstHex(responseHash)
      : responseHash;
    const compared = compareHashes(
      text,
      requestHash,
      effectiveResponseHash,
      judgeModelId,
    );
    if (!compared.valid) {
      recordJudgeOutcome({
        verified: false,
        reason: `bind: ${compared.reason ?? "hash mismatch"}`,
        model: judgeModelId,
        fixture: true,
      });
      return {
        status: 502,
        body: {
          error: compared.reason ?? "hash mismatch",
          request_id: requestId,
        },
      };
    }
    const stored = getLastVerified()?.signingAddress;
    const expectedAddresses = tamper === "wrong-signer"
      ? ["0x0000000000000000000000000000000000000001"]
      : (opts.expectedAddresses ??
        (httpJudge ? (stored !== undefined ? [stored] : []) : [fixtureWallet.address]));
    const binding = await verifyBinding({
      text,
      signature,
      expectedAddresses,
    });
    if (!binding.verified) {
      recordJudgeOutcome({
        verified: false,
        reason: `bind: ${binding.reason ?? "signer mismatch"}`,
        model: judgeModelId,
        fixture: true,
      });
      return {
        status: 502,
        body: { error: binding.reason ?? "signer mismatch", request_id: requestId },
      };
    }

    // 4. Sign the canonical payload and submit on-chain.
    if (keys === null) keys = resolveVerifierKeys(opts.signingKey);
    const payload = buildVerdictPayload(record, consistent);
    const signatureBase58 = signVerdictPayload(payload, keys);
    try {
      await chain.submitVerdict(requestId, consistent, signatureBase58);
    } catch (error) {
      recordJudgeOutcome({
        verified: false,
        reason: `submit: ${error instanceof Error ? error.message : String(error)}`,
        model: judgeModelId,
        fixture: true,
      });
      return {
        status: 500,
        body: {
          error: error instanceof Error ? error.message : String(error),
          request_id: requestId,
        },
      };
    }

    // Fixture judgments and test-key signatures stay `unverifiable`
    // (honesty rule); only a live judgment under the real key verifies.
    // The fixture note keeps a non-empty details string on the badge
    // regardless of probe ordering (success-then-status still shows why
    // the verdict is not TEE-verified).
    const fixture = judgeFixture || keys.testKey;
    recordJudgeOutcome({
      verified: true,
      model: judgeModelId,
      fixture,
      ...(fixture
        ? { reason: "fixture judgment is not TEE-verified" }
        : {}),
      signingAddress: binding.recoveredAddress,
    });
    return {
      status: 200,
      body: {
        consistent,
        signature: signatureBase58,
        request_id: requestId,
      },
    };
  }) as VerifyHandler;

  handle.chain = chain;
  handle.view = async (requestId: unknown): Promise<VerifyResponse> => {
    if (
      typeof requestId !== "number" ||
      !Number.isInteger(requestId) ||
      requestId <= 0
    ) {
      return {
        status: 400,
        body: { error: "request_id must be a positive integer" },
      };
    }
    const record = await chain.getRequest(requestId);
    if (record === null) {
      return {
        status: 404,
        body: { error: "Request not found", request_id: requestId },
      };
    }
    return { status: 200, body: { ...record } };
  };
  return handle;
}

function flipFirstHex(hex: string): string {
  if (hex === "") return hex;
  const first = (hex[0] as string) === "0" ? "1" : "0";
  return `${first}${hex.slice(1)}`;
}

// Lazily import `near-api-js` so the live chain adapter never burdens the
// offline/CI path (same pattern as the `@phala/dcap-qvl` lazy load). The
// specifier is intentionally non-literal so typechecking never resolves the
// package statically; the operator installs it for live-tier runs.
const NEAR_API_JS_SPECIFIER = "near-api-js";
async function loadNearApi(): Promise<unknown> {
  try {
    return await import(/* webpackIgnore: true */ NEAR_API_JS_SPECIFIER);
  } catch (error) {
    throw new Error(
      `live chain unavailable: near-api-js could not be loaded (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export interface NearChainOptions {
  contractId: string;
  accountId: string;
  privateKey: string;
  networkId?: string;
  nodeUrl?: string;
  fetchImpl?: typeof fetch;
}

// Live chain adapter: `submit_verdict` through `near-api-js`, selected when
// the contract env is set. Never constructed in the fixture/test path.
export function createNearChainAdapter(
  opts: NearChainOptions,
): ChainAdapter {
  const networkId = opts.networkId ?? process.env.NEAR_NETWORK ?? "testnet";
  const nodeUrl = opts.nodeUrl ?? process.env.NEAR_NODE_URL ?? "";
  return {
    async getRequest(requestId: number): Promise<PaymentRequestShape | null> {
      const near = (await loadNearApi()) as Record<string, never>;
      void near;
      void networkId;
      void nodeUrl;
      throw new Error(
        "live chain reads are not implemented: seed request state via the fixture store",
      );
    },
    async submitVerdict(
      requestId: number,
      consistent: boolean,
      signatureBase58: string,
    ): Promise<{ status: string }> {
      const mod = (await loadNearApi()) as {
        connect: (config: unknown) => Promise<{
          account: (id: string) => Promise<{
            functionCall: (args: unknown) => Promise<unknown>;
          }>;
        }>;
        keyStores: { InMemoryKeyStore: new () => { setKey(n: string, a: string, k: unknown): Promise<void> } };
        KeyPair: { fromString(s: string): unknown };
      };
      const keyStore = new mod.keyStores.InMemoryKeyStore();
      await keyStore.setKey(
        networkId,
        opts.accountId,
        mod.KeyPair.fromString(opts.privateKey),
      );
      const near = await mod.connect({
        networkId,
        nodeUrl: nodeUrl !== "" ? nodeUrl : undefined,
        keyStore,
        ...(opts.fetchImpl !== undefined ? { fetch: opts.fetchImpl } : {}),
      });
      const account = await near.account(opts.accountId);
      await account.functionCall({
        contractId: opts.contractId,
        methodName: "submit_verdict",
        args: {
          request_id: requestId,
          consistent,
          signature_base58: signatureBase58,
        },
      });
      return { status: consistent ? "paid" : "held" };
    },
  };
}
