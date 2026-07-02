/**
 * C1 gap-lock — triggerConversation gate: evaluateTriggerSpec deny-branches
 * plus the RateLimiter / Dedupe / DenyThrottle helper classes.
 *
 * `trigger-conversation-capability.test.ts` already covers the ALLOW and
 * `capability_denied` outcomes of `evaluateTriggerSpec`. This file locks the
 * remaining deny branches (invalid source, empty prompt, rate-limited,
 * duplicate), the allow-path bookkeeping side effects, and the gating
 * behavior of the three exported helper classes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateTriggerSpec,
  TriggerConversationDedupe,
  TriggerConversationRateLimiter,
  TriggerDenyAuditThrottle,
  TRIGGER_CONVERSATION_DEDUPE_TTL_MS,
} from "../plugin-runtime.js";

const NOW = Date.parse("2026-05-10T00:00:00.000Z");
const OVERLAY_CAPS = ["host:overlay"];

interface EvalOverrides {
  spec?: unknown;
  capabilities?: string[];
  dedupe?: TriggerConversationDedupe;
  rateLimiter?: TriggerConversationRateLimiter;
}

function evaluate(overrides: EvalOverrides = {}) {
  return evaluateTriggerSpec({
    spec: (overrides.spec ?? { source: "overlay:test", prompt: "검토가 필요합니다." }) as never,
    pluginId: "plugin-a",
    capabilities: overrides.capabilities ?? OVERLAY_CAPS,
    dedupe: overrides.dedupe ?? new TriggerConversationDedupe(),
    rateLimiter: overrides.rateLimiter ?? new TriggerConversationRateLimiter(),
    auditLogger: { log: vi.fn() },
    now: () => NOW,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("evaluateTriggerSpec deny branches", () => {
  it("denies a source that does not match the overlay-trigger pattern", () => {
    const outcome = evaluate({ spec: { source: "plugin:bad", prompt: "hi" } });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind !== "deny") throw new Error("unreachable");
    expect(outcome.result.reason).toBe("invalid_source");
    expect(outcome.result.source).toContain("plugin:bad");
  });

  it("denies an empty prompt with a valid source", () => {
    const outcome = evaluate({ spec: { source: "overlay:test", prompt: "   " } });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind !== "deny") throw new Error("unreachable");
    expect(outcome.result.reason).toBe("invalid_source");
  });

  it("denies when the rate limiter is already over cap", () => {
    const rateLimiter = new TriggerConversationRateLimiter(60_000, 1);
    rateLimiter.record("plugin-a", NOW);
    const outcome = evaluate({ rateLimiter });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind !== "deny") throw new Error("unreachable");
    expect(outcome.result.reason).toBe("rate_limited");
  });

  it("denies a duplicate dedupeKey already recorded", () => {
    const dedupe = new TriggerConversationDedupe();
    dedupe.record("plugin-a", "obs-1");
    const outcome = evaluate({
      spec: { source: "overlay:test", prompt: "hi", dedupeKey: "obs-1" },
      dedupe,
    });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind !== "deny") throw new Error("unreachable");
    expect(outcome.result.reason).toBe("duplicate");
  });
});

describe("evaluateTriggerSpec allow path bookkeeping", () => {
  it("accepts a valid spec and records both the dedupe key and the rate window", () => {
    const dedupe = new TriggerConversationDedupe();
    const rateLimiter = new TriggerConversationRateLimiter(60_000, 1);
    const outcome = evaluate({
      spec: { source: "overlay:test", prompt: "검토가 필요합니다.", dedupeKey: "obs-42" },
      dedupe,
      rateLimiter,
    });

    expect(outcome.kind).toBe("allow");
    if (outcome.kind !== "allow") throw new Error("unreachable");
    expect(outcome.result.accepted).toBe(true);
    expect(outcome.source).toBe("overlay:test");
    // Side effects: dedupe + rate window advanced before returning.
    expect(dedupe.has("plugin-a", "obs-42")).toBe(true);
    expect(rateLimiter.isOverCap("plugin-a", NOW)).toBe(true);
  });
});

describe("TriggerConversationRateLimiter", () => {
  it("allows up to maxCalls in a window, then reports over-cap; the window slides", () => {
    const rl = new TriggerConversationRateLimiter(1_000, 2);
    expect(rl.isOverCap("p", 0)).toBe(false);
    rl.record("p", 0);
    expect(rl.isOverCap("p", 0)).toBe(false);
    rl.record("p", 0);
    expect(rl.isOverCap("p", 0)).toBe(true);
    // Past the window the earlier calls expire → capacity returns.
    expect(rl.isOverCap("p", 1_001)).toBe(false);
  });
});

describe("TriggerConversationDedupe", () => {
  it("has() is false for an unseen key and true after record()", () => {
    const d = new TriggerConversationDedupe();
    expect(d.has("p", "k")).toBe(false);
    d.record("p", "k");
    expect(d.has("p", "k")).toBe(true);
  });

  it("expires a recorded key after the TTL", () => {
    const t0 = 5_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    const d = new TriggerConversationDedupe();
    d.record("p", "k");
    expect(d.has("p", "k")).toBe(true);
    nowSpy.mockReturnValue(t0 + TRIGGER_CONVERSATION_DEDUPE_TTL_MS + 1);
    expect(d.has("p", "k")).toBe(false);
  });
});

describe("TriggerDenyAuditThrottle", () => {
  it("emits the first denial, suppresses within-window repeats, and drains the suppressed count", () => {
    const throttle = new TriggerDenyAuditThrottle(60_000);
    expect(throttle.shouldEmit("p", "reason", 0)).toBe(true);
    expect(throttle.shouldEmit("p", "reason", 10)).toBe(false);
    expect(throttle.shouldEmit("p", "reason", 20)).toBe(false);
    expect(throttle.drainSuppressed("p", "reason")).toBe(2);
    // After draining, the counter resets.
    expect(throttle.drainSuppressed("p", "reason")).toBe(0);
    // Once the window elapses, the next denial emits again.
    expect(throttle.shouldEmit("p", "reason", 60_001)).toBe(true);
  });

  it("tracks (pluginId, reason) pairs independently", () => {
    const throttle = new TriggerDenyAuditThrottle(60_000);
    expect(throttle.shouldEmit("p", "reason-a", 0)).toBe(true);
    expect(throttle.shouldEmit("p", "reason-b", 0)).toBe(true);
    expect(throttle.shouldEmit("p", "reason-a", 0)).toBe(false);
  });
});
