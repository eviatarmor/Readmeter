import { connect } from "@readmeter/db";
import postgres from "postgres";

import { clientsFromEnv } from "./clients.ts";
import { readWorkerEnv } from "./env.ts";
import { runLoop } from "./worker.ts";

const env = readWorkerEnv();
const { db, close } = connect(env.databaseUrl);
const sql = postgres(env.databaseUrl, { max: 4, onnotice: () => {} });
const abort = new AbortController();
const stop = () => abort.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  await runLoop(
    db,
    {
      sql,
      clients: clientsFromEnv(env.fake),
      secretKey: env.secretKey,
      maxBytesBilled: env.maxBytesBilled,
      timeoutMs: env.timeoutMs,
    },
    env.pollMs,
    abort.signal,
  );
} finally {
  await sql.end({ timeout: 5 });
  await close();
}
