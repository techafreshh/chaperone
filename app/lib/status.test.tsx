import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import ReasonText from "../components/ReasonText";
import StatusChip from "../components/StatusChip";
import TxLink from "../components/TxLink";
import {
  REASON_DESCRIPTIONS,
  STATUS_META,
  describeReason,
  statusMeta,
  type RequestStatus,
} from "./status";

const CONTRACT_SOURCE = new URL(
  "../../contract/src/request.rs",
  import.meta.url,
);

function escapedSentence(sentence: string): string {
  return sentence.replaceAll("'", "&#x27;");
}

function contractReasonValues(): string[] {
  const source = fs.readFileSync(CONTRACT_SOURCE, "utf8");
  const values: string[] = [];
  const pattern = /REASON_[A-Z0-9_]+\s*:\s*&str\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    values.push(match[1]);
  }
  return [...new Set(values)];
}

describe("contract reason coverage", () => {
  it("finds reason constants in the contract source", () => {
    expect(contractReasonValues().length).toBeGreaterThan(0);
  });

  it("every REASON_* value has a plain-language sentence in the UI mapping", () => {
    const missing = contractReasonValues().filter(
      (value) => REASON_DESCRIPTIONS[value] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("every mapped sentence is a non-empty string and describeReason returns it", () => {
    for (const value of contractReasonValues()) {
      const sentence = REASON_DESCRIPTIONS[value];
      expect(typeof sentence).toBe("string");
      expect(sentence.trim().length).toBeGreaterThan(0);
      expect(describeReason(value)).toBe(sentence);
    }
  });

  it("unknown codes get the never-empty fallback sentence", () => {
    expect(describeReason("BogusCode").length).toBeGreaterThan(0);
    expect(describeReason("")).toBe(describeReason("BogusCode"));
    expect(describeReason(null)).toBe(describeReason("BogusCode"));
  });
});

describe("status chips", () => {
  const statuses: RequestStatus[] = [
    "staged",
    "paying",
    "paid",
    "held",
    "rejected",
    "failed",
  ];

  it("covers exactly the six contract statuses", () => {
    expect(Object.keys(STATUS_META).sort()).toEqual([...statuses].sort());
  });

  it("renders distinct color classes and distinct text per state", () => {
    const classes = statuses.map((status) => STATUS_META[status].chipClass);
    expect(new Set(classes).size).toBe(statuses.length);
    const labels = statuses.map((status) => STATUS_META[status].label);
    expect(new Set(labels).size).toBe(statuses.length);
    for (const status of statuses) {
      const html = renderToStaticMarkup(<StatusChip status={status} />);
      expect(html).toContain(STATUS_META[status].label);
      expect(html).toContain(STATUS_META[status].chipClass.split(" ")[0]);
    }
  });

  it("unknown states stay visible on a neutral chip", () => {
    const html = renderToStaticMarkup(<StatusChip status="mystery" />);
    expect(html).toContain("mystery");
    expect(statusMeta("mystery").label).toBe("mystery");
  });
});

describe("ReasonText", () => {
  it("renders the code in monospace next to its sentence", () => {
    const html = renderToStaticMarkup(<ReasonText reason="PayeeNotAllowlisted" />);
    expect(html).toContain("<code");
    expect(html).toContain("PayeeNotAllowlisted");
    expect(html).toContain(escapedSentence(REASON_DESCRIPTIONS.PayeeNotAllowlisted));
  });

  it("extracts the code from suffixed fixture strings", () => {
    const html = renderToStaticMarkup(
      <ReasonText reason="PayeeNotAllowlisted: payee evil.example not allowlisted" />,
    );
    expect(html).toContain("PayeeNotAllowlisted");
    expect(html).toContain(escapedSentence(REASON_DESCRIPTIONS.PayeeNotAllowlisted));
  });

  it("renders the fallback sentence for unknown codes", () => {
    const html = renderToStaticMarkup(<ReasonText reason="quorum not reached" />);
    expect(html).toContain("quorum not reached");
    expect(html).toContain(describeReason("quorum not reached"));
  });

  it("renders nothing without a reason", () => {
    expect(renderToStaticMarkup(<ReasonText reason={null} />)).toBe("");
    expect(renderToStaticMarkup(<ReasonText reason="" />)).toBe("");
  });
});

describe("TxLink", () => {
  it("links a chain tx to the testnet explorer", () => {
    const html = renderToStaticMarkup(<TxLink hash="ABC123" network="testnet" />);
    expect(html).toContain("https://testnet.nearblocks.io/txns/ABC123");
    expect(html).toContain("<a");
  });

  it("renders plain text when the hash is empty", () => {
    for (const hash of ["", null, undefined]) {
      const html = renderToStaticMarkup(<TxLink hash={hash} />);
      expect(html).not.toContain("<a");
      expect(html).not.toContain("nearblocks.io");
    }
  });
});
