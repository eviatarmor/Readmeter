/**
 * Reads a Realtime Database query shape from the modular SDK.
 *
 * Public `Query.toString()` is only the repo URL plus the path, so limits and
 * bounds live on the internal `QueryImpl._queryParams` (verified against
 * `@firebase/database` 1.1.5). The browser bundle does not read package.json;
 * a shape that is not the one checked here is skipped and the call is recorded
 * with its path only.
 */

import { sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";

/** `JSON.stringify` longer than this is capped. Matches the normalizer's unit. */
export const MAX_JSON_BYTES = 10_000_000;

export interface RawFilter {
  field: string;
  op: string;
  value: unknown;
}

export interface RawQuery {
  order_by?: string;
  limit?: number;
  limit_to_last?: boolean;
  start?: unknown;
  end?: unknown;
  filters?: RawFilter[];
}

interface IndexLike {
  toString?: () => string;
}

interface ParamsLike {
  hasStart: () => boolean;
  hasEnd: () => boolean;
  hasLimit: () => boolean;
  isViewFromLeft: () => boolean;
  getLimit: () => number;
  getIndexStartValue: () => unknown;
  getIndexEndValue: () => unknown;
  getIndex: () => IndexLike;
  isDefault: () => boolean;
  startAfterSet_?: boolean;
  endBeforeSet_?: boolean;
}

interface RefLike {
  key?: string | null;
  parent?: RefLike | null;
}

interface PathLike {
  pieces_?: unknown;
  pieceNum_?: unknown;
}

let shapeWarned = false;

function warnShape(detail: string): void {
  if (shapeWarned) return;
  shapeWarned = true;
  debugOnce(sdkDebug(), new Error(`Realtime Database query shape was not recognized (@firebase/database 1.1.5). ${detail}`));
}

function isParams(value: unknown): value is ParamsLike {
  if (!value || typeof value !== "object") return false;
  const params = value as Partial<ParamsLike>;
  return (
    typeof params.isDefault === "function" &&
    typeof params.getIndex === "function" &&
    typeof params.hasStart === "function" &&
    typeof params.hasEnd === "function" &&
    typeof params.hasLimit === "function" &&
    typeof params.isViewFromLeft === "function" &&
    typeof params.getLimit === "function" &&
    typeof params.getIndexStartValue === "function" &&
    typeof params.getIndexEndValue === "function"
  );
}

function paramsOf(query: object): ParamsLike | undefined {
  const host = query as { _queryParams?: unknown; _delegate?: { _queryParams?: unknown } };
  if (isParams(host._queryParams)) return host._queryParams;
  const delegated = host._delegate;
  if (delegated && typeof delegated === "object" && isParams(delegated._queryParams)) return delegated._queryParams;
  return undefined;
}

function orderField(index: IndexLike): string | undefined {
  if (typeof index.toString !== "function") {
    warnShape("index has no toString");
    return undefined;
  }
  const spec = index.toString();
  if (spec === ".key") return "$key";
  if (spec === ".value") return "$value";
  if (spec === ".priority") return "$priority";
  if (spec.startsWith(".")) {
    warnShape(`unexpected index ${spec}`);
    return undefined;
  }
  return spec;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * Constraints worth putting on the envelope. A default query (priority index,
 * no start, end, or limit) returns undefined. `orderByPriority()` alone is
 * that default and is omitted with it.
 */
export function readQueryShape(query: unknown): RawQuery | undefined {
  if (!query || typeof query !== "object") return undefined;
  const params = paramsOf(query);
  if (!params) {
    const host = query as { _queryParams?: unknown; _delegate?: unknown };
    if (host._queryParams !== undefined || host._delegate !== undefined) warnShape("query params shape changed");
    return undefined;
  }
  let def = false;
  try {
    def = params.isDefault();
  } catch (error) {
    warnShape(error instanceof Error ? error.message : "isDefault failed");
    return undefined;
  }
  if (def) return undefined;
  try {
    const shape: RawQuery = {};
    const order = orderField(params.getIndex());
    if (order) shape.order_by = order;
    const hasStart = params.hasStart();
    const hasEnd = params.hasEnd();
    const start = hasStart ? params.getIndexStartValue() : undefined;
    const end = hasEnd ? params.getIndexEndValue() : undefined;
    const inclusive = params.startAfterSet_ !== true && params.endBeforeSet_ !== true;
    if (hasStart && hasEnd && inclusive && order && sameJson(start, end)) {
      shape.filters = [{ field: order, op: "==", value: start }];
    }
    if (hasStart) shape.start = start;
    if (hasEnd) shape.end = end;
    if (params.hasLimit()) {
      const limit = params.getLimit();
      if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
        shape.limit = limit;
        shape.limit_to_last = !params.isViewFromLeft();
      }
    }
    const has =
      shape.order_by !== undefined ||
      shape.limit !== undefined ||
      Object.prototype.hasOwnProperty.call(shape, "start") ||
      Object.prototype.hasOwnProperty.call(shape, "end") ||
      (shape.filters !== undefined && shape.filters.length > 0);
    return has ? shape : undefined;
  } catch (error) {
    warnShape(error instanceof Error ? error.message : "query params read failed");
    return undefined;
  }
}

function refOf(query: object): RefLike | undefined {
  const host = query as { ref?: unknown };
  if (host.ref && typeof host.ref === "object") return host.ref as RefLike;
  return undefined;
}

function pathFromPieces(path: PathLike): string | undefined {
  if (!Array.isArray(path.pieces_) || typeof path.pieceNum_ !== "number") return undefined;
  const pieces = path.pieces_.filter((piece): piece is string => typeof piece === "string" && piece.length > 0);
  const start = path.pieceNum_ > 0 ? path.pieceNum_ : 0;
  return pieces.slice(start).join("/");
}

/** Concrete path. Empty string is the database root. */
export function readPath(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const ref = refOf(query);
  if (ref) {
    const parts: string[] = [];
    const seen = new Set<object>();
    let cur: RefLike | null | undefined = ref;
    while (cur && typeof cur === "object" && !seen.has(cur)) {
      seen.add(cur);
      if (typeof cur.key === "string" && cur.key.length > 0) parts.push(cur.key);
      cur = cur.parent;
    }
    if (parts.length > 0 || ref.key === null || ref.key === undefined) return parts.reverse().join("/");
  }
  const host = query as { _path?: PathLike; _delegate?: { _path?: PathLike } };
  const internal = host._path ?? host._delegate?._path;
  if (internal) {
    const text = pathFromPieces(internal);
    if (text !== undefined) return text;
  }
  warnShape("path shape changed");
  return "";
}

/** `JSON.stringify(value).length`, capped. `undefined` is 0. A throw records 0. */
export function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return 0;
    return text.length > MAX_JSON_BYTES ? MAX_JSON_BYTES : text.length;
  } catch (error) {
    debugOnce(sdkDebug(), error);
    return 0;
  }
}

export function childCount(snapshot: unknown): number {
  if (!snapshot || typeof snapshot !== "object") return 0;
  const host = snapshot as { size?: unknown; numChildren?: () => unknown };
  let size: unknown = host.size;
  if (typeof size !== "number" && typeof host.numChildren === "function") {
    try {
      size = host.numChildren();
    } catch (error) {
      debugOnce(sdkDebug(), error);
      size = 0;
    }
  }
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : 0;
}

export function snapshotValue(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object" || typeof (snapshot as { val?: unknown }).val !== "function") return undefined;
  try {
    return (snapshot as { val: () => unknown }).val();
  } catch (error) {
    debugOnce(sdkDebug(), error);
    return undefined;
  }
}
