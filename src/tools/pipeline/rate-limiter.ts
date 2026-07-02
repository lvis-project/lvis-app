/**
 * Tool pipeline — trust-based token-bucket rate limiter (tool-governance.md §9).
 *
 * Extracted from `executor.ts` (C7 decomposition). The executor owns a single
 * {@link RateLimiter} instance (`ToolExecutor.rateLimiter`) consumed at Step 5.
 * Behavior is locked by `src/tools/__tests__/executor-rate-limiter.test.ts` (C1).
 */
import type { TrustLevel } from "../types.js";

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  /** Trust별 분당 제한: high=무제한, medium=60, low=20 */
  private static LIMITS: Record<TrustLevel, number> = { high: Infinity, medium: 60, low: 20 };
  private readonly buckets = new Map<string, RateBucket>();

  check(toolName: string, trust: TrustLevel): { allowed: boolean; remaining: number } {
    const limit = RateLimiter.LIMITS[trust];
    if (limit === Infinity) return { allowed: true, remaining: Infinity };

    const key = `${trust}:${toolName}`;
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: limit, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // 토큰 리필 (1분당 limit 토큰)
    const elapsed = (now - bucket.lastRefill) / 60_000;
    bucket.tokens = Math.min(limit, bucket.tokens + elapsed * limit);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      return { allowed: false, remaining: 0 };
    }
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  }
}
