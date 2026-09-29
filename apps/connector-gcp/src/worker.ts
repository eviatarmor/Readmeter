import { writeSync } from "node:fs";

import type { Db } from "@readmeter/db";

import { syncDue, type SyncOptions } from "./sync.ts";

export async function runLoop(
  db: Db,
  options: Omit<SyncOptions, "now">,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (!options.secretKey) {
    console.error(
      JSON.stringify({
        msg: "gcp connector cannot decrypt keys",
        error: "Set READMETER_SECRET_KEY to 32 bytes, base64-encoded, before syncing Google Cloud.",
      }),
    );
  }
  writeSync(1, `${JSON.stringify({ msg: "connector started", pollMs })}\n`);
  while (!signal.aborted) {
    try {
      const pass = await syncDue(db, options);
      if (pass.failed.length > 0 || pass.synced.length > 0) {
        console.log(JSON.stringify({ msg: "gcp sync pass", ...pass }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "sync pass failed";
      console.error(JSON.stringify({ msg: "gcp sync pass failed", error: message }));
    }
    await sleep(pollMs, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}


