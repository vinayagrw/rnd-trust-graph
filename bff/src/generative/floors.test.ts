import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Jan-2026 Vega XSS fixes (CVE-2025-66648 in vega-functions, CVE-2025-65110
// in vega-selections) arrive only via transitive resolution — vega 6.2.0's tilde
// ranges ADMIT the vulnerable versions, so a stale lockfile silently keeps them
// while package.json looks patched. Assert the RESOLVED versions meet the floors.
const FLOORS: Record<string, string> = {
  vega: "6.2.0",
  "vega-lite": "6.4.3",
  "vega-embed": "7.1.0",
  "vega-functions": "6.1.1",
  "vega-selections": "6.1.2",
  "vega-expression": "6.1.0",
  "vega-interpreter": "2.2.1",
};

function atLeast(v: string, floor: string): boolean {
  const a = v.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

test("lockfile satisfies the Vega CVE version floors", () => {
  const lock = JSON.parse(readFileSync(join(process.cwd(), "..", "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version: string }>;
  };
  for (const [pkg, floor] of Object.entries(FLOORS)) {
    const entry = lock.packages?.[`node_modules/${pkg}`];
    assert.ok(entry, `${pkg} missing from lockfile — install the vega trio in web/`);
    assert.ok(atLeast(entry.version, floor), `${pkg}@${entry.version} is below the CVE floor ${floor}`);
  }
});
