import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openCore } from "../src/core/open.ts";
import type { Platform } from "../src/types.ts";
import { HASH_KEY, bundleBytes } from "./bundle.ts";

interface ExpectFinding {
  rule: string;
  wasted?: Record<string, number>;
}

interface Fixture {
  description: string;
  platform: string;
  evaluations: string[];
  calls?: unknown[];
  sessions?: unknown[];
  expect_findings: ExpectFinding[];
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".json")) out.push(full);
  }
  return out;
}

function sameWasted(got: Record<string, number>, want: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
  for (const key of keys) {
    if ((got[key] ?? 0) !== (want[key] ?? 0)) return false;
  }
  return true;
}

const fixturesDir = fileURLToPath(new URL("../../../../conformance/fixtures", import.meta.url));
const fixtures = walk(fixturesDir).sort();

test("conformance fixtures produce the same findings as the Rust runner", async () => {
  assert.ok(fixtures.length > 0, "no fixtures found");
  const bundle = bundleBytes();
  const failures: string[] = [];
  for (const file of fixtures) {
    const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
    // Aggregate fixtures name many sessions and run in the Rust evaluator.
    if (!fixture.calls) continue;
    const platform = fixture.platform;
    if (platform !== "browser" && platform !== "server" && platform !== "mobile") {
      failures.push(`${file}: unknown platform ${platform}`);
      continue;
    }
    const client = await openCore({
      hashKey: HASH_KEY,
      bundle,
      session: "1",
      platform: platform as Platform,
      dev: false,
      sampleRate: 1,
      evaluations: fixture.evaluations,
    });
    try {
      const got = [];
      for (const call of fixture.calls) got.push(...client.record(call).findings);
      const gotRules = got.map((finding) => finding.rule);
      const wantRules = fixture.expect_findings.map((finding) => finding.rule);
      if (JSON.stringify(gotRules) !== JSON.stringify(wantRules)) {
        failures.push(`${path.basename(file)}: findings ${JSON.stringify(gotRules)} want ${JSON.stringify(wantRules)}`);
        continue;
      }
      for (let i = 0; i < got.length; i++) {
        const want = fixture.expect_findings[i]?.wasted;
        const finding = got[i];
        if (want && finding && !sameWasted(finding.wasted, want)) {
          failures.push(`${path.basename(file)}: ${finding.rule} wasted ${JSON.stringify(finding.wasted)} want ${JSON.stringify(want)}`);
        }
      }
      if (fixture.calls.length > 0) {
        const batch = client.drain(0);
        if (!batch || batch[0] !== 0x52 || batch[1] !== 0x4d) {
          failures.push(`${path.basename(file)}: flush did not return an RM batch`);
        }
      }
    } finally {
      client.free();
    }
  }
  assert.deepEqual(failures, []);
});
