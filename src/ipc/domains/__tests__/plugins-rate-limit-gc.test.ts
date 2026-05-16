/**
 * NEW-2 MEDIUM — rate-limit Map lazy GC whitebox test.
 *
 * The `checkSetApiKeyRateLimit` function lives inside the
 * `registerPluginsHandlers` closure and is not exported. This test verifies
 * the GC algorithm contract by replicating the exact same logic, proving:
 *   - Map stays bounded after > 64 unique serverIds with expired windows
 *   - Map is NOT pruned when size ≤ 64 (no unnecessary iteration)
 *   - Active (non-expired) entries are preserved during GC
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// ── Mirror of the production constants in plugins.ts ──────────────────────
const SET_API_KEY_MAX_CALLS = 5;
const SET_API_KEY_WINDOW_MS = 60_000;
const GC_THRESHOLD = 64;

// ── Mirror of the production rate-limit function ──────────────────────────
function makeRateLimiter() {
  const bucket = new Map<string, { count: number; windowStart: number }>();

  function check(serverId: string): boolean {
    const now = Date.now();
    if (bucket.size > GC_THRESHOLD) {
      for (const [k, b] of bucket) {
        if (now - b.windowStart >= SET_API_KEY_WINDOW_MS) {
          bucket.delete(k);
        }
      }
    }
    const entry = bucket.get(serverId);
    if (!entry || now - entry.windowStart >= SET_API_KEY_WINDOW_MS) {
      bucket.set(serverId, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= SET_API_KEY_MAX_CALLS) return false;
    entry.count += 1;
    return true;
  }

  return { bucket, check };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("checkSetApiKeyRateLimit — lazy GC (NEW-2 MEDIUM)", () => {
  it("GC evicts expired entries when Map exceeds 64 entries", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const { bucket, check } = makeRateLimiter();

    // Fill 65 unique server IDs — all windows start at t0
    for (let i = 0; i < 65; i++) {
      check(`server-${i}`);
    }
    expect(bucket.size).toBe(65);

    // Advance clock past the window so all 65 entries are expired
    vi.advanceTimersByTime(SET_API_KEY_WINDOW_MS + 1);

    // One more call (new server-66) triggers GC because size > 64
    check("server-66");

    // GC should have evicted all 65 expired entries; only server-66 remains
    expect(bucket.size).toBe(1);
    expect(bucket.has("server-66")).toBe(true);
  });

  it("does NOT GC when Map size is exactly 64 (threshold is >64)", () => {
    vi.useFakeTimers();
    const { bucket, check } = makeRateLimiter();

    // Fill exactly 64 entries
    for (let i = 0; i < 64; i++) {
      check(`server-${i}`);
    }
    expect(bucket.size).toBe(64);

    // Advance clock past the window — entries are expired but GC won't fire
    vi.advanceTimersByTime(SET_API_KEY_WINDOW_MS + 1);

    // Call with the 64th server again — size is still 64, no GC triggered
    // (expired entry gets replaced with fresh window)
    check("server-0");
    // Only server-0 gets a fresh window; others remain (expired but not evicted)
    expect(bucket.size).toBe(64);
  });

  it("preserves active (non-expired) entries during GC", () => {
    vi.useFakeTimers();
    const { bucket, check } = makeRateLimiter();

    // Fill 65 entries
    for (let i = 0; i < 65; i++) {
      check(`server-${i}`);
    }

    // Advance only halfway — entries are still active
    vi.advanceTimersByTime(SET_API_KEY_WINDOW_MS / 2);

    // Add a fresh entry for server-99 to bring size to 66 — this one is fresh
    check("server-99");
    expect(bucket.size).toBe(66);

    // Advance past the window for the original 65 — they expire, server-99 is still active
    vi.advanceTimersByTime(SET_API_KEY_WINDOW_MS / 2 + 1);

    // Trigger GC with another call (size > 64)
    check("server-trigger");

    // Original 65 expired, server-99 still active — should be preserved
    expect(bucket.has("server-99")).toBe(true);
    // server-trigger also gets added fresh
    expect(bucket.has("server-trigger")).toBe(true);
    // The 65 expired entries should be gone
    expect(bucket.size).toBeLessThan(10);
  });

  it("rate-limits at SET_API_KEY_MAX_CALLS within the window", () => {
    vi.useFakeTimers();
    const { check } = makeRateLimiter();
    const serverId = "test-server";

    for (let i = 0; i < SET_API_KEY_MAX_CALLS; i++) {
      expect(check(serverId)).toBe(true);
    }
    expect(check(serverId)).toBe(false);
  });

  it("resets after window expires", () => {
    vi.useFakeTimers();
    const { check } = makeRateLimiter();
    const serverId = "test-server";

    for (let i = 0; i < SET_API_KEY_MAX_CALLS; i++) check(serverId);
    expect(check(serverId)).toBe(false);

    vi.advanceTimersByTime(SET_API_KEY_WINDOW_MS + 1);
    expect(check(serverId)).toBe(true);
  });
});
