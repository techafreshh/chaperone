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
  canonicalEvidence,
  CLOUD_BASE_URL_DEFAULT,
  containsJudgeInstructions,
  fixtureJudgeWordOverlap,
  judgeModel,
  MEMO_FILTER_OBJECTION,
  type EvidenceBundle,
} from "./judge.js";
import {
  compareHashes,
  fetchCompletionSignature,
  sha256HexText,
  verifyBinding,
} from "./bind.js";
import {
  getLastVerified,
  recordJudgeOutcome,
  runPreflight,
} from "./preflight.js";

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
  memo: string;
  status: string;
  reason?: string | null;
}

export interface PurposeRefShape {
  ref_id: string;
  vendor: string;
  payee: string;
  description: string;
  remaining_yocto: string;
  open: boolean;
}

export interface ChainAdapter {
  readonly contractId: string;
  getRequest(requestId: number): Promise<PaymentRequestShape | null>;
  getPurposeRef(refId: string): Promise<PurposeRefShape | null>;
  submitVerdict(
    requestId: number,
    consistent: boolean,
    evidenceSha256: string,
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
  memo?: string;
}

export interface SeedPurposeRef {
  ref_id: string;
  vendor?: string;
  payee?: string;
  description?: string;
  remaining_yocto?: string;
  open?: boolean;
}

const FIVE_NEAR_YOCTO = `5${"0".repeat(24)}`;

// In-memory chain fixture: seeds staged requests (ids 1-6, so the probe's
// request 5 exists) and enforces contract-identical submit semantics —
// staged-only transitions plus Ed25519 verification against the registered
// verifier key (mirrors `submit_verdict`: "Request not found",
// "Request is not staged", "Invalid verdict signature").
export class InMemoryChain implements ChainAdapter {
  readonly contractId: string;
  private readonly requests = new Map<number, PaymentRequestShape>();
  private readonly refs = new Map<string, PurposeRefShape>();
  private readonly verifierPublicKey: Buffer;

  constructor(opts?: {
    seeds?: SeedRequest[];
    refs?: SeedPurposeRef[];
    verifierPublicKey?: Uint8Array;
    contractId?: string;
  }) {
    this.contractId = opts?.contractId ?? "guard.testnet";
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
        memo: seed.memo ?? "GPU hours, October 2026",
        status: "staged",
        reason: null,
      });
    }
    const refSeeds: SeedPurposeRef[] = opts?.refs ?? [
      {
        ref_id: "invoice-114",
        vendor: "CoreWeave",
        payee: "payee.near",
        description: "GPU hours, October 2026",
        remaining_yocto: `2${"0".repeat(25)}`,
        open: true,
      },
    ];
    for (const ref of refSeeds) {
      this.refs.set(ref.ref_id, {
        ref_id: ref.ref_id,
        vendor: ref.vendor ?? "CoreWeave",
        payee: ref.payee ?? "payee.near",
        description: ref.description ?? "",
        remaining_yocto: ref.remaining_yocto ?? "0",
        open: ref.open ?? true,
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

  async getPurposeRef(refId: string): Promise<PurposeRefShape | null> {
    const ref = this.refs.get(refId);
    return ref === undefined ? null : { ...ref };
  }

  async submitVerdict(
    requestId: number,
    consistent: boolean,
    evidenceSha256: string,
    signatureBase58: string,
  ): Promise<{ status: string }> {
    const record = this.requests.get(requestId);
    if (record === undefined) throw new Error("Request not found");
    if (record.status !== "staged") throw new Error("Request is not staged");
    if (!/^[0-9a-fA-F]{64}$/.test(evidenceSha256))
      throw new Error("Invalid evidence sha256");
    let signature: Buffer;
    try {
      signature = Buffer.from(bs58.decode(signatureBase58));
    } catch {
      throw new Error("Invalid verdict signature");
    }
    if (signature.length !== 64) throw new Error("Invalid verdict signature");
    const payload = buildVerdictPayload(record, consistent, {
      contractId: this.contractId,
      evidenceSha256,
    });
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
// `domain || le_u32(len(contract)) || contract || le_u64(id) ||
// le_u32(len(agent)) || agent || le_u32(len(payee)) || payee ||
// le_u128(amount) || le_u32(len(ref)) || ref || sha256(memo) || evidence ||
// byte` with verdict byte 1 for consistent, 0 for inconsistent.
export function buildVerdictPayload(
  request: PaymentRequestShape,
  consistent: boolean,
  opts: { contractId: string; evidenceSha256: string },
): Buffer {
  if (typeof opts.contractId !== "string" || opts.contractId === "")
    throw new Error("buildVerdictPayload needs a contractId");
  if (!/^[0-9a-fA-F]{64}$/.test(opts.evidenceSha256))
    throw new Error("buildVerdictPayload needs evidenceSha256 as 64 hex chars");
  const domain = Buffer.from("chaperone-verdict-v2", "utf8");
  const contractId = Buffer.from(opts.contractId, "utf8");
  const agent = Buffer.from(request.agent_id, "utf8");
  const payee = Buffer.from(request.payee, "utf8");
  const ref = Buffer.from(request.purpose_ref, "utf8");
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(request.request_id));
  const amount = toLe128(request.amount_yocto);
  const memoHash = sha256HexText(request.memo ?? "");
  const evidence = Buffer.from(opts.evidenceSha256, "hex");
  const prefix = (bytes: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    return Buffer.concat([len, bytes]);
  };
  return Buffer.concat([
    domain,
    prefix(contractId),
    id,
    prefix(agent),
    prefix(payee),
    amount,
    prefix(ref),
    Buffer.from(memoHash, "hex"),
    evidence,
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
  chain: ChainAdapter;
  keys: VerifierKeys;
  model: string;
}

// Judge-side objection memory: the contract stores no objection on held
// rows, so the verifier keeps the latest objection per request for the
// queue display (same pattern as the MCP `objections` fixture store).
const verdictObjections = new Map<number, string>();

export function getVerdictObjection(requestId: number): string | null {
  return verdictObjections.get(requestId) ?? null;
}

function recordVerdictObjection(
  requestId: number,
  objection: string | undefined,
): void {
  if (objection === undefined || objection === "") {
    verdictObjections.delete(requestId);
  } else {
    verdictObjections.set(requestId, objection);
  }
}

// Test seam: drop the module-level objection memory.
export function __resetVerdictObjectionsForTests(): void {
  verdictObjections.clear();
}

export interface JudgeAndBindOptions {
  judgeInput: {
    request_id: number;
    agent_id: string;
    payee: string;
    amount_yocto: string;
    purpose_ref: string;
    vendor: string;
    memo: string;
    description: string;
    remaining_yocto: string;
  };
  apiKey: string;
  cloudBaseUrl: string;
  httpJudge: boolean;
  model: string;
  judgeModelId: string;
  fetchImpl?: typeof fetch;
  tamper: VerifyTamper | undefined;
  expectedAddresses?: string[];
  storedAddress?: string;
  fixtureWalletAddress: string;
  fixtureSign: (message: string) => Promise<string>;
}

export type JudgeAndBindResult =
  | {
    ok: true;
    consistent: boolean;
    objection?: string;
    chatId: string;
    requestHash: string;
    responseHash: string;
    signature: string;
    signingAddress: string;
  }
  | { ok: false; reason: string; recordReason: string; transportError?: boolean };

// Judge (model call or fixture overlap rule) plus bind (hash comparison
// and signer recovery for the HTTP path; fixture-issued signature for
// the local path). Refusals carry the failed check in `recordReason` for
// the badge store and the wire message in `reason`.
async function judgeAndBind(opts: JudgeAndBindOptions): Promise<JudgeAndBindResult> {
  if (opts.httpJudge) {
    const judged = await judgeModel({
      baseUrl: opts.cloudBaseUrl,
      model: opts.model,
      apiKey: opts.apiKey,
      request: opts.judgeInput,
      fetchImpl: opts.fetchImpl,
    });
    if (!judged.ok) {
      // Transport failures leave badge state untouched (mirror the
      // preflight `transportError` mapping); only evidence that exists
      // but refuses to parse is recorded.
      if (judged.transportError === true) {
        return { ok: false, reason: judged.reason, recordReason: judged.reason, transportError: true };
      }
      return { ok: false, reason: judged.reason, recordReason: `judge: ${judged.reason}` };
    }
    // Fetch the completion signature, then bind: hash comparison plus
    // signer recovery vs the stored attestation address.
    let text: string;
    let signature: string;
    try {
      const fetched = await fetchCompletionSignature({
        baseUrl: opts.cloudBaseUrl,
        chatId: judged.chatId,
        model: opts.model,
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
      });
      text = fetched.text;
      signature = fetched.signature;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason, recordReason: `bind: ${reason}` };
    }
    const effectiveResponseHash = opts.tamper === "bad-signature"
      ? flipFirstHex(judged.responseHash)
      : judged.responseHash;
    const compared = compareHashes(
      text,
      judged.requestHash,
      effectiveResponseHash,
      opts.judgeModelId,
    );
    if (!compared.valid) {
      const reason = compared.reason ?? "hash mismatch";
      return { ok: false, reason, recordReason: `bind: ${reason}` };
    }
    const expectedAddresses = opts.tamper === "wrong-signer"
      ? ["0x0000000000000000000000000000000000000001"]
      : (opts.expectedAddresses ??
        (opts.storedAddress !== undefined ? [opts.storedAddress] : []));
    const binding = await verifyBinding({ text, signature, expectedAddresses });
    if (!binding.verified) {
      const reason = binding.reason ?? "signer mismatch";
      return { ok: false, reason, recordReason: `bind: ${reason}` };
    }
    return {
      ok: true,
      consistent: judged.consistent,
      ...(judged.objection !== undefined ? { objection: judged.objection } : {}),
      chatId: judged.chatId,
      requestHash: judged.requestHash,
      responseHash: judged.responseHash,
      signature,
      signingAddress: binding.recoveredAddress ?? "",
    };
  }
  // No-key local fixture judgment: the deterministic word-overlap rule
  // with exact-bytes hashing identical to the HTTP path, "issued" by
  // the fixture wallet so binding targets it.
  const overlap = fixtureJudgeWordOverlap(opts.judgeInput.memo, opts.judgeInput.description);
  const requestText = JSON.stringify({
    model: opts.judgeModelId,
    messages: buildJudgePrompt(opts.judgeInput),
  });
  const chatId = `chatcmpl-local-${randomBytes(8).toString("hex")}`;
  const responseText = JSON.stringify({
    id: chatId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.judgeModelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify(
            overlap.consistent
              ? { consistent: true }
              : { consistent: false, objection: overlap.objection },
          ),
        },
        finish_reason: "stop",
      },
    ],
  });
  const requestHash = sha256HexText(requestText);
  const responseHash = sha256HexText(responseText);
  const signedText = `${opts.judgeModelId}:${requestHash}:${responseHash}`;
  const signature = await opts.fixtureSign(signedText);
  // Bind the fixture issuance exactly like the HTTP path (hash
  // comparison plus signer recovery), so the tamper vectors refuse on
  // the local path too.
  const effectiveResponseHash = opts.tamper === "bad-signature"
    ? flipFirstHex(responseHash)
    : responseHash;
  const compared = compareHashes(
    signedText,
    requestHash,
    effectiveResponseHash,
    opts.judgeModelId,
  );
  if (!compared.valid) {
    const reason = compared.reason ?? "hash mismatch";
    return { ok: false, reason, recordReason: `bind: ${reason}` };
  }
  const expectedAddresses = opts.tamper === "wrong-signer"
    ? ["0x0000000000000000000000000000000000000001"]
    : (opts.expectedAddresses ?? [opts.fixtureWalletAddress]);
  const binding = await verifyBinding({
    text: signedText,
    signature,
    expectedAddresses,
  });
  if (!binding.verified) {
    const reason = binding.reason ?? "signer mismatch";
    return { ok: false, reason, recordReason: `bind: ${reason}` };
  }
  return {
    ok: true,
    consistent: overlap.consistent,
    ...(overlap.objection !== undefined ? { objection: overlap.objection } : {}),
    chatId,
    requestHash,
    responseHash,
    signature,
    signingAddress: opts.fixtureWalletAddress,
  };
}

// Build a matched handler + chain pair: the chain's registered verifier key
// is derived from the same signing key the handler signs with. An explicit
// `chain` (in-memory fixture or live `near-api-js` adapter) is used as-is;
// otherwise a seeded in-memory fixture store is created. Prefer this over
// hand-wiring the two separately.
export function createVerifyStack(opts: VerifyHandlerOptions = {}): VerifyStack {
  const keys = opts.resolvedKeys ?? resolveVerifierKeys(opts.signingKey);
  const chain: ChainAdapter = opts.chain ??
    new InMemoryChain({
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

    // Load the cited purpose ref: the judge receives its description,
    // vendor and remaining amount alongside the memo.
    let ref: PurposeRefShape | null;
    try {
      ref = await chain.getPurposeRef(record.purpose_ref);
    } catch (error) {
      return {
        status: 502,
        body: {
          error: `chain lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          request_id: requestId,
        },
      };
    }
    if (ref === null) {
      return {
        status: 502,
        body: { error: "purpose ref not found", request_id: requestId },
      };
    }
    const memo = typeof record.memo === "string" ? record.memo : "";
    const judgeInput = {
      request_id: record.request_id,
      agent_id: record.agent_id,
      payee: record.payee,
      amount_yocto: record.amount_yocto,
      purpose_ref: record.purpose_ref,
      vendor: record.vendor,
      memo,
      description: ref.description,
      remaining_yocto: ref.remaining_yocto,
    };

    // 0. Deterministic memo filter, before any fetch: an
    // instruction-shaped memo never reaches the model, so a filtered
    // memo records zero model calls.
    let consistent: boolean;
    let objection: string | undefined;
    let filtered = false;
    let chatId = "";
    let requestHash = "";
    let responseHash = "";
    let signature = "";
    let signingAddress = "";
    let preflightNonce = "";
    if (containsJudgeInstructions(memo)) {
      consistent = false;
      objection = MEMO_FILTER_OBJECTION;
      filtered = true;
    } else {
      const preflight = await runPreflight({
        model: model !== "" ? model : undefined,
        apiKey: opts.apiKey ?? process.env.NEAR_AI_API_KEY ?? undefined,
        fetchImpl: opts.fetchImpl,
      });
      if (preflight.transportError === true) {
        return {
          status: 502,
          body: { error: preflight.reason ?? "attestation fetch failed", request_id: requestId },
        };
      }
      preflightNonce = preflight.request_nonce;
      const judged = await judgeAndBind({
        judgeInput,
        apiKey,
        cloudBaseUrl,
        httpJudge,
        model,
        judgeModelId,
        fetchImpl: opts.fetchImpl,
        tamper,
        expectedAddresses: opts.expectedAddresses,
        storedAddress: getLastVerified()?.signingAddress,
        fixtureWalletAddress: fixtureWallet.address,
        fixtureSign: (message: string) => fixtureWallet.signMessage(message),
      });
      if (!judged.ok) {
        if (judged.transportError === true) {
          return {
            status: 502,
            body: { error: judged.reason, request_id: requestId },
          };
        }
        recordJudgeOutcome({
          verified: false,
          reason: judged.recordReason,
          model: judgeModelId,
          fixture: true,
        });
        return {
          status: 502,
          body: { error: judged.reason, request_id: requestId },
        };
      }
      consistent = judged.consistent;
      objection = judged.objection;
      chatId = judged.chatId;
      requestHash = judged.requestHash;
      responseHash = judged.responseHash;
      signature = judged.signature;
      signingAddress = judged.signingAddress;
    }

    // Evidence bundle (canonical JSON, sorted keys, no whitespace): the
    // sha256 of these exact bytes binds the verdict payload. Fixture
    // runs build the same shape with `"fixture": true`.
    const evidenceBundle: EvidenceBundle = {
      chat_id: chatId,
      filtered,
      fixture: judgeFixture,
      model: judgeModelId,
      preflight_nonce: preflightNonce,
      request_sha256: requestHash,
      response_sha256: responseHash,
      signature,
      signing_address: signingAddress,
    };
    const evidenceSha256 = sha256HexText(canonicalEvidence(evidenceBundle));
    recordVerdictObjection(requestId, objection);

    // Sign the v2 canonical payload and submit on-chain.
    if (keys === null) keys = resolveVerifierKeys(opts.signingKey);
    const payload = buildVerdictPayload(record, consistent, {
      contractId: chain.contractId,
      evidenceSha256,
    });
    const signatureBase58 = signVerdictPayload(payload, keys);
    try {
      await chain.submitVerdict(requestId, consistent, evidenceSha256, signatureBase58);
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
    // the verdict is not TEE-verified). A live memo-filter verdict is
    // likewise unverifiable: it carries no TEE evidence at all.
    const fixture = judgeFixture || keys.testKey;
    recordJudgeOutcome({
      verified: true,
      model: judgeModelId,
      fixture,
      ...(fixture
        ? { reason: "fixture judgment is not TEE-verified" }
        : filtered && objection !== undefined
          ? { reason: objection }
          : {}),
      ...(signingAddress !== "" ? { signingAddress } : {}),
    });
    return {
      status: 200,
      body: {
        consistent,
        ...(objection !== undefined ? { objection } : {}),
        signature: signatureBase58,
        evidence_sha256: evidenceSha256,
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

// Normalize a `get_request` view result into the handler's request shape.
// The contract stores `amount_yocto` as `U128` (JSON string); accept a
// plain number defensively so both encodings map to the canonical string.
function normalizeViewRequest(value: unknown): PaymentRequestShape | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const requestId = Number(record.request_id);
  if (!Number.isInteger(requestId) || requestId <= 0) return null;
  if (typeof record.status !== "string") return null;
  const amountRaw = record.amount_yocto;
  const amountYocto = typeof amountRaw === "string"
    ? amountRaw
    : typeof amountRaw === "number" &&
        Number.isInteger(amountRaw) &&
        amountRaw >= 0
    ? String(amountRaw)
    : null;
  if (amountYocto === null || !/^\d+$/.test(amountYocto)) return null;
  return {
    request_id: requestId,
    agent_id: typeof record.agent_id === "string" ? record.agent_id : "",
    payee: typeof record.payee === "string" ? record.payee : "",
    amount_yocto: amountYocto,
    purpose_ref: typeof record.purpose_ref === "string"
      ? record.purpose_ref
      : "",
    vendor: typeof record.vendor === "string" ? record.vendor : "",
    memo: typeof record.memo === "string" ? record.memo : "",
    status: record.status,
    reason: typeof record.reason === "string" ? record.reason : null,
  };
}

function normalizePurposeRefView(value: unknown): PurposeRefShape | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ref_id !== "string" || record.ref_id === "") return null;
  const remainingRaw = record.remaining_yocto;
  const remaining = typeof remainingRaw === "string" && /^\d+$/.test(remainingRaw)
    ? BigInt(remainingRaw).toString()
    : "0";
  return {
    ref_id: record.ref_id,
    vendor: typeof record.vendor === "string" ? record.vendor : "",
    payee: typeof record.payee === "string" ? record.payee : "",
    description: typeof record.description === "string" ? record.description : "",
    remaining_yocto: remaining,
    open: record.open !== false,
  };
}

// v7 `near-api-js` module shape the live adapter drives (unsigned reads
// via `JsonRpcProvider.query`, signed writes via `KeyPairSigner` plus
// `Account.callFunction`). Mirrors the already-fixed live write path in
// `mcp/src/tools.ts` (`KeyPairSigner.fromSecretKey`) and the
// unsigned-read shape in `scripts/attack-suite.mjs`.
export interface NearApiModuleShape {
  JsonRpcProvider: new (args: { url: string }) => {
    query(args: Record<string, unknown>): Promise<{ result: Uint8Array }>;
  };
  Account: new (
    accountId: string,
    provider: unknown,
    signer: unknown,
  ) => {
    callFunction(args: {
      contractId: string;
      methodName: string;
      args: Record<string, unknown>;
      gas: bigint;
    }): Promise<unknown>;
  };
  KeyPairSigner: { fromSecretKey(secretKey: string): unknown };
}

// Gas attached to `submit_verdict`: 30 TGas, matching every script write
// path in this repo (e.g. `CALL_GAS` in `scripts/attack-suite.mjs`).
// Written without BigInt literals: this module is also type-checked by
// the app's ES2017 `next build`, which rejects the `30n` literal form.
export const SUBMIT_VERDICT_GAS = BigInt(30) * BigInt(10) ** BigInt(12);

// Resolve the RPC endpoint: explicit `nodeUrl` first, then `NEAR_RPC_URL`,
// then the legacy `NEAR_NODE_URL`, else the network default. `networkId`
// is retained only to pick that default.
export function resolveNearRpcUrl(
  opts: { nodeUrl?: string; networkId?: string } = {},
): string {
  if (opts.nodeUrl !== undefined && opts.nodeUrl !== "") return opts.nodeUrl;
  const envRpc = process.env.NEAR_RPC_URL;
  if (envRpc !== undefined && envRpc !== "") return envRpc;
  const envNode = process.env.NEAR_NODE_URL;
  if (envNode !== undefined && envNode !== "") return envNode;
  const network = opts.networkId ?? process.env.NEAR_NETWORK ?? "testnet";
  return network === "mainnet"
    ? "https://rpc.mainnet.near.org"
    : "https://rpc.testnet.near.org";
}

// Assert the loaded module exposes the v7 surface; the removed pre-v7
// `connect`/`keyStores` shape fails here with the `live chain
// unavailable` error instead of a bare `TypeError` downstream.
function requireNearApi(mod: unknown): NearApiModuleShape {
  const shape = mod as Partial<NearApiModuleShape> | null | undefined;
  if (
    shape === null ||
    shape === undefined ||
    typeof shape.JsonRpcProvider !== "function" ||
    typeof shape.Account !== "function" ||
    shape.KeyPairSigner === undefined ||
    shape.KeyPairSigner === null ||
    typeof (shape.KeyPairSigner as { fromSecretKey?: unknown })
      .fromSecretKey !== "function"
  ) {
    throw new Error(
      "live chain unavailable: near-api-js module lacks the v7 JsonRpcProvider/Account/KeyPairSigner surface",
    );
  }
  return shape as NearApiModuleShape;
}

export interface NearChainOptions {
  contractId: string;
  accountId: string;
  privateKey: string;
  networkId?: string;
  nodeUrl?: string;
  // Legacy seam kept for signature compatibility: v7 `JsonRpcProvider`
  // exposes no `fetch` hook, so the SDK provider uses global fetch.
  fetchImpl?: typeof fetch;
  // Injected-module seam for tests: a fake v7 `near-api-js` shape so unit
  // tests never touch the network. Defaults to the lazy dynamic import.
  nearApi?: NearApiModuleShape;
}

// Live chain adapter on the `near-api-js` v7 surface: unsigned
// `provider.query` reads plus `Account.callFunction` writes (selected
// when the contract env is set). Never constructed in the fixture/test
// path.
export function createNearChainAdapter(
  opts: NearChainOptions,
): ChainAdapter {
  const networkId = opts.networkId ?? process.env.NEAR_NETWORK ?? "testnet";
  async function loadModule(): Promise<NearApiModuleShape> {
    if (opts.nearApi !== undefined) return requireNearApi(opts.nearApi);
    return requireNearApi(await loadNearApi());
  }
  return {
    contractId: opts.contractId,
    async getRequest(requestId: number): Promise<PaymentRequestShape | null> {
      const mod = await loadModule();
      const provider = new mod.JsonRpcProvider({
        url: resolveNearRpcUrl({ nodeUrl: opts.nodeUrl, networkId }),
      });
      const res = await provider.query({
        request_type: "call_function",
        account_id: opts.contractId,
        method_name: "get_request",
        args_base64: Buffer.from(
          JSON.stringify({ request_id: requestId }),
        ).toString("base64"),
        finality: "final",
      });
      const raw = Buffer.from(res.result).toString();
      const parsed: unknown = raw === "" ? null : JSON.parse(raw);
      if (parsed === null || parsed === undefined) return null;
      return normalizeViewRequest(parsed);
    },
    async getPurposeRef(refId: string): Promise<PurposeRefShape | null> {
      const mod = await loadModule();
      const provider = new mod.JsonRpcProvider({
        url: resolveNearRpcUrl({ nodeUrl: opts.nodeUrl, networkId }),
      });
      const res = await provider.query({
        request_type: "call_function",
        account_id: opts.contractId,
        method_name: "get_purpose_ref",
        args_base64: Buffer.from(
          JSON.stringify({ ref_id: refId }),
        ).toString("base64"),
        finality: "final",
      });
      const raw = Buffer.from(res.result).toString();
      const parsed: unknown = raw === "" ? null : JSON.parse(raw);
      if (parsed === null || parsed === undefined) return null;
      return normalizePurposeRefView(parsed);
    },
    async submitVerdict(
      requestId: number,
      consistent: boolean,
      evidenceSha256: string,
      signatureBase58: string,
    ): Promise<{ status: string }> {
      const mod = await loadModule();
      const provider = new mod.JsonRpcProvider({
        url: resolveNearRpcUrl({ nodeUrl: opts.nodeUrl, networkId }),
      });
      // v7 `Account` accepts a `Signer` (or a secret string), never a raw
      // `KeyPair` object (`KeyPair` has no `signTransaction`, so the write
      // path would throw into a 500). Build the signer exactly as the
      // already-fixed MCP live adapter does.
      const signer = mod.KeyPairSigner.fromSecretKey(opts.privateKey);
      const account = new mod.Account(opts.accountId, provider, signer);
      await account.callFunction({
        contractId: opts.contractId,
        methodName: "submit_verdict",
        args: {
          request_id: requestId,
          consistent,
          evidence_sha256: evidenceSha256,
          signature_base58: signatureBase58,
        },
        gas: SUBMIT_VERDICT_GAS,
      });
      return { status: consistent ? "paid" : "held" };
    },
  };
}
