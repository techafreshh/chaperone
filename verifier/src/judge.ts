import { sha256HexText } from "./bind.js";

// Catalog-model judge: asks a TEE-hosted NEAR AI Cloud model whether a
// staged payment request is consistent with its stated reason, over
// `POST {base}/v1/chat/completions` with `Accept-Encoding: identity` so the
// hashed bytes stay stable. The exact request string and exact response
// text are retained for hash binding; the verdict parses a strict single
// JSON `{"consistent": bool, ...}` object.

// Default cloud base; tests inject the in-repo fixture cloud URL instead.
export const CLOUD_BASE_URL_DEFAULT = "https://cloud-api.near.ai/v1";

export interface JudgeRequestInput {
  request_id: number;
  agent_id: string;
  payee: string;
  amount_yocto: string;
  purpose_ref: string;
  vendor: string;
  reason?: string | null;
}

export interface JudgeModelOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  request: JudgeRequestInput;
  fetchImpl?: typeof fetch;
}

export type JudgeResult =
  | {
    ok: true;
    consistent: boolean;
    objection?: string;
    chatId: string;
    requestText: string;
    responseText: string;
    requestHash: string;
    responseHash: string;
    model: string;
  }
  | {
    ok: false;
    reason: string;
    transportError?: boolean;
    model: string;
  };

// Prompt builder: vendor/amount/purpose-ref vs the stated reason, with an
// instruction to reply with a single JSON consistency verdict and nothing
// else.
export function buildJudgePrompt(
  request: JudgeRequestInput,
): Array<{ role: string; content: string }> {
  const reason = request.reason?.trim() !== "" &&
      request.reason !== undefined &&
      request.reason !== null
    ? (request.reason as string)
    : `Payment for ${request.purpose_ref} from ${request.vendor}`;
  return [
    {
      role: "system",
      content:
        "You are a payment-purpose judge for a fleet of money-handling agents. " +
        "Decide whether the payment request is consistent with its stated reason. " +
        'Reply with exactly one JSON object and nothing else: {"consistent": boolean, "objection": string|null}. ' +
        'Set consistent to false when the payee, vendor, amount, or purpose reference do not match the reason.',
    },
    {
      role: "user",
      content:
        `Payment request #${request.request_id}: pay ${request.amount_yocto} yocto ` +
        `from agent ${request.agent_id} to payee ${request.payee} ` +
        `for purpose ref "${request.purpose_ref}" (vendor ${request.vendor}).\n` +
        `Stated reason: ${reason}\n` +
        "Is this request consistent with the stated reason?",
    },
  ];
}

// Extract the chat completion id, handling plain JSON bodies and SSE
// `data:` streams (mirrors the reference `extractChatCompletionId`).
export function extractChatId(responseText: string): string | null {
  try {
    const trimmed = responseText.trimStart();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed) as { id?: unknown };
      return typeof parsed.id === "string" ? parsed.id : null;
    }
    const firstDataLine = responseText
      .split("\n")
      .find((line) => line.startsWith("data: {"));
    if (firstDataLine !== undefined) {
      const parsed = JSON.parse(firstDataLine.substring(6)) as {
        id?: unknown;
      };
      return typeof parsed.id === "string" ? parsed.id : null;
    }
    return null;
  } catch {
    return null;
  }
}

// Leniently parse the model's `consistent` verdict: direct JSON, fenced
// code block, or first `{...}` span. Anything else is a malformed-output
// refusal (no submission downstream).
export function parseConsistent(content: unknown): {
  consistent?: boolean;
  objection?: string;
} {
  if (typeof content !== "string") return {};
  const candidates: string[] = [content];
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
  const span = content.match(/\{[\s\S]*\}/);
  if (span?.[0] !== undefined) candidates.push(span[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        consistent?: unknown;
        objection?: unknown;
      };
      if (typeof parsed.consistent === "boolean") {
        return {
          consistent: parsed.consistent,
          ...(typeof parsed.objection === "string" &&
              parsed.objection !== ""
            ? { objection: parsed.objection }
            : {}),
        };
      }
    } catch {
      // Try the next candidate shape.
    }
  }
  return {};
}

export async function judgeModel(
  opts: JudgeModelOptions,
): Promise<JudgeResult> {
  const model = opts.model;
  if (model === "") {
    return { ok: false, reason: "model is required", model };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const body = { model, messages: buildJudgePrompt(opts.request) };
  const requestText = JSON.stringify(body);
  let response: Response;
  try {
    response = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "identity",
        ...(opts.apiKey !== undefined && opts.apiKey !== ""
          ? { Authorization: `Bearer ${opts.apiKey}` }
          : {}),
      },
      body: requestText,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `chat completion request failed: ${error instanceof Error ? error.message : String(error)}`,
      transportError: true,
      model,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `chat completion request failed: status ${response.status}`,
      transportError: true,
      model,
    };
  }
  const responseText = await response.text();
  const requestHash = sha256HexText(requestText);
  const responseHash = sha256HexText(responseText);
  const chatId = extractChatId(responseText);
  if (chatId === null) {
    return { ok: false, reason: "chat completion response has no id", model };
  }
  let content: unknown;
  try {
    const parsed = JSON.parse(responseText) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    content = parsed.choices?.[0]?.message?.content;
  } catch {
    content = undefined;
  }
  const parsed = parseConsistent(content);
  if (parsed.consistent === undefined) {
    return {
      ok: false,
      reason: "model output is not a JSON consistency verdict",
      model,
    };
  }
  return {
    ok: true,
    consistent: parsed.consistent,
    ...(parsed.objection !== undefined ? { objection: parsed.objection } : {}),
    chatId,
    requestText,
    responseText,
    requestHash,
    responseHash,
    model,
  };
}
