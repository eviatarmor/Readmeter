export interface UsageFlags {
  read_items: boolean;
  read_size: boolean;
  read_empty: boolean;
  /** Set when this snapshot's item reads are being tracked. */
  items_used?: number;
}

const DOC_PATCHED = Symbol.for("readmeter.doc");
const ITEM_CAP = 100_000;

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

function patchDoc(doc: unknown, index: number, flags: UsageFlags, seen: Set<number>): void {
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
          return fn.apply(this, args);
        },
      });
    }
    host[DOC_PATCHED] = true;
  } catch {
    // One frozen document does not undo tracking on the snapshot.
  }
}

function trackList(list: unknown, flags: UsageFlags, seen: Set<number>): void {
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length && i < ITEM_CAP; i += 1) patchDoc(list[i], i, flags, seen);
}

export function installUsage(snap: object): UsageFlags | undefined {
  const existing = (snap as Record<symbol, UsageFlags | undefined>)[INSTALLED];
  if (existing) return existing;
  const flags: UsageFlags = { read_items: false, read_size: false, read_empty: false, items_used: 0 };
  const seen = new Set<number>();
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
          trackList(list, flags, seen);
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
            patchDoc(doc, at, flags, seen);
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
