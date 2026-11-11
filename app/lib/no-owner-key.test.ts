import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// CI gate (issue #62): the app server holds no owner key. No non-test
// file under `app/` may read `NEAR_PRIVATE_KEY` — operator CLIs under
// `scripts/` keep using it, wallet-signed owner writes replace it in the
// browser. Test files (`*.test.*`) are excluded so this gate itself can
// name the literal.
const APP_ROOT = path.join(__dirname, "..");
const NEEDLE = "NEAR_PRIVATE_KEY";

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (full.endsWith(".test.ts") || full.endsWith(".test.tsx")) continue;
      out.push(full);
    }
  }
}

describe("no owner key under app/", () => {
  it("no non-test file reads NEAR_PRIVATE_KEY", () => {
    const files: string[] = [];
    walk(APP_ROOT, files);
    const offenders = files.filter((file) => {
      try {
        return fs.readFileSync(file, "utf8").includes(NEEDLE);
      } catch {
        return false;
      }
    });
    expect(offenders).toEqual([]);
  });
});
