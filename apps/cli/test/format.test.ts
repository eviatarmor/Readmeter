import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compactNumber,
  formatFindings,
  formatStats,
  formatUnits,
  initSnippet,
  relativeTime,
} from "../src/format.ts";
import { newApiKey, randomHashKey } from "../src/keys.ts";

test("compact units match the findings table", () => {
  assert.equal(compactNumber(120), "120");
  assert.equal(compactNumber(4000), "4k");
  assert.equal(compactNumber(1500), "1.5k");
  assert.equal(compactNumber(1_500_000), "1.5m");
  assert.equal(formatUnits({ reads: 120, egress_bytes: 4000 }), "reads=120 egress_bytes=4k");
  assert.equal(formatUnits({}), "-");
});

test("relative time uses floored units", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  assert.equal(relativeTime(new Date("2026-09-29T11:59:30Z"), now), "30s ago");
  assert.equal(relativeTime(new Date("2026-09-29T11:00:00Z"), now), "1h ago");
  assert.equal(relativeTime(new Date("2026-09-27T12:00:00Z"), now), "2d ago");
});

test("findings table keeps severity order and shortens the callsite", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const text = formatFindings(
    [
      {
        severity: "critical",
        rule: "firebase.firestore/unbounded-list",
        template: "posts",
        callsite: "abcdef0123456789",
        occurrences: 4,
        wasted: { reads: 120, egress_bytes: 4000 },
        lastSeen: new Date("2026-09-29T11:00:00Z"),
        message: "list has no limit",
      },
    ],
    now,
  );
  assert.match(text, /severity\s+rule/);
  assert.match(text, /critical\s+firebase\.firestore\/unbounded-list\s+posts\s+abcdef01\s+4\s+reads=120 egress_bytes=4k\s+1h ago\s+list has no limit/);
  assert.equal(text.includes("abcdef0123456789"), false);
});

test("stats text lists counts and the top templates", () => {
  const text = formatStats({
    batches: 2,
    events: 9,
    findings: 1,
    topTemplates: [{ template: "posts", reads: 4000 }],
  });
  assert.match(text, /batches\s+2/);
  assert.match(text, /events\s+9/);
  assert.match(text, /findings\s+1/);
  assert.match(text, /top templates by reads \(24h\)/);
  assert.match(text, /4k\s+posts/);
});

test("init snippet is ready to paste", () => {
  const text = initSnippet("rm_abc", "000102030405060708090a0b0c0d0e0f");
  assert.match(text, /^init\(\{/);
  assert.match(text, /apiKey: "rm_abc"/);
  assert.match(text, /hashKey: "000102030405060708090a0b0c0d0e0f"/);
  assert.match(text, /endpoint: "http:\/\/127\.0\.0\.1:8090"/);
});

test("generated keys have the documented shape", () => {
  const { apiKey, prefix } = newApiKey();
  assert.match(apiKey, /^rm_[0-9A-Za-z]{32}$/);
  assert.equal(prefix, apiKey.slice(0, 8));
  assert.match(randomHashKey(), /^[0-9a-f]{32}$/);
});
