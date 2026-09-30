export interface UsageFlags {
  read_items: boolean;
  read_size: boolean;
  read_empty: boolean;
  /** Set when this snapshot's item reads are being tracked. */
  items_used?: number;
  /**
   * Distinct top-level fields read across the tracked documents. Set when
   * field reads are being tracked. Only the count leaves the process.
   */
  fields_read?: number;
  /** Every field value counted in `fields_read` was a number. */
  fields_numeric?: boolean;
}

const DOC_PATCHED = Symbol.for("readmeter.doc");
const ITEM_CAP = 100_000;
/** Distinct field names kept per snapshot. */
const FIELD_CAP = 256;
/** Documents with more top-level fields than this are not instrumented. */
const DOC_FIELD_CAP = 64;

const INSTALLED = Symbol.for("readmeter.usage");

function findDescriptor(obj: object, name: string): PropertyDescriptor | undefined {
  let cur: object | null = obj;
  while (cur) {
    const desc = Object.getOwnPropertyDescriptor(cur, name);
    if (desc) return desc;
    cur = Object.getPrototypeOf(cur) as object | null;
  }
  return undefined;
}

/**
 * Instance accessors that delegate to the real getters. A Proxy would break
 * `instanceof` and private fields. `empty` calls `size`; the flag stops that
 * inner read from counting as `read_size`, which is what emptiness-check needs.
 * Returns undefined when the snapshot cannot be extended (frozen, future SDK).
 */
function mark(flags: UsageFlags, seen: Set<number>, index: number): void {
  if (seen.has(index) || seen.size >= ITEM_CAP) return;
  seen.add(index);
  flags.items_used = seen.size;
}

/** Field reads across one query snapshot's documents. */
interface FieldTracker {
  names: Set<string>;
  numeric: boolean;
}

function newFields(): FieldTracker {
  return { names: new Set(), numeric: true };
}

function noteField(flags: UsageFlags, fields: FieldTracker, name: string | undefined, value: unknown): void {
  if (name === undefined) {
    // A read we cannot attribute to a field: never claim "one numeric field".
    fields.numeric = false;
  } else {
    if (fields.names.size < FIELD_CAP) fields.names.add(name);
    if (typeof value !== "number") fields.numeric = false;
  }
  flags.fields_read = fields.names.size;
  flags.fields_numeric = fields.names.size > 0 && fields.numeric;
}

/** Top-level segment of a `get()` field path; undefined for FieldPath objects. */
function topField(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("`")) return undefined;
  const dot = path.indexOf(".");
  return dot === -1 ? path : path.slice(0, dot);
}

/**
 * Turns the fresh object returned by `data()` into one that records which
 * fields are read. Accessors, not a Proxy: a Proxy breaks structuredClone and
 * postMessage. A write turns the accessor back into a plain data property.
 * Objects we cannot see into (class instances from converters, very wide
 * documents, frozen objects) mark the reads as unattributable instead.
 */
function watchData(data: unknown, flags: UsageFlags, fields: FieldTracker): void {
  if (!data || typeof data !== "object") return;
  try {
    const proto = Object.getPrototypeOf(data) as unknown;
    if ((proto !== Object.prototype && proto !== null) || !Object.isExtensible(data)) {
      noteField(flags, fields, undefined, undefined);
      return;
    }
    const keys = Object.keys(data);
    if (keys.length > DOC_FIELD_CAP) {
      noteField(flags, fields, undefined, undefined);
      return;
    }
    for (const key of keys) {
      const desc = Object.getOwnPropertyDescriptor(data, key);
      if (!desc || !("value" in desc) || !desc.configurable || !desc.writable) {
        noteField(flags, fields, undefined, undefined);
        continue;
      }
      const value: unknown = desc.value;
      Object.defineProperty(data, key, {
        configurable: true,
        enumerable: true,
        get() {
          noteField(flags, fields, key, value);
          return value;
        },
        set(this: object, next: unknown) {
          Object.defineProperty(this, key, { configurable: true, enumerable: true, writable: true, value: next });
        },
      });
    }
  } catch {
    // Never throw into the host. Reads from this document go unattributed.
    fields.numeric = false;
    flags.fields_numeric = false;
  }
}

function patchDoc(doc: unknown, index: number, flags: UsageFlags, seen: Set<number>, fields?: FieldTracker): void {
  if (!doc || typeof doc !== "object") return;
  const host = doc as Record<symbol, boolean>;
  if (host[DOC_PATCHED]) return;
  try {
    for (const name of ["data", "get"] as const) {
      const desc = findDescriptor(doc, name);
      if (!desc || typeof desc.value !== "function") continue;
      const fn = desc.value as (...args: unknown[]) => unknown;
      Object.defineProperty(doc, name, {
        configurable: true,
        enumerable: desc.enumerable ?? false,
        writable: true,
        value(this: unknown, ...args: unknown[]) {
          mark(flags, seen, index);
          const result = fn.apply(this, args);
          if (fields) {
            if (name === "data") watchData(result, flags, fields);
            else noteField(flags, fields, topField(args[0]), result);
          }
          return result;
        },
      });
    }
    host[DOC_PATCHED] = true;
  } catch {
    // One frozen document does not undo tracking on the snapshot.
  }
}

function trackList(list: unknown, flags: UsageFlags, seen: Set<number>, fields: FieldTracker): void {
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length && i < ITEM_CAP; i += 1) patchDoc(list[i], i, flags, seen, fields);
}

export function installUsage(snap: object): UsageFlags | undefined {
  const existing = (snap as Record<symbol, UsageFlags | undefined>)[INSTALLED];
  if (existing) return existing;
  const flags: UsageFlags = {
    read_items: false,
    read_size: false,
    read_empty: false,
    items_used: 0,
    fields_read: 0,
    fields_numeric: false,
  };
  const seen = new Set<number>();
  const fields = newFields();
  let readingEmpty = false;
  const added: string[] = [];
  try {
    const size = findDescriptor(snap, "size");
    if (size?.get) {
      const get = size.get;
      Object.defineProperty(snap, "size", {
        configurable: true,
        enumerable: size.enumerable ?? false,
        get() {
          if (!readingEmpty) flags.read_size = true;
          return get.call(this);
        },
      });
      added.push("size");
    }
    const empty = findDescriptor(snap, "empty");
    if (empty?.get) {
      const get = empty.get;
      Object.defineProperty(snap, "empty", {
        configurable: true,
        enumerable: empty.enumerable ?? false,
        get() {
          flags.read_empty = true;
          readingEmpty = true;
          try {
            return get.call(this);
          } finally {
            readingEmpty = false;
          }
        },
      });
      added.push("empty");
    }
    const docs = findDescriptor(snap, "docs");
    if (docs?.get) {
      const get = docs.get;
      Object.defineProperty(snap, "docs", {
        configurable: true,
        enumerable: docs.enumerable ?? false,
        get() {
          flags.read_items = true;
          const list = get.call(this);
          trackList(list, flags, seen, fields);
          return list;
        },
      });
      added.push("docs");
    }
    const forEach = findDescriptor(snap, "forEach");
    if (forEach && typeof forEach.value === "function") {
      const fn = forEach.value as (...args: unknown[]) => unknown;
      Object.defineProperty(snap, "forEach", {
        configurable: true,
        enumerable: forEach.enumerable ?? false,
        writable: true,
        value(this: unknown, callback: unknown, ...rest: unknown[]) {
          flags.read_items = true;
          if (typeof callback !== "function") return fn.apply(this, [callback, ...rest]);
          let index = 0;
          const wrapped = (doc: unknown, ...args: unknown[]) => {
            const at = index;
            index += 1;
            patchDoc(doc, at, flags, seen, fields);
            return (callback as (...a: unknown[]) => unknown)(doc, ...args);
          };
          return fn.apply(this, [wrapped, ...rest]);
        },
      });
      added.push("forEach");
    }
    const docChanges = findDescriptor(snap, "docChanges");
    if (docChanges) {
      if (docChanges.get) {
        const get = docChanges.get;
        Object.defineProperty(snap, "docChanges", {
          configurable: true,
          enumerable: docChanges.enumerable ?? false,
          get() {
            flags.read_items = true;
            return get.call(this);
          },
        });
        added.push("docChanges");
      } else if (typeof docChanges.value === "function") {
        const fn = docChanges.value as (...args: unknown[]) => unknown;
        Object.defineProperty(snap, "docChanges", {
          configurable: true,
          enumerable: docChanges.enumerable ?? false,
          writable: true,
          value(this: unknown, ...args: unknown[]) {
            flags.read_items = true;
            return fn.apply(this, args);
          },
        });
        added.push("docChanges");
      }
    }
    Object.defineProperty(snap, INSTALLED, { value: flags });
    return flags;
  } catch {
    for (const name of added) {
      try {
        delete (snap as Record<string, unknown>)[name];
      } catch {
        // A frozen snapshot cannot be restored. Usage tracking is skipped.
      }
    }
    return undefined;
  }
}

/**
 * Tracks a single-document snapshot. `data()`, `get()` and `exists()` count
 * as reading the item; `data()` and `get()` set `items_used` to 1.
 */
export function installDocumentUsage(snap: object): UsageFlags | undefined {
  const existing = (snap as Record<symbol, UsageFlags | undefined>)[INSTALLED];
  if (existing) return existing;
  const flags: UsageFlags = { read_items: false, read_size: false, read_empty: false, items_used: 0 };
  const added: string[] = [];
  try {
    for (const name of ["data", "get", "exists"] as const) {
      const desc = findDescriptor(snap, name);
      if (!desc) continue;
      const note = () => {
        flags.read_items = true;
        if (name !== "exists") flags.items_used = 1;
      };
      if (desc.get) {
        const get = desc.get;
        Object.defineProperty(snap, name, {
          configurable: true,
          enumerable: desc.enumerable ?? false,
          get() {
            note();
            return get.call(this);
          },
        });
        added.push(name);
      } else if (typeof desc.value === "function") {
        const fn = desc.value as (...args: unknown[]) => unknown;
        Object.defineProperty(snap, name, {
          configurable: true,
          enumerable: desc.enumerable ?? false,
          writable: true,
          value(this: unknown, ...args: unknown[]) {
            note();
            return fn.apply(this, args);
          },
        });
        added.push(name);
      }
    }
    Object.defineProperty(snap, INSTALLED, { value: flags });
    return flags;
  } catch {
    for (const name of added) {
      try {
        delete (snap as Record<string, unknown>)[name];
      } catch {
        // Frozen. Tracking is skipped.
      }
    }
    return undefined;
  }
}
