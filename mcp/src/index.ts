// Chaperone MCP server: stdio wiring only. All policy logic lives in
// `./tools.js`; this file registers the four tools and connects the
// stdio transport.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  attestations,
  pending,
  policyGet,
  requestPayment,
} from "./tools.js";

const server = new McpServer({ name: "chaperone", version: "0.1.0" });

server.registerTool(
  "policy_get",
  {
    title: "Get agent policy",
    description:
      "Read the on-chain spending policy for an agent (allowance, cap, allowlist, active).",
    inputSchema: {
      agent_id: z.string().optional().describe("Agent id, defaults to agent-1"),
    },
  },
  async (args) => policyGet(args),
);

server.registerTool(
  "request_payment",
  {
    title: "Request payment",
    description:
      "Submit a guarded payment request; refusals carry the verbatim on-chain reason.",
    inputSchema: {
      payee: z.string().describe("Destination NEAR account id"),
      amount_near: z.string().describe("Decimal NEAR amount, e.g. \"400\" or \"0.5\""),
      purpose_ref: z.string().describe("Purpose ref id, e.g. invoice-114"),
      vendor: z.string().describe("Vendor name"),
      memo: z.string().describe("Agent's stated reason for the payment (1..=280 bytes)"),
      agent_id: z.string().optional().describe("Agent id, defaults to agent-1"),
    },
  },
  async (args) => requestPayment(args),
);

server.registerTool(
  "pending",
  {
    title: "List pending approvals",
    description: "List held requests awaiting a human decision, with objections.",
    inputSchema: {},
  },
  async (args) => pending(args),
);

server.registerTool(
  "attestations",
  {
    title: "Get request attestation",
    description: "Badge plus signing evidence for a payment request.",
    inputSchema: {
      request_id: z.number().int().positive().describe("Payment request id"),
    },
  },
  async (args) => attestations(args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
