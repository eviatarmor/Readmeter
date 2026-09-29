import { debugOnce } from "./log.ts";
import { isNode } from "./env.ts";

/** Pending encoded batches. Older ones are dropped so a long outage stays bounded. */
const PENDING_CAP = 32;

export interface Timer {
  cancel(): void;
}

export interface Scheduler {
  delay(fn: () => void, ms: number): Timer;
  interval(fn: () => void, ms: number): Timer;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  endpoint: string;
  apiKey: string;
  flushIntervalMs: number;
  maxBatchEvents: number;
  /** Pull one encoded batch from the core. `undefined` when the buffer is empty. */
  takeBatch: () => Uint8Array | undefined;
  fetchFn?: FetchLike;
  scheduler?: Scheduler;
  /** Node `beforeExit` and `SIGTERM`. Tests turn this off. Default true. */
  exitHooks?: boolean;
  debug?: boolean;
}

export interface FlushOptions {
  /** `interval` waits out Retry-After. `user` and `retry` send now. */
  reason?: "interval" | "user" | "retry";
  keepalive?: boolean;
}

function defaultScheduler(): Scheduler {
  return {
    delay(fn, ms) {
      const id = setTimeout(fn, ms);
      (id as { unref?: () => void }).unref?.();
      return { cancel: () => clearTimeout(id) };
    },
    interval(fn, ms) {
      const id = setInterval(fn, ms);
      (id as { unref?: () => void }).unref?.();
      return { cancel: () => clearInterval(id) };
    },
  };
}

/**
 * Seconds, or an HTTP-date, from a `Retry-After` header.
 * `undefined` when the header is missing or not a delay.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0 && header.trim() !== "") return seconds * 1000;
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return undefined;
}

/**
 * Posts encoded batches. A 503 or 429 honors `Retry-After` (at least one
 * second). Other 5xx and network errors use exponential backoff. `flush`
 * resolves after the attempt, including when the network rejects it.
 */
export class Transport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchEvents: number;
  private readonly takeBatch: () => Uint8Array | undefined;
  private readonly fetchFn: FetchLike;
  private readonly scheduler: Scheduler;
  private readonly exitHooks: boolean;
  private readonly debug: boolean;

  private pending: Uint8Array[] = [];
  private events = 0;
  private failures = 0;
  private backoffUntil = 0;
  private chain: Promise<void> = Promise.resolve();
  private retry: Timer | undefined;
  private interval: Timer | undefined;
  private removePageHide: (() => void) | undefined;
  private didExitFlush = false;
  private loggedStatus = new Set<number>();

  constructor(opts: TransportOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.flushIntervalMs = opts.flushIntervalMs;
    this.maxBatchEvents = opts.maxBatchEvents;
    this.takeBatch = opts.takeBatch;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.scheduler = opts.scheduler ?? defaultScheduler();
    this.exitHooks = opts.exitHooks !== false;
    this.debug = opts.debug === true;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** A call was written into the wasm buffer. Flushes early at `maxBatchEvents`. */
  noteEvent(): void {
    this.noteEvents(1);
  }

  /** `count` calls were written together (the queue draining into wasm). */
  noteEvents(count: number): void {
    if (count <= 0) return;
    this.events += count;
    if (this.events >= this.maxBatchEvents && Date.now() >= this.backoffUntil) {
      void this.flush({ reason: "interval" });
    }
  }

  start(): void {
    this.interval?.cancel();
    this.interval = this.scheduler.interval(() => {
      void this.flush({ reason: "interval" });
    }, this.flushIntervalMs);
    this.bindExit();
    this.bindPageHide();
  }

  async flush(opts: FlushOptions = {}): Promise<void> {
    const reason = opts.reason ?? "user";
    try {
      if (reason === "interval" && Date.now() < this.backoffUntil) return;
      if (reason !== "retry") {
        this.retry?.cancel();
        this.retry = undefined;
      }
      if (reason === "user") this.backoffUntil = 0;
      this.events = 0;
      this.pull();
      const run = this.chain.then(() => this.postPending(opts.keepalive === true));
      this.chain = run.catch((error: unknown) => debugOnce(this.debug, error));
      await run;
    } catch (error) {
      debugOnce(this.debug, error);
    }
  }

  async shutdown(): Promise<void> {
    this.interval?.cancel();
    this.interval = undefined;
    this.retry?.cancel();
    this.retry = undefined;
    this.unbindExit();
    this.removePageHide?.();
    this.removePageHide = undefined;
    await this.flush({ reason: "user" });
  }

  private pull(): void {
    const bytes = this.takeBatch();
    if (!bytes || bytes.byteLength === 0) return;
    this.pending.push(new Uint8Array(bytes));
    while (this.pending.length > PENDING_CAP) this.pending.shift();
  }

  private async postPending(keepalive: boolean): Promise<void> {
    while (this.pending.length > 0) {
      const body = this.pending[0];
      if (!body) return;
      let res: Response;
      try {
        res = await this.fetchFn(`${this.endpoint}/v1/batches`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/octet-stream",
          },
          body: body as BodyInit,
          keepalive,
        });
      } catch (error) {
        this.arm(this.nextBackoff());
        debugOnce(this.debug, error);
        return;
      }
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 202) {
        this.pending.shift();
        this.failures = 0;
        continue;
      }
      if (res.status === 503 || res.status === 429) {
        const header = retryAfterMs(res.headers.get("retry-after"));
        const wait = header === undefined ? this.nextBackoff() : Math.max(header, 1000);
        this.arm(wait);
        return;
      }
      if (res.status >= 500) {
        this.arm(this.nextBackoff());
        return;
      }
      this.pending.shift();
      if (!this.loggedStatus.has(res.status)) {
        this.loggedStatus.add(res.status);
        console.error(`[readmeter] ingest rejected a batch (${res.status}).`);
      }
    }
  }

  private nextBackoff(): number {
    const ms = Math.min(60_000, 1000 * 2 ** this.failures);
    this.failures = Math.min(this.failures + 1, 16);
    return ms;
  }

  private arm(ms: number): void {
    this.backoffUntil = Date.now() + ms;
    this.retry?.cancel();
    this.retry = this.scheduler.delay(() => {
      void this.flush({ reason: "retry" });
    }, ms);
  }

  private onBeforeExit = (): void => {
    if (this.didExitFlush) return;
    this.didExitFlush = true;
    void this.flush({ reason: "user", keepalive: true });
  };

  private onSigterm = (): void => {
    void this.flush({ reason: "user", keepalive: true });
  };

  private bindExit(): void {
    if (!this.exitHooks || !isNode()) return;
    process.on("beforeExit", this.onBeforeExit);
    process.on("SIGTERM", this.onSigterm);
  }

  private unbindExit(): void {
    if (!isNode()) return;
    process.off("beforeExit", this.onBeforeExit);
    process.off("SIGTERM", this.onSigterm);
  }

  private onPageHide = (): void => {
    void this.flush({ reason: "user", keepalive: true });
  };

  private bindPageHide(): void {
    if (isNode()) return;
    const w = globalThis as {
      addEventListener?: (type: string, fn: () => void) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
    };
    if (typeof w.addEventListener !== "function") return;
    w.addEventListener("pagehide", this.onPageHide);
    this.removePageHide = () => w.removeEventListener?.("pagehide", this.onPageHide);
  }
}
