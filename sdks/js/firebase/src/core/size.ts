/**
 * Firestore storage-size estimate.
 *
 * Formulas follow "Storage size calculations" (firebase.google.com/docs/firestore/storage-size):
 * string = UTF-8 bytes + 1, document name = each path segment's string size + 16,
 * document = name + field names + field values + 32. A map uses the document
 * formula without a document name, so it adds 32 and not another 16.
 * The web SDK exposes fields at `snapshot._document.data.value.mapValue.fields`.
 */

const text = new TextEncoder();

export interface ProtoValue {
  stringValue?: string;
  integerValue?: string | number;
  doubleValue?: number | string;
  booleanValue?: boolean;
  nullValue?: null | string;
  timestampValue?: string;
  bytesValue?: string;
  referenceValue?: string;
  geoPointValue?: { latitude?: number; longitude?: number };
  arrayValue?: { values?: ProtoValue[] };
  mapValue?: { fields?: Record<string, ProtoValue> };
  vectorValue?: { values?: number[] };
}

export function stringSize(value: string): number {
  return text.encode(value).length + 1;
}

/** `collection/doc/...` segment sizes plus the 16-byte document-name overhead. */
export function documentNameSize(path: string): number {
  let size = 16;
  for (const part of path.split("/")) {
    if (part.length > 0) size += stringSize(part);
  }
  return size;
}

function base64Size(value: string): number {
  const clean = value.replace(/[^A-Za-z0-9+/]/g, "");
  return Math.floor((clean.length * 3) / 4);
}

function referenceSize(value: string): number {
  const marker = "/documents/";
  const at = value.indexOf(marker);
  const path = at >= 0 ? value.slice(at + marker.length) : value;
  return documentNameSize(path);
}

function fieldsSize(fields: unknown): number {
  if (!fields || typeof fields !== "object") return 0;
  let size = 0;
  for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
    size += stringSize(name) + valueByteSize(value);
  }
  return size;
}

/** Byte size of one Firestore proto Value. Returns 0 for a shape it does not know. */
export function valueByteSize(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const v = value as Record<string, unknown>;
  if ("nullValue" in v) return 1;
  if ("booleanValue" in v) return 1;
  if ("integerValue" in v) return 8;
  if ("doubleValue" in v) return 8;
  if ("timestampValue" in v) return 8;
  if ("geoPointValue" in v) return 16;
  if ("stringValue" in v) return typeof v.stringValue === "string" ? stringSize(v.stringValue) : 1;
  if ("bytesValue" in v) return typeof v.bytesValue === "string" ? base64Size(v.bytesValue) : 0;
  if ("referenceValue" in v) return typeof v.referenceValue === "string" ? referenceSize(v.referenceValue) : 0;
  if ("arrayValue" in v) {
    const values = (v.arrayValue as { values?: unknown[] } | null)?.values ?? [];
    let size = 0;
    for (const item of values) size += valueByteSize(item);
    return size;
  }
  if ("mapValue" in v) {
    const fields = (v.mapValue as { fields?: unknown } | null)?.fields ?? {};
    return fieldsSize(fields) + 32;
  }
  if ("vectorValue" in v) {
    const values = (v.vectorValue as { values?: unknown[] } | null)?.values ?? [];
    return values.length * 8;
  }
  return 0;
}

/**
 * Estimated stored size of one document. `fields` is the proto `mapValue.fields`
 * object (not the document wrapper). Never throws.
 */
export function documentByteSize(path: string, fields: unknown): number {
  try {
    return documentNameSize(path) + fieldsSize(fields) + 32;
  } catch {
    return 0;
  }
}

const MAX_DEPTH = 20;
const MAX_ELEMENTS = 10_000;

const TRANSFORMS: Record<string, string> = {
  increment: "increment",
  arrayUnion: "array_union",
  arrayRemove: "array_remove",
  serverTimestamp: "server_timestamp",
  deleteField: "delete_field",
  maximum: "maximum",
  minimum: "minimum",
};

export interface WalkBudget {
  elements: number;
  capped: boolean;
  transforms: Set<string>;
}

export function newWalk(): WalkBudget {
  return { elements: 0, capped: false, transforms: new Set() };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function transformName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const name = (value as { _methodName?: unknown })._methodName;
  if (typeof name !== "string") return undefined;
  return TRANSFORMS[name];
}

function isTimestamp(value: unknown): boolean {
  if (!value || typeof value !== "object" || isPlainObject(value)) return false;
  const v = value as { seconds?: unknown; nanoseconds?: unknown; toDate?: unknown };
  return typeof v.seconds === "number" && typeof v.nanoseconds === "number" && typeof v.toDate === "function";
}

function isGeoPoint(value: unknown): boolean {
  if (!value || typeof value !== "object" || isPlainObject(value)) return false;
  const v = value as { latitude?: unknown; longitude?: unknown };
  return typeof v.latitude === "number" && typeof v.longitude === "number";
}

function isBytes(value: unknown): boolean {
  if (!value || typeof value !== "object" || isPlainObject(value)) return false;
  return typeof (value as { toUint8Array?: unknown }).toUint8Array === "function";
}

function bytesLength(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  try {
    const bytes = (value as { toUint8Array: () => Uint8Array }).toUint8Array();
    return bytes?.length ?? 0;
  } catch {
    return 0;
  }
}

function isReference(value: unknown): value is { path: string } {
  if (!value || typeof value !== "object" || isPlainObject(value)) return false;
  const v = value as { path?: unknown; firestore?: unknown };
  return typeof v.path === "string" && !!v.firestore && typeof v.firestore === "object";
}

function take(walk: WalkBudget): boolean {
  if (walk.elements >= MAX_ELEMENTS) {
    walk.capped = true;
    return false;
  }
  walk.elements += 1;
  return true;
}

/**
 * Stored size of a JavaScript value the web SDK is about to write.
 * Plain objects are maps. Class instances other than Timestamp, Date, Bytes,
 * GeoPoint and DocumentReference count as 0. FieldValue sentinels count as 0
 * and are recorded on `walk.transforms`. Never throws.
 */
export function jsValueByteSize(value: unknown, depth = 0, walk: WalkBudget = newWalk()): number {
  try {
    if (depth > MAX_DEPTH) {
      walk.capped = true;
      return 0;
    }
    if (value === null) return 1;
    const kind = typeof value;
    if (kind === "string") return stringSize(value as string);
    if (kind === "number") return 8;
    if (kind === "boolean") return 1;
    if (kind !== "object" || value === null) return 0;
    if (Array.isArray(value)) {
      let size = 0;
      for (const item of value) {
        if (!take(walk)) break;
        size += jsValueByteSize(item, depth + 1, walk);
      }
      return size;
    }
    const sentinel = transformName(value);
    if (sentinel) {
      walk.transforms.add(sentinel);
      return 0;
    }
    if (value instanceof Date) return 8;
    if (isTimestamp(value)) return 8;
    if (isGeoPoint(value)) return 16;
    if (isBytes(value)) return bytesLength(value);
    if (isReference(value)) return documentNameSize(value.path);
    if (isPlainObject(value)) {
      let size = 32;
      for (const [name, child] of Object.entries(value)) {
        if (!take(walk)) break;
        size += stringSize(name) + jsValueByteSize(child, depth + 1, walk);
      }
      return size;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Name + value sizes of proto `mapValue.fields`. The map's own +32 is not included. */
export function protoFieldsByteStats(fields: unknown): { max: number; sum: number } {
  if (!fields || typeof fields !== "object") return { max: 0, sum: 0 };
  let max = 0;
  let sum = 0;
  for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
    const size = stringSize(name) + valueByteSize(value);
    if (size > max) max = size;
    sum += size;
  }
  return { max, sum };
}
