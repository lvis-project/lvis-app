import { describe, expect, it } from "vitest";
import { PluginOperationGrantCoordinator } from "../plugin-operation-grant.js";

const principal = {
  ownerPluginId: "ep-api",
  ownerVersion: "1.2.3",
  generationId: "gen-1",
  appSessionId: "window-7",
  accountHash: "acct-hash",
};

describe("PluginOperationGrantCoordinator", () => {
  it("records opaque read revisions and consumes a matching grant exactly once", () => {
    let now = 1_000;
    const coordinator = new PluginOperationGrantCoordinator(() => now);
    const readRevision = coordinator.recordRead(
      { ...principal, readTool: "ep_attendance_read", readOperation: "today" },
      { private: "not stored in the binding" },
    );
    expect(coordinator.latestRequiredRead(principal, "ep_attendance_read", ["today"], 1_000)).toBe(readRevision);
    const grant = coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "intent",
      readRevision,
      expiresAt: now + 500,
    });
    const expected = {
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "intent",
      readRevision,
    };
    expect(coordinator.consume(grant.token, expected)).toEqual({ ok: true, grantId: grant.grantId });
    expect(coordinator.consume(grant.token, expected)).toMatchObject({ ok: false, reason: expect.stringContaining("already consumed") });
    now += 2_000;
    expect(coordinator.latestRequiredRead(principal, "ep_attendance_read", ["today"], 1_000)).toBeUndefined();
  });

  it("burns before comparison so a mismatch cannot be retried", () => {
    const coordinator = new PluginOperationGrantCoordinator(() => 10);
    const grant = coordinator.issue({
      ...principal,
      toolName: "ep_parking_write",
      operation: "apply",
      intentHash: "one",
      readRevision: "r1",
      expiresAt: 100,
    });
    const expected = {
      ...principal,
      toolName: "ep_parking_write",
      operation: "apply",
      intentHash: "one",
      readRevision: "r1",
    };
    expect(coordinator.consume(grant.token, { ...expected, accountHash: "forged" })).toMatchObject({ ok: false, reason: "operation grant accountHash mismatch" });
    expect(coordinator.consume(grant.token, expected)).toMatchObject({ ok: false });
  });

  it("fails closed for missing, forged, expired, generation-revoked and session-revoked grants", () => {
    let now = 50;
    const coordinator = new PluginOperationGrantCoordinator(() => now);
    const expected = {
      ...principal,
      toolName: "ep_meeting_write",
      operation: "reserve",
      intentHash: "i",
      readRevision: "r",
    };
    expect(coordinator.consume(undefined, expected)).toMatchObject({ ok: false, reason: expect.stringContaining("missing") });
    expect(coordinator.consume("forged", expected)).toMatchObject({ ok: false });
    const expired = coordinator.issue({ ...expected, expiresAt: 51 });
    now = 52;
    expect(coordinator.consume(expired.token, expected)).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
    const generation = coordinator.issue({ ...expected, expiresAt: 100 });
    coordinator.revokeGeneration(principal.ownerPluginId, principal.generationId);
    expect(coordinator.consume(generation.token, expected)).toMatchObject({ ok: false });
    const session = coordinator.issue({ ...expected, expiresAt: 100 });
    coordinator.revokeSession(principal.appSessionId);
    expect(coordinator.consume(session.token, expected)).toMatchObject({ ok: false });
  });
});
