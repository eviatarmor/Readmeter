const pending = new Set<() => void>();

/**
 * Runs `record` 1s after the call, or at the next flush, whichever is first.
 * The timer does not keep Node alive.
 */
export function scheduleUsage(record: () => void): void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pending.delete(run);
    record();
  };
  const timer = setTimeout(run, 1000);
  (timer as { unref?: () => void }).unref?.();
  pending.add(run);
}

/** Records every scheduled usage call that has not fired yet. */
export function flushPendingUsage(): void {
  for (const run of [...pending]) run();
}
