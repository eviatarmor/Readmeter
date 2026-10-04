// Token buckets for ingest rate limits. Process-local: a restart refills
// every bucket, and each ingest process limits on its own.

const DEFAULT_MAX_KEYS = 10_000;

export interface Rate {
  perMin: number;
  /** Bucket capacity: how many requests may arrive at once after a quiet period. */
  burst: number;
}

/**
 * Burst for a per-minute rate, at the same ratio as the default rate (100 per
 * 600/min out of the box, ten seconds of traffic):
 * `max(1, ceil(perMin * rateBurst / ratePerMin))`.
 */
export function burstFor(perMin: number, base: { ratePerMin: number; rateBurst: number }): number {
  return Math.max(1, Math.ceil((perMin * base.rateBurst) / base.ratePerMin));
}

/**
 * Buckets by key, at most `maxKeys` of them. The least recently used key is
 * evicted first; an evicted key starts again with a full bucket.
 */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    readonly perMin: number,
    readonly burst: number,
    private readonly maxKeys = DEFAULT_MAX_KEYS,
  ) {
    if (!(perMin > 0) || !(burst >= 1)) throw new Error("rate limit must be positive");
    if (!(maxKeys >= 1)) throw new Error("maxKeys must be at least 1");
  }

  get size(): number {
    return this.buckets.size;
  }

  /**
   * Consumes one token. Returns `null` when the call is allowed, or the
   * whole seconds until a token is available (at least 1) when it is not.
   * `rate` overrides the bucket's default rate for this key.
   */
  take(key: string, now = Date.now(), rate?: Rate): number | null {
    const perMin = rate?.perMin ?? this.perMin;
    const burst = rate?.burst ?? this.burst;
    const perMs = perMin / 60_000;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { tokens: burst, updatedAt: now };
    } else {
      // Re-inserting moves the key to the end: Map order is the LRU order.
      this.buckets.delete(key);
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(burst, bucket.tokens + elapsed * perMs);
      bucket.updatedAt = now;
    }
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return null;
    }
    const waitMs = (1 - bucket.tokens) / perMs;
    return Math.max(1, Math.ceil(waitMs / 1000));
  }
}
