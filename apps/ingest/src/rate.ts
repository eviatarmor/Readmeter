// Per-API-key token bucket. Process-local: a restart refills every key,
// which is what we want for a single ingest process.

const MAX_KEYS = 10_000;

export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly perMs: number;

  constructor(
    readonly perMin: number,
    readonly burst: number,
  ) {
    if (!(perMin > 0) || !(burst >= 1)) throw new Error("rate limit must be positive");
    this.perMs = perMin / 60_000;
  }

  /**
   * Consumes one token. Returns `null` when the call is allowed, or the
   * whole seconds until a token is available (at least 1) when it is not.
   */
  take(key: string, now = Date.now()): number | null {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= MAX_KEYS) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { tokens: this.burst, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.perMs);
      bucket.updatedAt = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return null;
    }
    const waitMs = (1 - bucket.tokens) / this.perMs;
    return Math.max(1, Math.ceil(waitMs / 1000));
  }
}
