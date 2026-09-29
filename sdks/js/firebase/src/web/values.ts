/**
 * Firestore proto Value → JSON. Admin filters are often already JSON, and
 * those pass through. A shape this does not know becomes null so a later
 * rule stays quiet instead of throwing.
 */

const PROTO_KEYS = [
  "stringValue",
  "booleanValue",
  "nullValue",
  "integerValue",
  "doubleValue",
  "timestampValue",
  "bytesValue",
  "referenceValue",
  "geoPointValue",
  "arrayValue",
  "mapValue",
] as const;

function isProto(value: object): boolean {
  const record = value as Record<string, unknown>;
  return PROTO_KEYS.some((key) => key in record);
}

function integerValue(value: string | number): number | string {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isSafeInteger(n)) return n;
  return String(value);
}

function referencePath(value: string): string {
  const marker = "/documents/";
  const at = value.indexOf(marker);
  return at >= 0 ? value.slice(at + marker.length) : value;
}

/** One proto Value, or a plain JS value from the admin SDK. */
export function decodeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => decodeValue(item));
  if (!isProto(value)) return plainValue(value);
  const v = value as Record<string, unknown>;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue === true;
  if ("stringValue" in v) return typeof v.stringValue === "string" ? v.stringValue : null;
  if ("integerValue" in v && (typeof v.integerValue === "string" || typeof v.integerValue === "number")) {
    return integerValue(v.integerValue);
  }
  if ("doubleValue" in v) {
    const n = typeof v.doubleValue === "number" ? v.doubleValue : Number(v.doubleValue);
    return Number.isFinite(n) ? n : null;
  }
  if ("timestampValue" in v) return typeof v.timestampValue === "string" ? v.timestampValue : null;
  if ("bytesValue" in v) return typeof v.bytesValue === "string" ? v.bytesValue : null;
  if ("referenceValue" in v && typeof v.referenceValue === "string") return referencePath(v.referenceValue);
  if ("geoPointValue" in v) return v.geoPointValue ?? null;
  if ("arrayValue" in v) {
    const values = (v.arrayValue as { values?: unknown[] } | null)?.values ?? [];
    return values.map((item) => decodeValue(item));
  }
  if ("mapValue" in v) {
    const fields = (v.mapValue as { fields?: Record<string, unknown> } | null)?.fields ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(fields)) out[key] = decodeValue(item);
    return out;
  }
  return null;
}

function plainValue(value: object): unknown {
  const v = value as Record<string, unknown>;
  if (v.type === "document" && typeof v.path === "string") return v.path;
  if (typeof v.toDate === "function") {
    try {
      return (v.toDate as () => Date)().toISOString();
    } catch {
      return null;
    }
  }
  if (typeof v.latitude === "number" && typeof v.longitude === "number") {
    return { latitude: v.latitude, longitude: v.longitude };
  }
  return value;
}
