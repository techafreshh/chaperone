import { createHash } from "node:crypto";
import type { NearReport } from "./verify.js";

// Canned fixture report material. Fixture quote bytes are synthetic and are
// compared by equality only — they are never parsed as a real quote. The
// honesty rule applies: fixture evidence must never render a TEE-verified
// badge upstream.

// Fixed 42-char `0x` signing identity for every fixture report.
export const FIXTURE_SIGNING_ADDRESS =
  "0x71c3f1a4b2e5d6c7a8b9e0f1d2c3b4a5e6f7a8b9";

// Synthetic canned quote bytes (64 bytes hex). Equality-compared only.
export const FIXTURE_QUOTE_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Raw measured configuration string. Hashed as exact UTF-8 bytes — the
// verifier must never parse or reserialize this value.
export const FIXTURE_APP_COMPOSE =
  '{"name":"chaperone-fixture-gateway","version":"1.0.0","model":"fixture-model"}';

function sha384Hex(...parts: Array<string | Buffer>): string {
  const h = createHash("sha384");
  for (const part of parts) h.update(part);
  return h.digest("hex");
}

// Event digest per the NEAR replay rule, computed here with plain
// node:crypto (not via replayRtmr3) so the fixture carries an independently
// derived carried-digest vector:
//   SHA-384(LE32(event_type) || ":" || event UTF-8 || ":" || payload bytes)
function eventDigestHex(
  eventType: number,
  event: string,
  eventPayloadHex: string,
): string {
  const typeBytes = Buffer.alloc(4);
  typeBytes.writeUInt32LE(eventType);
  return sha384Hex(
    typeBytes,
    ":",
    Buffer.from(event, "utf8"),
    ":",
    Buffer.from(eventPayloadHex, "hex"),
  );
}

const APP_ID_PAYLOAD_HEX = Buffer.from("chaperone-fixture", "utf8").toString(
  "hex",
);

function fixtureEventLog(): string {
  return JSON.stringify([
    {
      imr: 0,
      event_type: 1,
      event: "boot",
      event_payload: "",
      digest: "",
    },
    {
      imr: 3,
      event_type: 4,
      event: "app-id",
      event_payload: APP_ID_PAYLOAD_HEX,
      digest: eventDigestHex(4, "app-id", APP_ID_PAYLOAD_HEX),
    },
    {
      imr: 3,
      event_type: 5,
      event: "compose-hash",
      event_payload: "ab12",
      digest: "",
    },
  ]);
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

// Canned NVIDIA NRAS response: a JSON array whose first entry is
// ["JWT", "<token>"] with a payload verdict of boolean true.
export function cannedNrasResponse(): unknown {
  const token = `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson({
    "x-nvidia-overall-att-result": true,
    iss: "nras-fixture",
  })}.`;
  return [["JWT", token]];
}

// Canned NRAS response with a failing verdict (for reject vectors).
export function cannedNrasResponseFail(): unknown {
  const token = `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson({
    "x-nvidia-overall-att-result": false,
    iss: "nras-fixture",
  })}.`;
  return [["JWT", token]];
}

// Build the canned fixture report around a caller-supplied 64-hex nonce.
// The report is self-consistent: echo fields, report_data binding, RTMR3
// replay, and MRCONFIGID derivation all resolve against the canned values.
export function fixtureReport(nonceHex: string): NearReport {
  const identity = Buffer.from(
    FIXTURE_SIGNING_ADDRESS.replace(/^0x/i, ""),
    "hex",
  );
  const boundIdentity = Buffer.concat([identity, Buffer.alloc(32 - identity.length)]);
  const reportData = Buffer.concat([
    boundIdentity,
    Buffer.from(nonceHex, "hex"),
  ]).toString("hex");
  return {
    intel_quote: FIXTURE_QUOTE_HEX,
    event_log: fixtureEventLog(),
    request_nonce: nonceHex,
    report_data: reportData,
    signing_address: FIXTURE_SIGNING_ADDRESS,
    signing_algo: "ecdsa",
    info: {
      tcb_info: JSON.stringify({ app_compose: FIXTURE_APP_COMPOSE }),
    },
    nvidia_payload: JSON.stringify({
      nonce: nonceHex,
      uuid: "GPU-fixture-0",
      driver_version: "fixture",
    }),
  };
}
