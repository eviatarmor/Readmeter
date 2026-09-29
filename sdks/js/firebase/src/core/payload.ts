/**
 * Canonical payload digest and the write signal sent on set/update/create.
 * The digest is not a security boundary: the core re-keys it. The salt never
 * leaves this process.
 */

import { payloadSalt } from "./session.ts";
import { jsValueByteSize, newWalk, protoFieldsByteStats, stringSize, type WalkBudget } from "./size.ts";

const text = new TextEncoder();
const FNV_PRIME = 0x01000193;
const MAX_DEPTH = 20;

export interface WriteSignal {
  max_field_bytes: number;
  payload_bytes: number;
  transforms: string[];
  digest?: string;
}

class Digester {
  private a: number;
  private b: number;

  constructor(salt: bigint) {
    this.a = Number(salt & 0xffffffffn) >>> 0;
    this.b = Number((salt >> 32n) & 0xffffffffn) >>> 0;
    this.byte(0x52);
    this.byte(0x4d);
  }

  byte(n: number): void {
    const b = n & 0xff;
    this.a = Math.imul(this.a ^ b, FNV_PRIME) >>> 0;
    this.b = Math.imul(this.b ^ (b ^ 0x5a), FNV_PRIME) >>> 0;
  }

  bytes(data: Uint8Array): void {
    for (const b of data) this.byte(b);
  }

  u32(n: number): void {
    this.byte(n);
    this.byte(n >>> 8);
    this.byte(n >>> 16);
    this.byte(n >>> 24);
  }

  bool(value: boolean): void {
    this.byte(value ? 1 : 0);
  }

  str(value: string): void {
    const encoded = text.encode(value);
    this.u32(encoded.length);
    this.bytes(encoded);
  }

  f64(value: number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    this.bytes(new Uint8Array(buf));
  }

  tag(n: number): void {
    this.byte(n);
  }

  finish(): string {
    const mixed = (BigInt(this.a) << 32n) | BigInt(this.b);
    return mixed.toString(16).padStart(16, "0");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isTimestamp(value: unknown): value is { seconds: number; nanoseconds: number } {
  if (!value || typeof value !== "object" || isPlainObject(value)) return false;
  const v = value as { seconds?: unknown; nanoseconds?: unknown; toDate?: unknown };
  return typeof v.seconds === "number" && typeof v.nanoseconds === "number" && typeof v.toDate === "function";
}

function isGeoPoint(value: unknown): value is { latitude: number; longitude: number } {
  if (!value || typeof value !== "object" || isPlainObject(value)) return false;
  const v = value as { latitude?: unknown; longitude?: unknown };
  return typeof v.latitude === "number" && typeof v.longitude === "number";
}

function isBytes(value: unknown): boolean {
  if (!value || typeof value !== "object" || isPlainObject(value)) return false;
  return typeof (value as { toUint8Array?: unknown }).toUint8Array === "function";
}

function isReference(value: unknown): value is { path: string } {
  if (!value || typeof value !== "object" || isPlainObject(value)) return false;
  const v = value as { path?: unknown; firestore?: unknown };
  return typeof v.path === "string" && !!v.firestore && typeof v.firestore === "object";
}

function digestValue(d: Digester, value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) {
    d.tag(255);
    return;
  }
  if (value === null) {
    d.tag(0);
    return;
  }
  const kind = typeof value;
  if (kind === "boolean") {
    d.tag(1);
    d.bool(value as boolean);
    return;
  }
  if (kind === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      d.tag(3);
      d.byte(Number.isNaN(n) ? 0 : n > 0 ? 1 : 2);
      return;
    }
    d.tag(2);
    d.f64(n);
    return;
  }
  if (kind === "string") {
    d.tag(4);
    d.str(value as string);
    return;
  }
  if (kind !== "object" || value === null) {
    d.tag(255);
    return;
  }
  if (Array.isArray(value)) {
    d.tag(5);
    d.u32(value.length);
    for (const item of value) digestValue(d, item, depth + 1);
    return;
  }
  if (value instanceof Date) {
    d.tag(7);
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      d.tag(0);
      return;
    }
    const seconds = Math.trunc(ms / 1000);
    const nanos = (ms - seconds * 1000) * 1_000_000;
    d.f64(seconds);
    d.u32(nanos);
    return;
  }
  if (isTimestamp(value)) {
    d.tag(7);
    d.f64(value.seconds);
    d.u32(value.nanoseconds);
    return;
  }
  if (isGeoPoint(value)) {
    d.tag(9);
    d.f64(value.latitude);
    d.f64(value.longitude);
    return;
  }
  if (isBytes(value)) {
    d.tag(8);
    try {
      const bytes = (value as { toUint8Array: () => Uint8Array }).toUint8Array();
      d.u32(bytes.length);
      d.bytes(bytes);
    } catch {
      d.u32(0);
    }
    return;
  }
  if (isReference(value)) {
    d.tag(10);
    d.str(value.path);
    return;
  }
  if (isPlainObject(value)) {
    d.tag(6);
    const keys = Object.keys(value).sort();
    d.u32(keys.length);
    for (const key of keys) {
      d.str(key);
      digestValue(d, (value as Record<string, unknown>)[key], depth + 1);
    }
    return;
  }
  d.tag(255);
}

function digestFields(fields: Record<string, unknown>, merge: boolean, mergeFields: string[]): string {
  const d = new Digester(payloadSalt());
  d.bool(merge);
  const sorted = [...mergeFields].sort();
  d.u32(sorted.length);
  for (const field of sorted) d.str(field);
  digestValue(d, fields, 0);
  return d.finish();
}

function fieldName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { canonicalString?: unknown }).canonicalString === "function") {
    try {
      const name = (value as { canonicalString: () => string }).canonicalString();
      return typeof name === "string" ? name : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Splits a Firestore field path. Backtick-quoted segments stay whole. */
export function splitFieldPath(path: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < path.length; i += 1) {
    const ch = path[i] ?? "";
    if (quoted) {
      if (ch === "\\") {
        const next = path[i + 1];
        if (next === "`" || next === "\\") {
          current += next;
          i += 1;
          continue;
        }
      }
      if (ch === "`") {
        quoted = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "`") {
      quoted = true;
      continue;
    }
    if (ch === ".") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.filter((part) => part.length > 0);
}

function place(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = splitFieldPath(path);
  if (parts.length === 0) return;
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i] ?? "";
    const existing = cursor[key];
    if (!isPlainObject(existing)) {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
      continue;
    }
    cursor = existing;
  }
  const leaf = parts[parts.length - 1] ?? "";
  cursor[leaf] = value;
}

function readOptions(options: unknown): { merge: boolean; mergeFields: string[] } | undefined {
  if (options === undefined) return { merge: false, mergeFields: [] };
  if (!options || typeof options !== "object") return undefined;
  const o = options as { merge?: unknown; mergeFields?: unknown };
  if (o.merge !== undefined && typeof o.merge !== "boolean") return undefined;
  const mergeFields: string[] = [];
  if (o.mergeFields !== undefined) {
    if (!Array.isArray(o.mergeFields)) return undefined;
    for (const field of o.mergeFields) {
      const name = fieldName(field);
      if (name === undefined) return undefined;
      mergeFields.push(name);
    }
  }
  return { merge: o.merge === true, mergeFields };
}

function fieldsFromUpdate(args: unknown[]): Record<string, unknown> | undefined {
  if (args.length === 0) return undefined;
  const first = args[0];
  if (args.length === 1 && first && typeof first === "object" && !Array.isArray(first) && isPlainObject(first)) {
    const root: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(first)) place(root, key, value);
    return root;
  }
  if (typeof first === "string" || (first && typeof first === "object" && typeof (first as { canonicalString?: unknown }).canonicalString === "function")) {
    if (args.length % 2 !== 0) return undefined;
    const root: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i += 2) {
      const name = fieldName(args[i]);
      if (name === undefined) return undefined;
      place(root, name, args[i + 1]);
    }
    return root;
  }
  return undefined;
}

function measure(fields: Record<string, unknown>, walk: WalkBudget): { max: number; sum: number } {
  let max = 0;
  let sum = 0;
  for (const [name, value] of Object.entries(fields)) {
    if (walk.elements >= 10_000) {
      walk.capped = true;
      break;
    }
    walk.elements += 1;
    const size = stringSize(name) + jsValueByteSize(value, 1, walk);
    if (size > max) max = size;
    sum += size;
  }
  return { max, sum };
}

function finish(fields: Record<string, unknown>, merge: boolean, mergeFields: string[]): WriteSignal {
  const walk = newWalk();
  const { max, sum } = measure(fields, walk);
  const signal: WriteSignal = {
    max_field_bytes: max,
    payload_bytes: sum,
    transforms: [...walk.transforms].sort(),
  };
  if (signal.transforms.length === 0 && !walk.capped) {
    signal.digest = digestFields(fields, merge, mergeFields);
  }
  return signal;
}

/**
 * Write signal for one set, update, or create. `payload` is the user data
 * object, except for update where it is the argument list after the reference.
 * Returns undefined when the arguments are not a shape this SDK understands.
 */
export function writeSignal(kind: "set" | "update" | "create", payload: unknown, options?: unknown): WriteSignal | undefined {
  try {
    if (kind === "update") {
      if (!Array.isArray(payload)) return undefined;
      const fields = fieldsFromUpdate(payload);
      if (!fields) return undefined;
      return finish(fields, false, []);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !isPlainObject(payload)) return undefined;
    const opts = readOptions(options);
    if (!opts) return undefined;
    return finish(payload as Record<string, unknown>, opts.merge, opts.mergeFields);
  } catch {
    return undefined;
  }
}

const PROTO_TRANSFORMS: Record<string, string> = {
  increment: "increment",
  appendMissingElements: "array_union",
  removeAllFromArray: "array_remove",
  setToServerValue: "server_timestamp",
  maximum: "maximum",
  minimum: "minimum",
};

function digestProto(d: Digester, value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if ("nullValue" in v) {
    d.tag(0);
    return true;
  }
  if ("booleanValue" in v) {
    d.tag(1);
    d.bool(v.booleanValue === true);
    return true;
  }
  if ("integerValue" in v) {
    d.tag(2);
    d.str(String(v.integerValue));
    return true;
  }
  if ("doubleValue" in v) {
    const n = typeof v.doubleValue === "number" ? v.doubleValue : Number(v.doubleValue);
    d.tag(3);
    if (!Number.isFinite(n)) d.byte(0);
    else d.f64(n);
    return true;
  }
  if ("timestampValue" in v) {
    d.tag(4);
    d.str(typeof v.timestampValue === "string" ? v.timestampValue : "");
    return true;
  }
  if ("stringValue" in v) {
    d.tag(5);
    d.str(typeof v.stringValue === "string" ? v.stringValue : "");
    return true;
  }
  if ("bytesValue" in v) {
    d.tag(6);
    d.str(typeof v.bytesValue === "string" ? v.bytesValue : "");
    return true;
  }
  if ("referenceValue" in v) {
    d.tag(7);
    d.str(typeof v.referenceValue === "string" ? v.referenceValue : "");
    return true;
  }
  if ("geoPointValue" in v) {
    const g = v.geoPointValue as { latitude?: unknown; longitude?: unknown } | null;
    d.tag(8);
    d.f64(typeof g?.latitude === "number" ? g.latitude : 0);
    d.f64(typeof g?.longitude === "number" ? g.longitude : 0);
    return true;
  }
  if ("arrayValue" in v) {
    const values = (v.arrayValue as { values?: unknown[] } | null)?.values ?? [];
    d.tag(9);
    d.u32(values.length);
    for (const item of values) {
      if (!digestProto(d, item, depth + 1)) return false;
    }
    return true;
  }
  if ("mapValue" in v) {
    const fields = (v.mapValue as { fields?: Record<string, unknown> } | null)?.fields ?? {};
    d.tag(10);
    return digestProtoMap(d, fields, depth + 1);
  }
  return false;
}

function digestProtoMap(d: Digester, fields: Record<string, unknown>, depth: number): boolean {
  const keys = Object.keys(fields).sort();
  d.u32(keys.length);
  for (const key of keys) {
    d.str(key);
    if (!digestProto(d, fields[key], depth)) return false;
  }
  return true;
}

function transformLists(write: Record<string, unknown>): unknown[] {
  const lists: unknown[] = [];
  if (Array.isArray(write.updateTransforms)) lists.push(...write.updateTransforms);
  const transform = write.transform;
  if (transform && typeof transform === "object") {
    const fieldTransforms = (transform as { fieldTransforms?: unknown }).fieldTransforms;
    if (Array.isArray(fieldTransforms)) lists.push(...fieldTransforms);
  }
  return lists;
}

/**
 * Sizes and digest of one admin Commit write. `request` is the Commit proto.
 * Undefined when the write has no field map.
 */
export function protoWriteSignal(request: unknown): WriteSignal | undefined {
  try {
    if (!request || typeof request !== "object") return undefined;
    const writes = (request as { writes?: unknown }).writes;
    if (!Array.isArray(writes) || writes.length !== 1) return undefined;
    const write = writes[0];
    if (!write || typeof write !== "object") return undefined;
    const update = (write as { update?: { fields?: unknown } }).update;
    const fields = update?.fields;
    if (!fields || typeof fields !== "object") return undefined;
    const stats = protoFieldsByteStats(fields);
    const names = new Set<string>();
    let unrecognized = false;
    for (const item of transformLists(write as Record<string, unknown>)) {
      if (!item || typeof item !== "object") {
        unrecognized = true;
        continue;
      }
      let known = false;
      for (const key of Object.keys(item as object)) {
        if (key === "fieldPath" || key === "field_path") continue;
        const mapped = PROTO_TRANSFORMS[key];
        if (mapped) {
          names.add(mapped);
          known = true;
        }
      }
      if (!known) unrecognized = true;
    }
    const signal: WriteSignal = {
      max_field_bytes: stats.max,
      payload_bytes: stats.sum,
      transforms: [...names].sort(),
    };
    if (signal.transforms.length === 0 && !unrecognized) {
      const d = new Digester(payloadSalt());
      if (digestProtoMap(d, fields as Record<string, unknown>, 0)) signal.digest = d.finish();
    }
    return signal;
  } catch {
    return undefined;
  }
}
