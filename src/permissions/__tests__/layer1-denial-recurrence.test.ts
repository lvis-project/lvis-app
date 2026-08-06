/**
 * Recurring Layer-1 denial counter — identity, threshold, and the once-only
 * escalation rule.
 *
 * Every assertion here is about a decision the tracker alone makes. The wiring
 * that turns `escalate: true` into an actual user prompt is covered end-to-end
 * in `src/tools/__tests__/executor-layer1-denial-escalation.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  LAYER1_DENIAL_ESCALATION_THRESHOLD,
  LAYER1_DENIAL_MAX_ESCALATIONS_PER_SCOPE,
  LAYER1_DENIAL_TRACKED_IDENTITY_LIMIT,
  Layer1DenialRecurrenceTracker,
  type Layer1DenialIdentity,
  type Layer1DenialRecord,
} from "../layer1-denial-recurrence.js";

const BASE: Layer1DenialIdentity = {
  sessionId: "sess-1",
  grantSubject: "plugin-a",
  canonicalPath: "/home/ken/notes/todo.md",
};

/** Record `times` denials for one identity and return every answer in order. */
function denyRepeatedly(
  tracker: Layer1DenialRecurrenceTracker,
  identity: Layer1DenialIdentity,
  times: number,
): Layer1DenialRecord[] {
  return Array.from({ length: times }, () => tracker.recordDenial(identity));
}

/** The escalation answers only, so a test can state exactly when it fired. */
function escalationFlags(records: readonly Layer1DenialRecord[]): boolean[] {
  return records.map((record) => record.tracked && record.escalate);
}

describe("Layer1DenialRecurrenceTracker — threshold", () => {
  it("asks on the third denial, which is the owner's decision", () => {
    // Every other test here is written against the constant so it stays true
    // if the policy changes. This one pins the policy itself: the owner chose
    // "show the error three times, then ask", and a silent edit to that number
    // is a change to the decision, not a refactor.
    expect(LAYER1_DENIAL_ESCALATION_THRESHOLD).toBe(3);
  });

  it("does not escalate before the threshold, and escalates exactly on it", () => {
    const tracker = new Layer1DenialRecurrenceTracker();

    const records = denyRepeatedly(
      tracker,
      BASE,
      LAYER1_DENIAL_ESCALATION_THRESHOLD,
    );

    // Every denial below the threshold is an ordinary deny...
    const beforeThreshold = records.slice(0, -1);
    expect(beforeThreshold.length).toBe(LAYER1_DENIAL_ESCALATION_THRESHOLD - 1);
    expect(escalationFlags(beforeThreshold)).toEqual(
      beforeThreshold.map(() => false),
    );

    // ...and the threshold denial is the one that asks.
    const atThreshold = records[records.length - 1];
    expect(atThreshold).toEqual({
      tracked: true,
      count: LAYER1_DENIAL_ESCALATION_THRESHOLD,
      escalate: true,
    });
  });

  it("counts every denial it tracks, so the user-facing count is the real one", () => {
    const tracker = new Layer1DenialRecurrenceTracker();

    const counts = denyRepeatedly(tracker, BASE, 5).map((record) =>
      record.tracked ? record.count : -1,
    );

    expect(counts).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("Layer1DenialRecurrenceTracker — identity cannot be farmed", () => {
  it("does not accumulate denials across different grant subjects", () => {
    const tracker = new Layer1DenialRecurrenceTracker();

    // Threshold-1 denials from one plugin, then one from another. Together they
    // reach the threshold in raw count, and must still not escalate.
    denyRepeatedly(
      tracker,
      { ...BASE, grantSubject: "plugin-a" },
      LAYER1_DENIAL_ESCALATION_THRESHOLD - 1,
    );
    const other = tracker.recordDenial({ ...BASE, grantSubject: "plugin-b" });

    expect(other).toEqual({ tracked: true, count: 1, escalate: false });
  });

  it("does not accumulate denials across different refused paths", () => {
    const tracker = new Layer1DenialRecurrenceTracker();

    denyRepeatedly(
      tracker,
      { ...BASE, canonicalPath: "/home/ken/notes/todo.md" },
      LAYER1_DENIAL_ESCALATION_THRESHOLD - 1,
    );
    const sibling = tracker.recordDenial({
      ...BASE,
      // Same parent directory on purpose: the counter keys on the refused path,
      // not on the directory the escalation would offer to add, so three
      // different files under one root must not buy an ask for that root.
      canonicalPath: "/home/ken/notes/other.md",
    });

    expect(sibling).toEqual({ tracked: true, count: 1, escalate: false });
  });

  it("does not accumulate denials across different session scopes", () => {
    const tracker = new Layer1DenialRecurrenceTracker();

    denyRepeatedly(
      tracker,
      { ...BASE, sessionId: "sess-1" },
      LAYER1_DENIAL_ESCALATION_THRESHOLD - 1,
    );
    const elsewhere = tracker.recordDenial({ ...BASE, sessionId: "sess-2" });

    expect(elsewhere).toEqual({ tracked: true, count: 1, escalate: false });
  });

  it("keeps separate identities counting independently up to their own escalation", () => {
    const tracker = new Layer1DenialRecurrenceTracker();
    const a = { ...BASE, grantSubject: "plugin-a" };
    const b = { ...BASE, grantSubject: "plugin-b" };

    // Interleaved, so a shared counter would escalate early for whichever
    // identity happened to cross the threshold on the combined total.
    const flags: boolean[] = [];
    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD; i += 1) {
      const recordA = tracker.recordDenial(a);
      const recordB = tracker.recordDenial(b);
      flags.push(recordA.tracked && recordA.escalate);
      flags.push(recordB.tracked && recordB.escalate);
    }

    // Only the final pair escalates: each identity reached its own threshold.
    const expected = flags.map(
      (_, index) => index >= flags.length - 2,
    );
    expect(flags).toEqual(expected);
  });
});

describe("Layer1DenialRecurrenceTracker — one ask per identity", () => {
  it("escalates once and never again for the same identity", () => {
    const tracker = new Layer1DenialRecurrenceTracker();

    const records = denyRepeatedly(
      tracker,
      BASE,
      LAYER1_DENIAL_ESCALATION_THRESHOLD * 3,
    );
    const escalations = escalationFlags(records).filter(Boolean);

    expect(escalations).toEqual([true]);
  });

  it("keeps counting after the single escalation without asking again", () => {
    const tracker = new Layer1DenialRecurrenceTracker();

    denyRepeatedly(tracker, BASE, LAYER1_DENIAL_ESCALATION_THRESHOLD);
    const after = tracker.recordDenial(BASE);

    expect(after).toEqual({
      tracked: true,
      count: LAYER1_DENIAL_ESCALATION_THRESHOLD + 1,
      escalate: false,
    });
  });
});

describe("Layer1DenialRecurrenceTracker — per-scope escalation budget", () => {
  /** Drive one fresh identity all the way to its escalation attempt. */
  function escalateFreshIdentity(
    tracker: Layer1DenialRecurrenceTracker,
    sessionId: string,
    tag: string,
  ): boolean {
    const records = denyRepeatedly(
      tracker,
      { ...BASE, sessionId, canonicalPath: `/home/ken/notes/${tag}.md` },
      LAYER1_DENIAL_ESCALATION_THRESHOLD,
    );
    return escalationFlags(records).some(Boolean);
  }

  it("stops asking once a scope has spent its budget, however many new paths appear", () => {
    const tracker = new Layer1DenialRecurrenceTracker();

    // Each round is a brand-new identity, so the per-identity rule alone would
    // let every one of them raise its own modal.
    const raised = Array.from(
      { length: LAYER1_DENIAL_MAX_ESCALATIONS_PER_SCOPE + 4 },
      (_unused, index) => escalateFreshIdentity(tracker, "sess-1", `path-${index}`),
    );

    expect(raised.filter(Boolean).length).toBe(
      LAYER1_DENIAL_MAX_ESCALATIONS_PER_SCOPE,
    );
    // And the ones past the budget are the later ones, not an arbitrary subset.
    expect(raised.slice(LAYER1_DENIAL_MAX_ESCALATIONS_PER_SCOPE)).toEqual(
      raised.slice(LAYER1_DENIAL_MAX_ESCALATIONS_PER_SCOPE).map(() => false),
    );
  });

  it("does not let one scope spend another scope's budget", () => {
    const tracker = new Layer1DenialRecurrenceTracker();
    for (let i = 0; i < LAYER1_DENIAL_MAX_ESCALATIONS_PER_SCOPE + 2; i += 1) {
      escalateFreshIdentity(tracker, "sess-noisy", `noisy-${i}`);
    }

    // A different lane has touched nothing and must still get its first ask.
    expect(escalateFreshIdentity(tracker, "sess-quiet", "quiet-0")).toBe(true);
  });

  it("keeps denying normally after the budget is spent", () => {
    const tracker = new Layer1DenialRecurrenceTracker();
    for (let i = 0; i < LAYER1_DENIAL_MAX_ESCALATIONS_PER_SCOPE; i += 1) {
      escalateFreshIdentity(tracker, "sess-1", `spent-${i}`);
    }

    const beyond = denyRepeatedly(
      tracker,
      { ...BASE, sessionId: "sess-1", canonicalPath: "/home/ken/notes/after.md" },
      LAYER1_DENIAL_ESCALATION_THRESHOLD + 2,
    );

    // Still counted, still tracked — just never escalated again.
    expect(escalationFlags(beyond)).toEqual(beyond.map(() => false));
    expect(beyond.every((record) => record.tracked === true)).toBe(true);
  });
});

describe("Layer1DenialRecurrenceTracker — untrackable identities never escalate", () => {
  const unusable: ReadonlyArray<readonly [string, Layer1DenialIdentity]> = [
    ["no conversation", { ...BASE, sessionId: undefined }],
    ["empty conversation id", { ...BASE, sessionId: "" }],
    ["no grant subject", { ...BASE, grantSubject: undefined }],
    ["empty grant subject", { ...BASE, grantSubject: "" }],
    ["empty path", { ...BASE, canonicalPath: "" }],
  ];

  it.each(unusable)(
    "never escalates with %s, however many times it recurs",
    (_label, identity) => {
      const tracker = new Layer1DenialRecurrenceTracker();

      const records = denyRepeatedly(
        tracker,
        identity,
        LAYER1_DENIAL_ESCALATION_THRESHOLD * 4,
      );

      expect(records.every((record) => record.tracked === false)).toBe(true);
    },
  );

  it("still escalates a usable identity while unusable ones are being recorded", () => {
    const tracker = new Layer1DenialRecurrenceTracker();

    const flags: boolean[] = [];
    for (let i = 0; i < LAYER1_DENIAL_ESCALATION_THRESHOLD; i += 1) {
      tracker.recordDenial({ ...BASE, grantSubject: undefined });
      const record = tracker.recordDenial(BASE);
      flags.push(record.tracked && record.escalate);
    }

    expect(flags.filter(Boolean)).toEqual([true]);
  });
});

describe("Layer1DenialRecurrenceTracker — identity ceiling", () => {
  it("stops tracking new identities at the ceiling, so a flood buys fewer asks", () => {
    const tracker = new Layer1DenialRecurrenceTracker();
    for (let i = 0; i < LAYER1_DENIAL_TRACKED_IDENTITY_LIMIT; i += 1) {
      tracker.recordDenial({ ...BASE, canonicalPath: `/flood/${i}` });
    }

    const overflow = denyRepeatedly(
      tracker,
      { ...BASE, canonicalPath: "/flood/overflow" },
      LAYER1_DENIAL_ESCALATION_THRESHOLD,
    );

    expect(overflow.every((record) => record.tracked === false)).toBe(true);
  });

  it("keeps serving identities that were already tracked when the ceiling was hit", () => {
    const tracker = new Layer1DenialRecurrenceTracker();
    // Established first, so it holds a slot before the flood fills the rest.
    tracker.recordDenial(BASE);
    for (let i = 0; i < LAYER1_DENIAL_TRACKED_IDENTITY_LIMIT; i += 1) {
      tracker.recordDenial({ ...BASE, canonicalPath: `/flood/${i}` });
    }

    const rest = denyRepeatedly(
      tracker,
      BASE,
      LAYER1_DENIAL_ESCALATION_THRESHOLD - 1,
    );

    expect(escalationFlags(rest)).toEqual([
      ...rest.slice(0, -1).map(() => false),
      true,
    ]);
  });
});
