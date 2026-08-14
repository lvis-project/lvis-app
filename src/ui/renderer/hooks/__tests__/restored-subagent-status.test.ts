import { describe, expect, it } from "vitest";
import { A2ATaskState } from "../../../../shared/a2a.js";
import { restoredSpawnStatusForTest } from "../use-workflow-tools.js";

/**
 * A restored row describes a run that is definitively over — the process that
 * produced it died with the app. These assertions pin the two properties that
 * make the panel honest about that: nothing restored ever claims to be running,
 * and nothing claims to have finished unless the child recorded that it did.
 */
describe("restoredSpawnStatus", () => {
  const row = (taskState?: string) => ({
    spawnId: "s1",
    childSessionId: "c1",
    title: "t",
    modifiedAt: "2026-08-14T00:00:00.000Z",
    ...(taskState ? { taskState } : {}),
  });

  it("maps a completed child to done", () => {
    expect(restoredSpawnStatusForTest(row(A2ATaskState.COMPLETED))).toBe("done");
  });

  it("maps failed and rejected to error", () => {
    expect(restoredSpawnStatusForTest(row(A2ATaskState.FAILED))).toBe("error");
    expect(restoredSpawnStatusForTest(row(A2ATaskState.REJECTED))).toBe("error");
  });

  it("maps a child that stopped on a question to waiting", () => {
    expect(restoredSpawnStatusForTest(row(A2ATaskState.INPUT_REQUIRED))).toBe("waiting");
  });

  it("reports a WORKING child as interrupted, not running", () => {
    // The record is accurate about the past and wrong about the present: the
    // run cannot be reattached, only resumed.
    expect(restoredSpawnStatusForTest(row(A2ATaskState.WORKING))).toBe("interrupted");
  });

  it("reports a SUBMITTED child as interrupted", () => {
    expect(restoredSpawnStatusForTest(row(A2ATaskState.SUBMITTED))).toBe("interrupted");
  });

  it("resolves a missing taskState pessimistically", () => {
    // Never recorded a projection ⇒ died before reaching one ⇒ at least as
    // unfinished as WORKING. `done` would be a claim the file cannot support.
    expect(restoredSpawnStatusForTest(row())).toBe("interrupted");
  });

  it("never returns running for any state", () => {
    // The panel sorts running rows to the top; a restored row that claimed to
    // be running would outrank a genuinely live sibling.
    const states = [
      undefined,
      A2ATaskState.SUBMITTED,
      A2ATaskState.WORKING,
      A2ATaskState.COMPLETED,
      A2ATaskState.FAILED,
      A2ATaskState.CANCELED,
      A2ATaskState.INPUT_REQUIRED,
      A2ATaskState.REJECTED,
    ];
    for (const state of states) {
      expect(restoredSpawnStatusForTest(row(state))).not.toBe("running");
    }
  });
});
