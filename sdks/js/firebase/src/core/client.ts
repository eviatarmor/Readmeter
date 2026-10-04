import { debugOnce } from "./log.ts";
import type { WasmHandle } from "./wasm.ts";
import type { Finding } from "../types.ts";

/** Calls made before wasm is ready. Drop the oldest past this. */
export const QUEUE_CAP = 1000;

export interface CoreOptions {
  dev?: boolean;
  debug?: boolean;
  onFinding?: (finding: Finding) => void;
}

export interface RecordResult {
  findings: Finding[];
  /** True when the call reached wasm. Queued calls are not counted yet. */
  wrote: boolean;
}

function asFinding(value: unknown): Finding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.rule !== "string") return undefined;
  const wasted: Record<string, number> = {};
  if (row.wasted && typeof row.wasted === "object") {
    for (const [unit, amount] of Object.entries(row.wasted as Record<string, unknown>)) {
      if (typeof amount === "number" && Number.isFinite(amount)) wasted[unit] = amount;
    }
  }
  return {
    rule: row.rule,
    severity: typeof row.severity === "string" ? row.severity : "",
    template: typeof row.template === "string" ? row.template : "",
    message: typeof row.message === "string" ? row.message : "",
    wasted,
  };
}

function parseFindings(text: string): Finding[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) return [];
  const out: Finding[] = [];
  for (const item of value) {
    const finding = asFinding(item);
    if (finding) out.push(finding);
  }
  return out;
}

/**
 * Owns one wasm `Readmeter`. Raw calls queue (cap 1000, drop oldest) until
 * `attach`. Nothing here throws into the host.
 */
export class CoreClient {
  private handle: WasmHandle | undefined;
  private queue: string[] = [];
  private disabled = false;
  private readonly dev: boolean;
  private readonly debug: boolean;
  private readonly onFinding: ((finding: Finding) => void) | undefined;

  constructor(opts: CoreOptions = {}) {
    this.dev = opts.dev === true;
    this.debug = opts.debug === true;
    this.onFinding = opts.onFinding;
  }

  get depth(): number {
    return this.queue.length;
  }

  isDebug(): boolean {
    return this.debug;
  }

  disable(): void {
    this.disabled = true;
    this.queue = [];
  }

  takeQueue(): string[] {
    const queued = this.queue;
    this.queue = [];
    return queued;
  }

  restore(items: readonly string[]): void {
    if (this.disabled) return;
    for (const json of items) {
      this.queue.push(json);
      if (this.queue.length > QUEUE_CAP) this.queue.shift();
    }
  }

  record(raw: unknown): RecordResult {
    if (this.disabled) return { findings: [], wrote: false };
    let json: string;
    try {
      json = typeof raw === "string" ? raw : JSON.stringify(raw);
    } catch (error) {
      debugOnce(this.debug, error);
      return { findings: [], wrote: false };
    }
    if (this.debug) console.debug("[readmeter] raw", json);
    if (!this.handle) {
      this.queue.push(json);
      if (this.queue.length > QUEUE_CAP) this.queue.shift();
      return { findings: [], wrote: false };
    }
    return { findings: this.write(json), wrote: true };
  }

  /** Drains the queue into wasm. Returns how many calls were written. */
  attach(handle: WasmHandle): number {
    if (this.disabled) {
      try {
        handle.free();
      } catch (error) {
        debugOnce(this.debug, error);
      }
      return 0;
    }
    if (this.handle) this.free();
    this.handle = handle;
    const pending = this.queue.splice(0, this.queue.length);
    for (const json of pending) this.write(json);
    return pending.length;
  }

  /** Encoded batch, or `undefined` when there is nothing to send. */
  drain(nowMs: number): Uint8Array | undefined {
    if (!this.handle || this.disabled) return undefined;
    try {
      const bytes = this.handle.flush(nowMs);
      return bytes && bytes.byteLength > 0 ? bytes : undefined;
    } catch (error) {
      debugOnce(this.debug, error);
      return undefined;
    }
  }

  activeRules(): string[] {
    if (!this.handle || this.disabled) return [];
    try {
      return this.handle.activeRules();
    } catch (error) {
      debugOnce(this.debug, error);
      return [];
    }
  }

  free(): void {
    const handle = this.handle;
    this.handle = undefined;
    if (!handle) return;
    try {
      handle.free();
    } catch (error) {
      debugOnce(this.debug, error);
    }
  }

  private write(json: string): Finding[] {
    if (!this.handle) return [];
    try {
      const findings = parseFindings(this.handle.record(json));
      for (const finding of findings) {
        try {
          this.onFinding?.(finding);
        } catch (error) {
          debugOnce(this.debug, error);
        }
        if (this.dev) {
          console.warn(`[readmeter] ${finding.severity} ${finding.rule} ${finding.template}: ${finding.message}`);
        }
      }
      return findings;
    } catch (error) {
      debugOnce(this.debug, error);
      return [];
    }
  }
}

let active = new CoreClient();
let onWrote: () => void = () => {};
let rawObserver: ((raw: unknown) => void) | undefined;

/**
 * Server tally hook. The admin SDK registers it. The browser bundle does not.
 * An observer error is logged and does not drop the record.
 */
export function setRawObserver(observer: ((raw: unknown) => void) | undefined): void {
  rawObserver = observer;
}

/** Entry the public API and the later sink use. Never throws. */
export function recordRaw(raw: unknown): Finding[] {
  try {
    if (rawObserver) {
      try {
        rawObserver(raw);
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
    }
    const result = active.record(raw);
    if (result.wrote) onWrote();
    return result.findings;
  } catch {
    return [];
  }
}

/**
 * Points new calls at `next` and returns the previous client so the caller
 * can flush and free it. Queued calls that never reached wasm move across.
 */
export function handoff(next: CoreClient, wrote: () => void): CoreClient {
  const previous = active;
  const queued = previous.takeQueue();
  active = next;
  next.restore(queued);
  onWrote = wrote;
  return previous;
}

export function disableRecording(): void {
  active.disable();
  onWrote = () => {};
}

/** Whether the active client was started with `debug`. */
export function sdkDebug(): boolean {
  return active.isDebug();
}
