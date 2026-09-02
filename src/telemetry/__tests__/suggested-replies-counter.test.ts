// Unit tests for the suggested-replies telemetry counter. These cover the
// counter surface in isolation; integration with the renderer hook
// (push / dismiss / accept paths) lives in
// `src/ui/renderer/hooks/__tests__/use-suggested-replies.test.ts`.
import { describe, it, expect, beforeEach } from "vitest";
import {
  getSuggestedRepliesCounters,
  recordSuggestedRepliesEvent,
  resetSuggestedRepliesCountersForTesting,
} from "../suggested-replies-counter.js";

describe("suggested-replies-counter", () => {
  beforeEach(() => {
    resetSuggestedRepliesCountersForTesting();
  });

  it("starts every counter at 0", () => {
    expect(getSuggestedRepliesCounters()).toEqual({
      shown: 0,
      accepted: 0,
      dismissed: 0,
      ignored: 0,
    });
  });

  it("increments the requested event monotonically", () => {
    recordSuggestedRepliesEvent("shown");
    recordSuggestedRepliesEvent("shown");
    recordSuggestedRepliesEvent("dismissed");
    expect(getSuggestedRepliesCounters()).toEqual({
      shown: 2,
      accepted: 0,
      dismissed: 1,
      ignored: 0,
    });
  });

  it("returns a fresh snapshot — mutating the result does not leak", () => {
    recordSuggestedRepliesEvent("shown");
    const snap = getSuggestedRepliesCounters();
    snap.shown = 9999;
    expect(getSuggestedRepliesCounters().shown).toBe(1);
  });

  it("resetForTesting clears all counters", () => {
    recordSuggestedRepliesEvent("accepted");
    recordSuggestedRepliesEvent("accepted");
    resetSuggestedRepliesCountersForTesting();
    expect(getSuggestedRepliesCounters()).toEqual({
      shown: 0,
      accepted: 0,
      dismissed: 0,
      ignored: 0,
    });
  });
});
