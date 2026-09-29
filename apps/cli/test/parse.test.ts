import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs, UsageError } from "../src/parse.ts";

const flags = (argv: string[]) => parseArgs(argv);

test("project create defaults name and org", () => {
  assert.deepEqual(flags(["project", "create", "demo_web"]), {
    kind: "project-create",
    id: "demo_web",
    name: "demo_web",
    org: "org_local",
  });
  assert.deepEqual(flags(["project", "create", "demo_web", "--name", "Web", "--org", "org_acme"]), {
    kind: "project-create",
    id: "demo_web",
    name: "Web",
    org: "org_acme",
  });
});

test("key commands", () => {
  assert.deepEqual(flags(["key", "create", "demo_web", "--origin", "http://localhost:5173", "--origin", "http://127.0.0.1:5173"]), {
    kind: "key-create",
    projectId: "demo_web",
    origins: ["http://localhost:5173", "http://127.0.0.1:5173"],
  });
  assert.deepEqual(flags(["key", "list", "demo_web"]), { kind: "key-list", projectId: "demo_web" });
  assert.deepEqual(flags(["key", "revoke", "rm_abcde"]), { kind: "key-revoke", prefix: "rm_abcde" });
});

test("a leading -- from pnpm is not a command", () => {
  assert.deepEqual(flags(["--", "findings", "--limit", "1"]), { kind: "findings", limit: 1, json: false });
});

test("findings, events and stats flags", () => {
  assert.deepEqual(flags(["findings"]), { kind: "findings", limit: 50, json: false });
  assert.deepEqual(flags(["findings", "--json", "--project", "p", "--since", "24h", "--rule", "r", "--limit", "10"]), {
    kind: "findings",
    project: "p",
    since: "24h",
    rule: "r",
    limit: 10,
    json: true,
  });
  assert.deepEqual(flags(["events", "--limit", "5"]), { kind: "events", limit: 5, json: false });
  assert.deepEqual(flags(["stats", "--project", "p", "--json"]), { kind: "stats", project: "p", json: true });
});

test("rejects unknown commands and bad flags", () => {
  const bad = (argv: string[]) => assert.throws(() => flags(argv), UsageError);
  bad([]);
  bad(["nope"]);
  bad(["project"]);
  bad(["project", "create"]);
  bad(["findings", "--since", "2h"]);
  bad(["findings", "--limit", "0"]);
  bad(["events", "--limit", "nope"]);
  bad(["key", "create", "p", "--origin"]);
});
