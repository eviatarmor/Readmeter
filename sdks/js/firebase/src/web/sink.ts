/**
 * Builds raw calls and records them. Nothing here throws into the host.
 * Manual `sink*` omits `duration_us`. Drop-in wrappers pass `timing.start`.
 */

import { callsite, readSite } from "../core/callsite.ts";
import { recordRaw, sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { currentMount } from "../core/mount.ts";
import type { WriteSignal } from "../core/payload.ts";
import { nextCallId, nextListenerId, nextTransactionId } from "../core/session.ts";
import { scheduleUsage } from "../core/usage.ts";
import type { WriteOp } from "../types.ts";
import {
  aggregateCount,
  aggregationsFromSpec,
  changedDocs,
  commitPath,
  docCount,
  fromCache,
  hasOnlyLocalWrites,
  isAggregateSnapshot,
  mutationStats,
  readTarget,
  resultByteSize,
  type RawQueryShape,
  type TargetShape,
} from "./shape.ts";
import { maybeRecordInit } from "./setup.ts";
import { installDocumentUsage, installUsage, type UsageFlags } from "./usage.ts";

export interface Timing {
  ts: number;
  /** Set by drop-in wrappers. Manual sink leaves this unset so duration is omitted. */
  start?: number;
  site?: string;
  attempt?: number;
  callId?: number;
  /** Read issued from a React component body (dev builds only). */
  inRender?: boolean;
  /** Component instance that issued the call (`runInMount`). */
  mount?: number;
}

/** `timing` plus the current mount id, when there is one. */
export function withCurrentMount(timing: Timing): Timing {
  const mount = currentMount();
  if (mount !== undefined) timing.mount = mount;
  return timing;
}

interface Emit {
  op: string;
  shape: TargetShape;
  timing: Timing;
  listener?: number;
  initial?: true;
  error?: string;
  docs?: number;
  bytes?: number;
  cache?: boolean;
  index?: number;
  withResult?: boolean;
  commit?: { writes: number; deletes: number; transactional: boolean };
  usage?: UsageFlags;
  aggregations?: string[];
  /** Usage calls keep the query's call id and carry no callsite. */
  usageCall?: boolean;
  source?: "server" | "cache";
  write?: WriteSignal;
  transaction?: number;
  /** Firestore instance owner, used to emit one init per instance. */
  instance?: unknown;
}

const WRITES = new Set<WriteOp>(["set", "update", "create", "delete"]);
const READS = new Set(["get", "query", "aggregate"]);

function elapsed(start: number | undefined): number | undefined {
  if (start === undefined) return undefined;
  const us = Math.round((performance.now() - start) * 1000);
  return us < 0 ? 0 : us;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || code.length === 0) return "unknown";
  const slash = code.lastIndexOf("/");
  return slash >= 0 ? code.slice(slash + 1) : code;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

function queryOf(input: Emit): RawQueryShape | undefined {
  if (input.usageCall) return undefined;
  if (input.op === "get" || input.op === "set" || input.op === "update" || input.op === "delete" || input.op === "create" || input.op === "commit") {
    return undefined;
  }
  const query: RawQueryShape = { ...(input.shape.query ?? {}) };
  if (input.aggregations && input.aggregations.length > 0) query.aggregations = input.aggregations;
  if (Object.keys(query).length > 0) return query;
  return input.shape.query ? query : undefined;
}

function usageBody(flags: UsageFlags): UsageFlags {
  const usage: UsageFlags = {
    read_items: flags.read_items,
    read_size: flags.read_size,
    read_empty: flags.read_empty,
  };
  if (typeof flags.items_used === "number") usage.items_used = flags.items_used;
  if (typeof flags.fields_read === "number") {
    usage.fields_read = flags.fields_read;
    usage.fields_numeric = flags.fields_numeric === true;
  }
  return usage;
}

function emit(input: Emit): number {
  if (input.instance) maybeRecordInit(input.instance);
  const callId = input.timing.callId ?? nextCallId();
  const raw: Record<string, unknown> = {
    service: "firestore",
    op: input.op,
    ts_ms: input.timing.ts,
    path: input.shape.path,
    call_id: callId,
  };
  if (!input.usageCall) {
    const duration = elapsed(input.timing.start);
    if (duration !== undefined) raw.duration_us = duration;
    if (input.timing.site) raw.callsite = input.timing.site;
    if (input.timing.inRender && READS.has(input.op)) raw.in_render = true;
  }
  if (input.timing.attempt !== undefined && input.timing.attempt !== 1) raw.attempt = input.timing.attempt;
  if (input.listener !== undefined) raw.listener = input.listener;
  if (input.timing.mount !== undefined && !input.usageCall) raw.mount = input.timing.mount;
  if (input.initial) raw.initial = true;
  if (input.error) raw.error = input.error;
  if (input.shape.collectionGroup) raw.collection_group = true;
  const query = queryOf(input);
  if (query) raw.query = query;
  if (input.withResult) {
    const result: Record<string, unknown> = { docs: input.docs ?? 0, bytes: input.bytes ?? 0 };
    if (input.cache) result.from_cache = true;
    if (input.index !== undefined) result.index_entries = input.index;
    raw.result = result;
  }
  if (input.commit) raw.commit = input.commit;
  if (input.usage) raw.usage = usageBody(input.usage);
  if (input.source) raw.source = input.source;
  if (input.write) {
    const write: Record<string, unknown> = {
      max_field_bytes: input.write.max_field_bytes,
      payload_bytes: input.write.payload_bytes,
      transforms: input.write.transforms,
    };
    if (input.write.digest !== undefined) write.digest = input.write.digest;
    raw.write = write;
  }
  if (input.transaction !== undefined) raw.transaction = input.transaction;
  recordRaw(raw);
  return callId;
}

function shapeOf(target: unknown): TargetShape | undefined {
  try {
    return readTarget(target);
  } catch (error) {
    debugOnce(sdkDebug(), error);
    return undefined;
  }
}

export function recordQueryResult(target: unknown, snap: unknown, timing: Timing, trackUsage: boolean, source?: "server" | "cache"): void {
  try {
    const shape = shapeOf(target);
    if (!shape || !snap || typeof snap !== "object") return;
    const bytes = resultByteSize(snap);
    const docs = docCount(snap, "query");
    const cache = fromCache(snap);
    const flags = trackUsage ? installUsage(snap) : undefined;
    const callId = emit({ op: "query", shape, timing, withResult: true, docs, bytes, cache, source, instance: target });
    if (!flags) return;
    scheduleUsage(() => {
      try {
        emit({
          op: "usage",
          shape,
          timing: { ts: Date.now(), callId },
          usage: usageBody(flags),
          usageCall: true,
        });
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
    });
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

export function recordGetResult(target: unknown, snap: unknown, timing: Timing, source?: "server" | "cache", trackUsage = false): void {
  try {
    const shape = shapeOf(target);
    if (!shape) return;
    const flags = trackUsage && snap && typeof snap === "object" ? installDocumentUsage(snap) : undefined;
    const callId = emit({
      op: "get",
      shape,
      timing,
      withResult: true,
      docs: docCount(snap, "document"),
      bytes: resultByteSize(snap),
      cache: fromCache(snap),
      source,
      instance: target,
    });
    if (!flags) return;
    scheduleUsage(() => {
      try {
        emit({
          op: "usage",
          shape,
          timing: { ts: Date.now(), callId },
          usage: usageBody(flags),
          usageCall: true,
        });
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
    });
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

export function recordAggregateResult(target: unknown, snap: unknown, aggregations: string[] | undefined, spec: unknown, timing: Timing): void {
  try {
    const shape = shapeOf(target);
    if (!shape) return;
    const names = aggregations && aggregations.length > 0 ? aggregations : shape.query?.aggregations;
    const index = names?.includes("count") ? aggregateCount(snap, spec) : undefined;
    emit({
      op: "aggregate",
      shape,
      timing,
      aggregations: names,
      withResult: true,
      docs: 1,
      bytes: resultByteSize(snap),
      cache: fromCache(snap),
      index,
      instance: target,
    });
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

export function recordWrite(op: string, target: unknown, timing: Timing, write?: WriteSignal): void {
  try {
    const shape = shapeOf(target);
    if (!shape) return;
    emit({ op, shape, timing, write, instance: target });
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

export function recordCreated(ref: unknown, timing: Timing, write?: WriteSignal): void {
  try {
    const path = ref && typeof ref === "object" ? (ref as { path?: unknown }).path : undefined;
    if (typeof path !== "string" || path.length === 0) return;
    emit({ op: "create", shape: { kind: "document", path }, timing, write, instance: ref });
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

export function recordFailure(op: string, target: unknown, error: unknown, timing: Timing, write?: WriteSignal): void {
  try {
    const shape = shapeOf(target);
    if (!shape?.path) return;
    emit({ op, shape, timing, error: errorCode(error), write, instance: target });
  } catch (inner) {
    debugOnce(sdkDebug(), inner);
  }
}

function recordCommit(
  stats: { writes: number; deletes: number; paths: string[] } | undefined,
  timing: Timing,
  error: unknown,
  transactional: boolean,
  transaction?: number,
  instance?: unknown,
): void {
  const path = commitPath(stats?.paths ?? []);
  if (!path) return;
  emit({
    op: "commit",
    shape: { kind: "query", path },
    timing,
    error: error ? errorCode(error) : undefined,
    commit: {
      writes: stats?.writes ?? 0,
      deletes: stats?.deletes ?? 0,
      transactional,
    },
    transaction,
    instance,
  });
}

export function bindBatch(batch: object, created?: string): void {
  try {
    const host = batch as { commit?: (...args: unknown[]) => unknown };
    const original = host.commit;
    if (typeof original !== "function") return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const timing = withCurrentMount({ site: callsite() ?? created, ts: Date.now(), start: performance.now() });
      const stats = mutationStats(batch);
      let pending: unknown;
      try {
        pending = original.apply(this, args);
      } catch (error) {
        recordCommit(stats, timing, error, false);
        throw error;
      }
      if (!isThenable(pending)) {
        recordCommit(stats, timing, undefined, false);
        return pending;
      }
      return watch(
        pending,
        () => recordCommit(stats, timing, undefined, false),
        (error) => recordCommit(stats, timing, error, false),
      );
    };
    Object.defineProperty(batch, "commit", { configurable: true, writable: true, value: wrapped });
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

interface GetNote {
  path: string;
  snap: unknown;
  site?: string;
  ts: number;
  target: unknown;
}

interface Bucket {
  attempt: number;
  gets: GetNote[];
  writes: number;
  deletes: number;
  paths: string[];
  instance?: unknown;
}

export interface TransactionRun {
  run(tx: object): unknown;
  settle(error: unknown | undefined, timing: Timing): void;
}

function patchTransaction(tx: object, bucket: Bucket): void {
  const wrap = (name: string, kind: "get" | "write" | "delete") => {
    const orig = (tx as Record<string, unknown>)[name];
    if (typeof orig !== "function") return;
    Object.defineProperty(tx, name, {
      configurable: true,
      writable: true,
      value(this: unknown, ...args: unknown[]) {
        const result = (orig as (...a: unknown[]) => unknown).apply(this, args);
        try {
          if (!bucket.instance && args[0] && typeof args[0] === "object") bucket.instance = args[0];
          const path = readTarget(args[0])?.path;
          if (kind === "get") {
            const site = callsite();
            const ts = Date.now();
            void Promise.resolve(result).then(
              (snap) => {
                if (path) bucket.gets.push({ path, snap, site, ts, target: args[0] });
              },
              () => undefined,
            );
          } else if (path) {
            if (kind === "delete") bucket.deletes += 1;
            else bucket.writes += 1;
            bucket.paths.push(path);
          }
        } catch (error) {
          debugOnce(sdkDebug(), error);
        }
        return result;
      },
    });
  };
  wrap("get", "get");
  wrap("set", "write");
  wrap("update", "write");
  wrap("delete", "delete");
}

/**
 * The SDK re-runs the user function when a commit fails. Only the attempt
 * whose promise resolves is recorded, and only after the outer transaction
 * promise settles — `settle` does that.
 */
export function instrumentUpdate(updateFunction: (tx: object) => unknown): TransactionRun {
  let attempts = 0;
  let success: Bucket | undefined;
  const transaction = nextTransactionId();
  return {
    run(tx) {
      attempts += 1;
      const bucket: Bucket = { attempt: attempts, gets: [], writes: 0, deletes: 0, paths: [] };
      try {
        patchTransaction(tx, bucket);
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
      const ret = updateFunction(tx);
      if (!isThenable(ret)) {
        success = bucket;
        return ret;
      }
      return ret.then((value) => {
        success = bucket;
        return value;
      });
    },
    settle(error, timing) {
      try {
        const attempt = success?.attempt ?? attempts;
        if (error) {
          recordCommit(success, { ...timing, attempt }, error, true, transaction, success?.instance);
          return;
        }
        if (!success) return;
        const stamped: Timing = { ...timing, attempt: success.attempt };
        for (const get of success.gets) {
          emit({
            op: "get",
            shape: { kind: "document", path: get.path },
            timing: { ts: get.ts, start: timing.start, site: get.site, attempt: success.attempt, mount: timing.mount },
            withResult: true,
            docs: docCount(get.snap, "document"),
            bytes: resultByteSize(get.snap),
            cache: fromCache(get.snap),
            transaction,
            instance: get.target,
          });
        }
        recordCommit(success, stamped, undefined, true, transaction, success.instance);
      } catch (inner) {
        debugOnce(sdkDebug(), inner);
      }
    },
  };
}

export interface ListenerSession {
  /** `at` is set by the drop-in so the snapshot carries `duration_us`. Manual sink omits it. */
  note(snap: unknown, at?: Timing): void;
  fail(error: unknown, at?: Timing): void;
  open(timing: Timing): void;
  close(timing: Timing): void;
}

export function openListener(target: unknown): ListenerSession | undefined {
  try {
    const shape = shapeOf(target);
    if (!shape || shape.kind === "aggregate") return undefined;
    const id = nextListenerId();
    const kind = shape.kind === "document" ? "document" : "query";
    let opened = false;
    let initial = true;
    // Snapshots arrive outside the component's effect; they inherit the
    // mount that opened the listener.
    let mount: number | undefined;
    const stamp = (at: Timing): Timing => (mount === undefined || at.mount !== undefined ? at : { ...at, mount });
    const buffer: Array<() => void> = [];
    const run = (job: () => void): void => {
      if (!opened) buffer.push(job);
      else job();
    };
    return {
      note(snap, at) {
        run(() => {
          try {
            if (hasOnlyLocalWrites(snap, kind)) return;
            const first = initial;
            emit({
              op: "snapshot",
              shape,
              timing: stamp(at ?? { ts: Date.now() }),
              listener: id,
              initial: first ? true : undefined,
              withResult: true,
              docs: changedDocs(snap, kind, first),
              bytes: resultByteSize(snap),
              cache: fromCache(snap),
              instance: target,
            });
            initial = false;
          } catch (error) {
            debugOnce(sdkDebug(), error);
          }
        });
      },
      fail(error, at) {
        run(() => {
          try {
            emit({
              op: "snapshot",
              shape,
              timing: stamp(at ?? { ts: Date.now() }),
              listener: id,
              error: errorCode(error),
              instance: target,
            });
          } catch (inner) {
            debugOnce(sdkDebug(), inner);
          }
        });
      },
      open(timing) {
        mount = timing.mount;
        try {
          emit({ op: "subscribe", shape, timing, listener: id, instance: target });
        } catch (error) {
          debugOnce(sdkDebug(), error);
        }
        opened = true;
        for (const job of buffer.splice(0, buffer.length)) job();
      },
      close(timing) {
        try {
          emit({ op: "unsubscribe", shape, timing: stamp(timing), listener: id, instance: target });
        } catch (error) {
          debugOnce(sdkDebug(), error);
        }
      },
    };
  } catch (error) {
    debugOnce(sdkDebug(), error);
    return undefined;
  }
}

export function watch<T>(pending: Promise<T>, ok: (value: T) => void, fail: (error: unknown) => void): Promise<T> {
  void pending.then(
    (value) => {
      try {
        ok(value);
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
    },
    (error: unknown) => {
      try {
        fail(error);
      } catch (inner) {
        debugOnce(sdkDebug(), inner);
      }
    },
  );
  return pending;
}

/** Returns `result`. Plain objects that are not Firestore values are ignored. */
export function sink<T>(target: unknown, result: T): T {
  try {
    const { site, inRender } = readSite();
    const timing = withCurrentMount({ ts: Date.now(), site, inRender });
    if (isAggregateSnapshot(result)) {
      let names = aggregationsFromSpec((target as { _aggregateSpec?: unknown } | null)?._aggregateSpec);
      if (!names) {
        try {
          const data = (result as { data?: () => { count?: unknown } }).data?.();
          if (typeof data?.count === "number") names = ["count"];
        } catch (error) {
          debugOnce(sdkDebug(), error);
        }
      }
      recordAggregateResult(target, result, names, undefined, timing);
      return result;
    }
    const shape = shapeOf(target);
    if (!shape) return result;
    if (shape.kind === "aggregate") recordAggregateResult(target, result, shape.query?.aggregations, undefined, timing);
    else if (shape.kind === "document") recordGetResult(target, result, timing);
    else recordQueryResult(target, result, timing, false);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return result;
}

/** Returns `ref`. */
export function sinkWrite<T>(ref: T, op: WriteOp): T {
  try {
    if (!WRITES.has(op)) return ref;
    recordWrite(op, ref, withCurrentMount({ ts: Date.now(), site: callsite() }));
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return ref;
}

/**
 * Records subscribe at wrap time and a snapshot on each callback.
 * Unsubscribe is only visible to the drop-in wrapper, which owns the returned function.
 * An unrecognized target returns `listener` unchanged.
 */
export function sinkListener<T>(target: unknown, listener: T): T {
  try {
    const session = openListener(target);
    if (!session) return listener;
    const site = callsite();
    session.open(withCurrentMount({ ts: Date.now(), site }));
    if (typeof listener === "function") {
      const wrapped = (snap: unknown, ...rest: unknown[]) => {
        try {
          session.note(snap);
        } catch (error) {
          debugOnce(sdkDebug(), error);
        }
        return (listener as (snap: unknown, ...rest: unknown[]) => unknown)(snap, ...rest);
      };
      return wrapped as T;
    }
    if (listener && typeof listener === "object" && typeof (listener as { next?: unknown }).next === "function") {
      const obs = listener as unknown as {
        next: (snap: unknown) => unknown;
        error?: (error: unknown) => unknown;
        complete?: () => unknown;
      };
      return {
        next(snap: unknown) {
          try {
            session.note(snap);
          } catch (error) {
            debugOnce(sdkDebug(), error);
          }
          return obs.next(snap);
        },
        error: obs.error
          ? (error: unknown) => {
              try {
                session.fail(error);
              } catch (inner) {
                debugOnce(sdkDebug(), inner);
              }
              return obs.error!(error);
            }
          : undefined,
        complete: obs.complete ? () => obs.complete!() : undefined,
      } as T;
    }
    return listener;
  } catch (error) {
    debugOnce(sdkDebug(), error);
    return listener;
  }
}
