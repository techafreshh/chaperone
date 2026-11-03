import { describe, expect, it } from "vitest";
import { capToYocto, getRef, listRefs } from "./books";

describe("books ledger", () => {
  it("returns exactly 4 refs", () => {
    expect(listRefs()).toHaveLength(4);
  });

  it("contains invoice-114 with vendor CoreWeave", () => {
    const entry = listRefs().find((ref) => ref.id === "invoice-114");
    expect(entry).toBeDefined();
    expect(entry?.vendor).toBe("CoreWeave");
  });

  it("every entry has string id/vendor/cap_near", () => {
    for (const entry of listRefs()) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.vendor).toBe("string");
      expect(typeof entry.cap_near).toBe("string");
    }
  });

  it("getRef resolves known refs and undefined for unknown", () => {
    expect(getRef("invoice-114")?.vendor).toBe("CoreWeave");
    expect(getRef("nope")).toBeUndefined();
  });

  it("capToYocto converts decimal NEAR to yocto", () => {
    expect(capToYocto("30")).toBe("30000000000000000000000000");
    expect(capToYocto("0.5")).toBe("500000000000000000000000");
  });
});
