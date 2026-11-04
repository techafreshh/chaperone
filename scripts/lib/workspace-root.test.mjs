import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const nestedLockfile = join(repoRoot, "app", "package-lock.json");
const rootLockfile = join(repoRoot, "package-lock.json");
const nextConfig = join(repoRoot, "app", "next.config.ts");

describe("workspace root", () => {
  it("keeps a single root lockfile owning the app workspace", () => {
    assert.equal(
      existsSync(nestedLockfile),
      false,
      "app/package-lock.json must not exist: installs consolidate on the root lockfile",
    );
    assert.equal(
      existsSync(rootLockfile),
      true,
      "package-lock.json must exist at the repo root",
    );
    const lock = JSON.parse(readFileSync(rootLockfile, "utf8"));
    assert.ok(
      lock.packages && lock.packages.app,
      "root package-lock.json must contain a packages.app workspace entry",
    );
    assert.equal(lock.packages.app.name, "chaperone-app");
  });

  it("pins outputFileTracingRoot one level above the app dir", () => {
    const source = readFileSync(nextConfig, "utf8");
    assert.match(
      source,
      /outputFileTracingRoot/,
      "app/next.config.ts must set outputFileTracingRoot",
    );
    assert.match(
      source,
      /outputFileTracingRoot:\s*path\.join\(process\.cwd\(\),\s*"\.\."\s*\)/,
      'outputFileTracingRoot must resolve to the repo root via path.join(process.cwd(), "..")',
    );
  });
});
