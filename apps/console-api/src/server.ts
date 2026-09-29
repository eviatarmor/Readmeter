import { serve } from "@hono/node-server";
import { connect } from "@readmeter/db";

import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { loadCore } from "./core.ts";
import { readEnv } from "./env.ts";
import { createMailer } from "./mail.ts";

const env = readEnv();
const { db, close } = connect();
const mailer = createMailer(env);
const auth = createAuth(db, env, mailer);
const core = await loadCore();
const app = createApp({ db, auth, core, env, mailer });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(JSON.stringify({ msg: "listening", port: info.port }));
});

const shutdown = () => {
  server.close(() => {
    void close().finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
