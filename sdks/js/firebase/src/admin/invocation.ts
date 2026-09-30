/**
 * One id per `withFlush` call. Auth `listUsers` copies it onto the raw
 * record; the core stores it as `ctx.transaction` for that operation only.
 * Firestore keeps its own transaction ids.
 *
 * A Firestore-triggered invocation also carries its trigger pattern here so
 * Firestore commits can count writes that match it. The pattern and the
 * paths stay in this process; only the count is recorded on the invoke.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { matchesTrigger, type TriggerPattern } from "./trigger.ts";

export interface InvocationState {
  readonly id: number;
  readonly trigger?: TriggerPattern;
  /** Committed writes whose path matched `trigger`. */
  triggerWrites: number;
}

const storage = new AsyncLocalStorage<InvocationState>();
let next = 0;

export function currentInvocation(): number | undefined {
  return storage.getStore()?.id;
}

/** The current invocation's state; `withFlush` reads the count after the handler. */
export function currentInvocationState(): InvocationState | undefined {
  return storage.getStore();
}

export function runInvocation<T>(fn: () => T, trigger?: TriggerPattern): T {
  next += 1;
  if (!Number.isSafeInteger(next) || next < 1) next = 1;
  const state: InvocationState = trigger ? { id: next, trigger, triggerWrites: 0 } : { id: next, triggerWrites: 0 };
  return storage.run(state, fn);
}

/** Counts committed document writes whose path matches the current trigger. */
export function noteDocumentWrites(paths: readonly string[]): void {
  const state = storage.getStore();
  if (!state?.trigger) return;
  for (const path of paths) {
    if (matchesTrigger(state.trigger, path)) state.triggerWrites += 1;
  }
}
