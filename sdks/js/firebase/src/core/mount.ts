/**
 * UI component mount ids (`@readmeter/react`). A mount id names one component
 * instance for the life of the page. Calls made synchronously inside
 * `runInMount` carry it as the raw call's `mount` field, which lets rules tell
 * one instance re-running an effect (React StrictMode) from two instances.
 *
 * Ids are a per-page counter, like listener and call ids. They are never
 * reset: a component mounted before a re-`init` keeps a unique id.
 */

let current: number | undefined;
let counter = 0;

function isMountId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A new mount id. Positive safe integer, unique for this page. */
export function newMountId(): number {
  counter += 1;
  return counter;
}

/** The mount id of the innermost `runInMount` on the stack, if any. */
export function currentMount(): number | undefined {
  return current;
}

/**
 * Runs `fn` with `mount` as the current mount id and returns its result.
 * Only synchronous work is tagged; the previous id is restored when `fn`
 * returns or throws. An invalid id runs `fn` untagged. Errors from `fn` are
 * the caller's and propagate unchanged.
 */
export function runInMount<T>(mount: number, fn: () => T): T {
  if (typeof fn !== "function") return undefined as T;
  if (!isMountId(mount)) return fn();
  const previous = current;
  current = mount;
  try {
    return fn();
  } finally {
    current = previous;
  }
}
