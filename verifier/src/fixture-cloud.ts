import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Wallet } from "ethers";

// In-repo fixture stand-in for `https://cloud-api.near.ai/v1`, stood up
// per-test on an ephemeral port. It serves an OpenAI-compatible
// `POST /chat/completions` plus the TEE signature line
// `GET /v1/signature/<chat_id>?model=&signing_algo=ecdsa`, with the
// signature an `ethers.Wallet`-signed
// `<model>:<sha256(req)>:<sha256(res)>` (the `provider_tee` 3-part grammar
// from the NEAR verification reference) and `signing_address` equal to the
// wallet address. Tamper switches produce the negative vectors; a tampered
// pair must refuse the verdict (no submission, no on-chain call).

export interface FixtureCloudOptions {
  model?: string;
  consistent?: boolean;
  objection?: string;
  // Corrupt the signed response hash so hash comparison fails.
  tamperSignature?: boolean;
  // Sign with a different key than the reported signing_address so signer
  // recovery mismatches.
  wrongSigner?: boolean;
  // Return 404 this many times before serving a signature (exercises the
  // client's cross-TEE-node retry).
  flaky404?: number;
  // Reply with non-JSON model output (exercises malformed-output refusal).
  malformedContent?: boolean;
}

interface CompletionRecord {
  requestText: string;
  responseText: string;
}

export interface StartedFixtureCloud {
  url: string;
  model: string;
  walletAddress: string;
  signatureHits: () => number;
  close: () => Promise<void>;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(text);
}

export async function startFixtureCloud(
  opts: FixtureCloudOptions = {},
): Promise<StartedFixtureCloud> {
  const model = opts.model ?? "fixture-judge-model";
  const consistent = opts.consistent ?? true;
  const wallet = Wallet.createRandom();
  const otherWallet = Wallet.createRandom();
  const records = new Map<string, CompletionRecord>();
  let flakyRemaining = opts.flaky404 ?? 0;
  let hits = 0;

  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (request.method === "POST" && path.endsWith("/chat/completions")) {
        const requestText = await readBody(request);
        let requestedModel = model;
        try {
          const parsed = JSON.parse(requestText) as { model?: unknown };
          if (typeof parsed.model === "string" && parsed.model !== "")
            requestedModel = parsed.model;
        } catch {
          // Hash the exact bytes regardless of parseability.
        }
        const chatId = `chatcmpl-fixture-${randomBytes(8).toString("hex")}`;
        const content = opts.malformedContent === true
          ? "this is not a judgment object"
          : JSON.stringify(
            consistent
              ? { consistent: true }
              : {
                consistent: false,
                objection:
                  opts.objection ??
                  "payee is not on the purpose-ref allowlist",
              },
          );
        const responseText = JSON.stringify({
          id: chatId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
        });
        records.set(chatId, { requestText, responseText });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(responseText);
        return;
      }
      const signatureMatch = path.match(/^\/v1\/signature\/([^/]+)$/);
      if (request.method === "GET" && signatureMatch !== null) {
        hits += 1;
        const chatId = decodeURIComponent(signatureMatch[1] as string);
        if (flakyRemaining > 0) {
          flakyRemaining -= 1;
          jsonResponse(response, 404, { error: "Chat id not found or expired" });
          return;
        }
        const record = records.get(chatId);
        if (record === undefined) {
          jsonResponse(response, 404, { error: "Chat id not found or expired" });
          return;
        }
        const signedModel = url.searchParams.get("model") ?? model;
        const requestHash = sha256Hex(record.requestText);
        const responseHash = sha256Hex(record.responseText);
        const signedResponseHash = opts.tamperSignature === true
          ? flipHex(responseHash)
          : responseHash;
        const text = `${signedModel}:${requestHash}:${signedResponseHash}`;
        const signer = opts.wrongSigner === true ? otherWallet : wallet;
        const signature = await signer.signMessage(text);
        jsonResponse(response, 200, {
          text,
          signature,
          signing_address: wallet.address,
          signing_algo: "ecdsa",
          signature_kind: "provider_tee",
        });
        return;
      }
      jsonResponse(response, 404, { error: "not found" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      jsonResponse(response, 500, { error: reason });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fixture cloud failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    model,
    walletAddress: wallet.address,
    signatureHits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function flipHex(hex: string): string {
  const first = hex[0] === "0" ? "1" : "0";
  return `${first}${hex.slice(1)}`;
}
