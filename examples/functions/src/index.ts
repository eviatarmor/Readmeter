/**
 * Wasteful Cloud Functions. `withFlush` sends the batch before the response.
 * Document ids match the web example: posts `p0`..`p299`, users `u0`..`u49`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { init } from "@readmeter/firebase";
import { instrument, instrumentAuth, withFlush } from "@readmeter/firebase/admin";

function loadEnv(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(join(dirname(fileURLToPath(import.meta.url)), "../.env"));

initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "demo-readmeter" });

const hashKey = process.env.READMETER_HASH_KEY;
init({
  apiKey: process.env.READMETER_API_KEY ?? "",
  endpoint: process.env.READMETER_ENDPOINT ?? "http://127.0.0.1:8090",
  platform: "server",
  dev: true,
  ...(hashKey ? { hashKey } : {}),
});

const db = instrument(getFirestore());
const adminAuth = instrumentAuth(getAuth());

export const unboundedReport = onRequest(
  { region: "us-central1" },
  withFlush(async (_req, res) => {
    const snap = await db.collection("posts").get();
    res.json({ n: snap.size });
  }),
);

export const nPlusOne = onRequest(
  { region: "us-central1" },
  withFlush(async (_req, res) => {
    let n = 0;
    for (let start = 0; start < 50; start += 10) {
      const reads = Array.from({ length: 10 }, (_, j) => db.collection("users").doc(`u${start + j}`).get());
      const snaps = await Promise.all(reads);
      n += snaps.length;
    }
    res.json({ n });
  }),
);

export const offsetPage = onRequest(
  { region: "us-central1" },
  withFlush(async (_req, res) => {
    const snap = await db.collection("posts").orderBy("createdAt").offset(200).limit(20).get();
    res.json({ n: snap.size });
  }),
);

export const fanout = onRequest(
  { region: "us-central1" },
  withFlush(async (_req, res) => {
    const batch = db.batch();
    for (let i = 0; i < 150; i += 1) batch.set(db.collection("fanout").doc(`d${i}`), { n: i });
    await batch.commit();
    res.json({ n: 150 });
  }),
);

/** listUsers inside the request. One finding per invocation, including an empty page. */
export const listUsersRequest = onRequest(
  { region: "us-central1" },
  withFlush(async (_req, res) => {
    const page = await adminAuth.listUsers(1000);
    res.json({ n: page.users.length });
  }),
);

/** Returns a fixed object. The request body is not copied into the response or the record. */
export const echo = onCall(
  { region: "us-central1" },
  withFlush(async () => ({ ok: true })),
);

/** Fails with an allowlisted code. The message is not recorded. */
export const fail = onCall(
  { region: "us-central1" },
  withFlush(async () => {
    throw new HttpsError("unavailable", "nope");
  }),
);

/**
 * First HTTP call in the demo. The sleep makes this withFlush both cold and
 * slower than the cold-start rule. Later functions in this process are warm.
 */
export const coldStart = onRequest(
  { region: "us-central1" },
  withFlush(async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    res.json({ ok: true });
  }),
);

/** 501 gets of one document. The seeded collection is smaller than the rule's max. */
export const readStorm = onRequest(
  { region: "us-central1" },
  withFlush(async (_req, res) => {
    let n = 0;
    for (let start = 0; start < 501; start += 25) {
      const count = Math.min(25, 501 - start);
      const snaps = await Promise.all(Array.from({ length: count }, () => db.collection("posts").doc("p0").get()));
      n += snaps.length;
    }
    res.json({ n });
  }),
);

/** Three read-then-write transactions on counters/likes. The web seed creates that document. */
export const counterTx = onRequest(
  { region: "us-central1" },
  withFlush(async (_req, res) => {
    const ref = db.collection("counters").doc("likes");
    for (let i = 0; i < 3; i += 1) {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.data();
        const count = data && typeof data.count === "number" ? data.count : 0;
        tx.update(ref, { count: count + 1 });
      });
    }
    res.json({ n: 3 });
  }),
);
