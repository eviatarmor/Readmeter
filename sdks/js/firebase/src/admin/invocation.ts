/**
 * One id per `withFlush` call. Auth `listUsers` copies it onto the raw
 * record; the core stores it as `ctx.transaction` for that operation only.
 * Firestore keeps its own transaction ids.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<number>();
let next = 0;

export function currentInvocation(): number | undefined {
  return storage.getStore();
}

export function runInvocation<T>(fn: () => T): T {
  next += 1;
  if (!Number.isSafeInteger(next) || next < 1) next = 1;
  return storage.run(next, fn);
}
