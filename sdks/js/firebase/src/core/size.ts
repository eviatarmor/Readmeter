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

function stringSize(value: string): number {
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
