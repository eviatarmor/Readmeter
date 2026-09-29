/**
 * If a Firebase emulator we started is still listening, stop it.
 * firebase-tools on Windows can leave the Firestore JVM up after emulators:exec.
 * A port held by anything else is an error.
 */
import { execFileSync } from "node:child_process";
import net from "node:net";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: free-emulator-port.mjs <port>");
  process.exit(1);
}

const OURS = /cloud-firestore-emulator|firebase-database-emulator|firebase-tools|cloud-functions|functionsEmulator|firebase emulators|storage-emulator|cloud-storage-rules|firebase-storage/;

function listening() {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1500);
  });
}

function pidWindows() {
  const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[3] !== "LISTENING") continue;
    const local = parts[1] ?? "";
    if (!local.endsWith(`:${port}`)) continue;
    const pid = Number(parts.at(-1));
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return undefined;
}

function commandLine(pid) {
  if (process.platform === "win32") {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf8" },
    );
  }
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function pidUnix() {
  try {
    const out = execFileSync("ss", ["-lptn", `sport = :${port}`], { encoding: "utf8" });
    const match = out.match(/pid=(\d+)/);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

if (!(await listening())) process.exit(0);

const pid = process.platform === "win32" ? pidWindows() : pidUnix();
if (!pid) {
  console.error(`port ${port} is in use and its pid could not be read`);
  process.exit(1);
}
const command = commandLine(pid);
if (!OURS.test(command)) {
  console.error(`port ${port} is held by pid ${pid}, not a Firebase emulator:\n${command.trim()}`);
  process.exit(1);
}
if (process.platform === "win32") {
  execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
} else {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    process.kill(pid, "SIGKILL");
  }
}
console.log(`stopped leftover emulator pid ${pid} on port ${port}`);
