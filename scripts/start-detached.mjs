/**
 * Start a command in its own process and write the Windows/Linux pid to a file.
 * Git Bash `$!` is an MSYS pid, so `taskkill` misses it. Node's pid is the real one.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [pidfile, logfile, ...cmd] = process.argv.slice(2);
if (!pidfile || !logfile || cmd.length === 0) {
  console.error("usage: start-detached.mjs <pidfile> <logfile> <command> [args...]");
  process.exit(1);
}

mkdirSync(dirname(pidfile), { recursive: true });
mkdirSync(dirname(logfile), { recursive: true });
const out = openSync(logfile, "a");
const child = spawn(cmd[0], cmd.slice(1), {
  detached: true,
  stdio: ["ignore", out, out],
  windowsHide: true,
});
if (!child.pid) {
  console.error("failed to start", cmd.join(" "));
  process.exit(1);
}
child.unref();
closeSync(out);
writeFileSync(pidfile, `${child.pid}\n`);
