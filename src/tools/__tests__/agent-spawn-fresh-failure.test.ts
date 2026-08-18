/**
 * A fresh spawn that dies must leave the parent something to act on.
 *
 * Reported behaviour: when a sub-agent stopped with an error, the parent did
 * not continue it — it spawned a NEW sub-agent to do the same work. The result
 * for a failed fresh spawn carried only an error string, so "spawn it again"
 * was the only move left, and each attempt discarded whatever the dead child
 * had established.
 *
 * The failed RESUME path had already been fixed for exactly this
 * (`resumeRanGuidance`, and the comment above it describing respawn-loses-
 * context). The failed FRESH spawn was the same failure arriving through the
 * other door.
 *
 * The fix deliberately does NOT advertise a resumeId. Resume is built on
 * SUSPENSION — `resumeWithPolicy` requires the parked state, the suspension
 * reason, and the resume counters — and a run that died never parked, so there
 * is no point to resume from. `isResumableSubAgentTaskState` documents what
 * happens when an id is offered that the gate then refuses: the retry guidance
 * turns it into a guided infinite loop. These tests pin that we did not
 * recreate it.
 */
import { describe, expect, it } from "vitest";

import { en } from "../../i18n/messages/generated/be_agentSpawn.js";

describe("failed fresh spawn guidance", () => {
  const failed = en["be_agentSpawn.freshSpawnFailedGuidance"];
  const rejected = en["be_agentSpawn.freshSpawnRejectedGuidance"];

  it("states plainly that the child cannot be resumed", () => {
    // The parent must not go looking for a resumeId that will be refused.
    expect(failed).toMatch(/CANNOT be resumed/i);
    expect(rejected).toMatch(/cannot be resumed/i);
  });

  it("explains WHY there is nothing to resume", () => {
    // "never suspended" is the load-bearing fact: it is why no resumeId exists,
    // not an arbitrary policy the model might try to argue around.
    expect(failed).toMatch(/never suspended|no point to continue/i);
  });

  it("tells the parent not to immediately respawn the same task", () => {
    // The exact reported behaviour this exists to stop.
    expect(failed).toMatch(/not.{0,30}spawn the same task again/i);
  });

  it("does not promise a retry will work for a provider rejection", () => {
    // A deterministic refusal repeats identically; inviting a retry here is how
    // the older single-text version produced loops.
    expect(rejected).toMatch(/every time|cannot succeed/i);
    expect(rejected).toMatch(/change the request/i);
  });

  it("keeps a transient failure retryable exactly once, not blindly", () => {
    expect(failed).toMatch(/transient/i);
    expect(failed).toMatch(/one retry/i);
  });

  it("names concrete next moves rather than only forbidding things", () => {
    // Guidance that only says "don't" leaves the model with no move and it
    // reverts to respawning.
    for (const text of [failed, rejected]) {
      expect(text).toMatch(/sourceTools/);
    }
    expect(failed).toMatch(/narrow the task|do the work yourself/i);
  });

  it("tells the parent to surface the loss to the user", () => {
    // A silently swallowed dead agent is how a partial result gets reported as
    // if it were complete.
    expect(failed).toMatch(/tell the user/i);
    expect(rejected).toMatch(/Tell the user/i);
  });
});
