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

/**
 * React dev-build functions that call a function component's body.
 * React 18 and 19: `renderWithHooks`; React 19 re-renders through
 * `renderWithHooksAgain`. Production builds minify these names.
 */
const RENDER_FRAMES = new Set(["renderWithHooks", "renderWithHooksAgain"]);

/** Commit-phase frames: effects and lifecycles run below these, never in render. */
function isCommitFrame(name: string): boolean {
  return /^commit[A-Z]/.test(name) || name === "flushPassiveEffects" || name === "flushLayoutEffects";
}

/** Function name of one stack line (V8 `at a.b (...)`, Firefox/Safari `a/b@...`). */
function frameName(line: string): string | undefined {
  let s = line.trim();
  if (s.startsWith("at ")) {
    s = s.slice(3);
    if (s.startsWith("async ")) s = s.slice(6);
    const paren = s.indexOf(" (");
    if (paren < 0) return undefined;
    s = s.slice(0, paren);
    const alias = s.indexOf(" [as ");
    if (alias >= 0) s = s.slice(0, alias);
    if (s.startsWith("new ")) s = s.slice(4);
  } else {
    const at = s.indexOf("@");
    if (at <= 0) return undefined;
    s = s.slice(0, at);
  }
  const parts = s.split(/[./<]+/).filter((part) => part.length > 0);
  return parts[parts.length - 1];
}

/**
 * True when the nearest React frame is a render entry point, i.e. the call
 * ran in a component body. Effects and event handlers return false.
 */
export function inRenderFromStack(stack: string | undefined): boolean {
  if (!stack) return false;
  for (const line of stack.split("\n")) {
    const name = frameName(line);
    if (!name) continue;
    if (RENDER_FRAMES.has(name)) return true;
    if (isCommitFrame(name)) return false;
  }
  return false;
}

/** V8 keeps 10 frames by default, often too few to reach React's render frame. */
const STACK_FRAMES = 50;

/** `new Error().stack` with a deeper frame limit. Never throws. */
export function captureStack(): string | undefined {
  try {
    const ctor = Error as { stackTraceLimit?: unknown };
    const previous = ctor.stackTraceLimit;
    const raise = typeof previous === "number" && previous < STACK_FRAMES;
    try {
      if (raise) ctor.stackTraceLimit = STACK_FRAMES;
      return new Error().stack;
    } finally {
      if (raise) ctor.stackTraceLimit = previous;
    }
  } catch {
    return undefined;
  }
}

/** Callsite plus the in-render flag for reads, from one captured stack. */
export function readSite(): { site: string | undefined; inRender: boolean } {
  try {
    const stack = captureStack();
    return { site: callsiteFromStack(stack), inRender: inRenderFromStack(stack) };
  } catch {
    return { site: undefined, inRender: false };
  }
}
