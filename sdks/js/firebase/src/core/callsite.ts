/**
 * First stack frame outside this package and `node_modules`, as `file:line:col`.
 * Stacks are the dev fallback; a build plugin can replace this later.
 */

function packageRoot(): string {
  const url = new URL("../../", import.meta.url);
  if (url.protocol !== "file:") return url.href;
  let path = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return path.replace(/\/$/, "");
}

function norm(path: string): string {
  let s = path.replace(/\\/g, "/");
  if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
  return s.toLowerCase();
}

function fileUrlToPath(url: string): string {
  try {
    const parsed = new URL(url);
    let path = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path;
  } catch {
    return url;
  }
}

function isInternal(file: string, root: string): boolean {
  const path = norm(file);
  if (path.includes("/node_modules/") || path.includes("node:")) return true;
  if (path.includes("readmeter_wasm")) return true;
  if (root && (path.startsWith(`${root}/src/`) || path.startsWith(`${root}/dist/`))) return true;
  if (path.includes("/@readmeter/firebase/src/") || path.includes("/@readmeter/firebase/dist/")) return true;
  return false;
}

function parseFrame(line: string): { file: string; line: number; col: number } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "Error") return undefined;
  const match = /^(.*):(\d+):(\d+)\)?$/.exec(trimmed);
  if (!match) return undefined;
  const lineNo = Number(match[2]);
  const col = Number(match[3]);
  if (!Number.isFinite(lineNo) || !Number.isFinite(col)) return undefined;
  let file = match[1] ?? "";
  const paren = file.lastIndexOf("(");
  if (paren >= 0) file = file.slice(paren + 1);
  else {
    const at = file.lastIndexOf("@");
    if (at >= 0) file = file.slice(at + 1);
    else if (file.startsWith("at ")) file = file.slice(3);
  }
  file = file.trim();
  const query = file.indexOf("?");
  if (query >= 0) file = file.slice(0, query);
  if (file.startsWith("file://")) file = fileUrlToPath(file);
  if (!file) return undefined;
  return { file, line: lineNo, col };
}

export function callsiteFromStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const root = norm(packageRoot());
  for (const line of stack.split("\n")) {
    const frame = parseFrame(line);
    if (!frame || isInternal(frame.file, root)) continue;
    return `${frame.file}:${frame.line}:${frame.col}`;
  }
  return undefined;
}

export function callsite(): string | undefined {
  return callsiteFromStack(new Error().stack);
}
