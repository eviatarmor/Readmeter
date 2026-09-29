export interface UsageFlags {
  read_items: boolean;
  read_size: boolean;
  read_empty: boolean;
}

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
export function installUsage(snap: object): UsageFlags | undefined {
  const existing = (snap as Record<symbol, UsageFlags | undefined>)[INSTALLED];
  if (existing) return existing;
  const flags: UsageFlags = { read_items: false, read_size: false, read_empty: false };
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
    for (const name of ["docs", "forEach", "docChanges"] as const) {
      const desc = findDescriptor(snap, name);
      if (!desc) continue;
      if (desc.get) {
        const get = desc.get;
        Object.defineProperty(snap, name, {
          configurable: true,
          enumerable: desc.enumerable ?? false,
          get() {
            flags.read_items = true;
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
            flags.read_items = true;
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
        // A frozen snapshot cannot be restored. Usage tracking is skipped.
      }
    }
    return undefined;
  }
}
