/**
 * Wasteful Cloud Functions. `withFlush` sends the batch before the response.
 * Document ids match the web example: posts `p0`..`p299`, users `u0`..`u49`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { init } from "@readmeter/firebase";
import { instrument, withFlush } from "@readmeter/firebase/admin";

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
