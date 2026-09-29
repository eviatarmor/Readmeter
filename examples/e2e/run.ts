/**
 * Drives the web scenarios against the Firestore emulator, calls each HTTP
 * function once, then asserts rules via `pnpm run rm findings --json`.
 *
 * `tsx run.ts --assert-only <rule...>` only checks Postgres (used after Playwright).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteApp, initializeApp } from "firebase/app";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { flush, init, shutdown } from "@readmeter/firebase";

import {
  countViaFetch,
  getThenListen,
  listenerPerItem,
  loadMore,
  offsetPagination,
  searchPerKeystroke,
  seedData,
  tinyBatches,
  unboundedList,
  writePerKeystroke,
} from "../web-firestore/src/scenarios.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://readmeter:readmeter@127.0.0.1:5442/readmeter";

/** Web rules (sdk local or evaluator window) plus the four function rules. */
const EXPECTED = [
  "firebase.firestore/unbounded-list",
  "firebase.firestore/offset-pagination",
  "firebase.firestore/missing-cursor",
  "firebase.firestore/count-via-fetch",
  "firebase.firestore/get-then-listen",
  "firebase.firestore/listener-per-item",
  "firebase.firestore/query-per-keystroke",
  "firebase.firestore/write-per-keystroke",
  "firebase.firestore/tiny-batches",
  "generic/n-plus-one",
  "firebase.firestore/fanout-writes",
];

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, DATABASE_URL, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ stdout, stderr, code: code ?? 1 }));
  });
}

interface FindingRow {
  rule: string;
  occurrences: number;
}

function parseFindings(stdout: string): FindingRow[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error(`findings output has no JSON array:\n${stdout}`);
  const value: unknown = JSON.parse(stdout.slice(start, end + 1));
  if (!Array.isArray(value)) throw new Error("findings JSON is not an array");
  return value.map((row) => {
    if (!row || typeof row !== "object" || typeof (row as { rule?: unknown }).rule !== "string") {
      throw new Error(`finding row missing rule: ${JSON.stringify(row)}`);
    }
    const rec = row as { rule: string; occurrences?: unknown };
    return { rule: rec.rule, occurrences: typeof rec.occurrences === "number" ? rec.occurrences : 1 };
  });
}

async function findings(): Promise<FindingRow[]> {
  const result = await run("pnpm", ["run", "--silent", "rm", "findings", "--project", "demo_local", "--json", "--limit", "500"]);
  if (result.code !== 0) {
    throw new Error(`pnpm run rm findings exited ${result.code}\n${result.stdout}\n${result.stderr}`);
  }
  return parseFindings(result.stdout);
}

function report(expected: string[], rows: FindingRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.rule, (counts.get(row.rule) ?? 0) + row.occurrences);
  const missing = expected.filter((rule) => !counts.has(rule));
  const found = [...counts.keys()].sort();
  console.log("e2e rule check");
  console.log("expected:");
  for (const rule of expected) console.log(`  ${rule}`);
  console.log("found:");
  for (const rule of found) console.log(`  ${rule}  occurrences=${counts.get(rule)}`);
  if (missing.length === 0) console.log("missing: (none)");
  else {
    console.log("missing:");
    for (const rule of missing) console.log(`  ${rule}`);
  }
  return missing;
}

async function assertRules(expected: string[]): Promise<void> {
  let missing: string[] = expected;
  let rows: FindingRow[] = [];
  for (let i = 0; i < 20; i += 1) {
    rows = await findings();
    missing = report(expected, rows);
    if (missing.length === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`missing rules: ${missing.join(", ")}`);
}

async function callFunction(name: string): Promise<void> {
  const url = `http://127.0.0.1:5001/demo-readmeter/us-central1/${name}`;
  let last = "";
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await fetch(url);
      last = `${res.status} ${await res.text()}`;
      if (res.ok) {
        console.log(name, last);
        return;
      }
      if (res.status !== 404 && res.status < 500) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`${name} failed: ${last} (${url})`);
}

async function drive(): Promise<void> {
  const env = loadEnv(resolve(root, ".readmeter/local.env"));
  const apiKey = env.READMETER_API_KEY;
  const hashKey = env.READMETER_HASH_KEY;
  const endpoint = env.READMETER_ENDPOINT ?? "http://127.0.0.1:8090";
  if (!apiKey || !hashKey) throw new Error(".readmeter/local.env is missing READMETER_API_KEY or READMETER_HASH_KEY");

  init({ apiKey, hashKey, endpoint, dev: true, platform: "browser" });

  const rawHost = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8085";
  const [host, portText] = rawHost.split(":");
  const port = Number(portText);
  if (!host || !Number.isFinite(port)) throw new Error(`bad FIRESTORE_EMULATOR_HOST ${rawHost}`);

  const app = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, "readmeter-e2e");
  const db = getFirestore(app);
  connectFirestoreEmulator(db, host, port);
  try {
    console.log(await seedData(db));
    console.log(await unboundedList(db));
    console.log(await offsetPagination(db));
    console.log(await loadMore(db));
    console.log(await countViaFetch(db));
    console.log(await getThenListen(db));
    console.log(await listenerPerItem(db));
    console.log(await searchPerKeystroke(db));
    console.log(await writePerKeystroke(db));
    console.log(await tinyBatches(db));
    await flush();
  } finally {
    await shutdown();
    await deleteApp(app);
  }

  for (const name of ["unboundedReport", "nPlusOne", "offsetPage", "fanout"]) {
    await callFunction(name);
  }
}

const args = process.argv.slice(2);
const only = args[0] === "--assert-only";
const expected = only ? args.slice(1) : EXPECTED;
if (expected.length === 0) throw new Error("--assert-only needs at least one rule id");

if (!only) await drive();
await assertRules(expected);
console.log("e2e rules ok");
