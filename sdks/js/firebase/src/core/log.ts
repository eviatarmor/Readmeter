let lastDebugAt = 0;

/** One `console.debug` per second while `debug` is on. Silent otherwise. */
export function debugOnce(enabled: boolean, error: unknown): void {
  if (!enabled) return;
  const now = Date.now();
  if (now - lastDebugAt < 1000) return;
  lastDebugAt = now;
  const text = error instanceof Error ? error.message : String(error);
  console.debug("[readmeter]", text);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
