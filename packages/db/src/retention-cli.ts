// One retention pass, for operators: `pnpm db:retention` or `readmeter retention`.
// The worker (`readmeter worker`) runs the same pass on start and every hour.
import { connect } from "./index.ts";
import { retentionFromEnv, runRetention } from "./retention.ts";

const config = retentionFromEnv();
const { client, close } = connect();
try {
  const report = await runRetention(client, config);
  console.log(JSON.stringify({ msg: report.skipped ? "retention already running elsewhere" : "retention pass", ...config, ...report }));
} finally {
  await close();
}
