import { describe, expect, it } from "vitest";
import { PluginOperationGrantCoordinator } from "../plugin-operation-grant.js";

const principal = {
  ownerPluginId: "ep-api",
  ownerVersion: "1.2.3",
  generationId: "gen-1",
  appSessionId: "window-7",
  accountHash: "acct-hash",
};
const requiredRead = {
  readTool: "ep_attendance_read",
  readOperations: ["today"],
  maxAgeMs: 1_000,
} as const;

describe("PluginOperationGrantCoordinator", () => {
  it("records opaque read revisions and consumes a matching grant exactly once", () => {
    let now = 1_000;
    const coordinator = new PluginOperationGrantCoordinator(() => now);
    const readRevision = coordinator.recordRead(
      { ...principal, readTool: "ep_attendance_read", readOperation: "today" },
    );
    expect(coordinator.latestRequiredRead(principal, "ep_attendance_read", ["today"], 1_000)).toBe(readRevision);
    const grant = coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "intent",
      readRevision,
      expiresAt: now + 500,
    }, requiredRead);
    const expected = {
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "intent",
      requiresRead: true,
    };
    expect(coordinator.latestRequiredRead(principal, "ep_attendance_read", ["today"], 1_000)).toBeUndefined();
    expect(coordinator.consume(grant.token, expected)).toEqual({ ok: true, grantId: grant.grantId });
    expect(coordinator.consume(grant.token, expected)).toMatchObject({ ok: false, reason: expect.stringContaining("already consumed") });
    now += 2_000;
    expect(coordinator.latestRequiredRead(principal, "ep_attendance_read", ["today"], 1_000)).toBeUndefined();
  });

  it("burns before comparison so a mismatch cannot be retried", () => {
    const coordinator = new PluginOperationGrantCoordinator(() => 10);
    const readRevision = coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    });
    const grant = coordinator.issue({
      ...principal,
      toolName: "ep_parking_write",
      operation: "apply",
      intentHash: "one",
      readRevision,
      expiresAt: 100,
    }, requiredRead);
    const expected = {
      ...principal,
      toolName: "ep_parking_write",
      operation: "apply",
      intentHash: "one",
      requiresRead: true,
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
      requiresRead: false,
    };
    expect(coordinator.consume(undefined, expected)).toMatchObject({ ok: false, reason: expect.stringContaining("missing") });
    expect(coordinator.consume("forged", expected)).toMatchObject({ ok: false });
    const expired = coordinator.issue({
      ...principal,
      toolName: expected.toolName,
      operation: expected.operation,
      intentHash: expected.intentHash,
      readRevision: null,
      expiresAt: 51,
    });
    now = 52;
    expect(coordinator.consume(expired.token, expected)).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
    const generation = coordinator.issue({
      ...principal,
      toolName: expected.toolName,
      operation: expected.operation,
      intentHash: expected.intentHash,
      readRevision: null,
      expiresAt: 100,
    });
    coordinator.revokeGeneration(principal.ownerPluginId, principal.generationId);
    expect(coordinator.consume(generation.token, expected)).toMatchObject({ ok: false });
    const session = coordinator.issue({
      ...principal,
      toolName: expected.toolName,
      operation: expected.operation,
      intentHash: expected.intentHash,
      readRevision: null,
      expiresAt: 100,
    });
    coordinator.revokeSession(principal.appSessionId);
    expect(coordinator.consume(session.token, expected)).toMatchObject({ ok: false });
  });

  it("revokes unused grants and read snapshots for one authenticated account session", () => {
    const coordinator = new PluginOperationGrantCoordinator(() => 50);
    const readRevision = coordinator.recordRead({
      ...principal,
      readTool: "ep_attendance_read",
      readOperation: "today",
    });
    const expected = {
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "intent",
      requiresRead: true,
    };
    const grant = coordinator.issue({
      ...principal,
      toolName: expected.toolName,
      operation: expected.operation,
      intentHash: expected.intentHash,
      readRevision,
      expiresAt: 100,
    }, requiredRead);

    coordinator.revokeAccount(
      principal.ownerPluginId,
      principal.generationId,
      principal.accountHash,
    );

    expect(coordinator.consume(grant.token, expected)).toMatchObject({ ok: false });
    expect(
      coordinator.latestRequiredRead(
        principal,
        "ep_attendance_read",
        ["today"],
        1_000,
      ),
    ).toBeUndefined();
  });

  it("bounds grant, snapshot, and watermark state across many revoked sessions without weakening supersession", () => {
    const coordinator = new PluginOperationGrantCoordinator(() => 50);
    const sessionCount = 128;
    const coordinatorState = coordinator as unknown as {
      grants: Map<string, unknown>;
      snapshots: Map<string, unknown>;
      latestReadSequences: Map<string, number>;
    };

    for (let index = 0; index < sessionCount; index += 1) {
      const sessionPrincipal = {
        ...principal,
        appSessionId: `window-${index}`,
      };
      const readRevision = coordinator.recordRead({
        ...sessionPrincipal,
        readTool: requiredRead.readTool,
        readOperation: "today",
      });
      coordinator.issue({
        ...sessionPrincipal,
        toolName: "ep_attendance_write",
        operation: "clock",
        intentHash: `intent-${index}`,
        readRevision,
        expiresAt: 100,
      }, requiredRead);
      coordinator.recordRead({
        ...sessionPrincipal,
        readTool: requiredRead.readTool,
        readOperation: "week",
      });
    }

    expect(coordinatorState.grants.size).toBe(sessionCount);
    expect(coordinatorState.snapshots.size).toBe(sessionCount);
    expect(coordinatorState.latestReadSequences.size).toBe(sessionCount * 2);

    for (let index = 0; index < sessionCount; index += 1) {
      coordinator.revokeSession(`window-${index}`);
    }

    expect(coordinatorState.grants.size).toBe(0);
    expect(coordinatorState.snapshots.size).toBe(0);
    expect(coordinatorState.latestReadSequences.size).toBe(0);

    const firstRead = coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    });
    const firstGrant = coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "surviving-session",
      readRevision: firstRead,
      expiresAt: 500,
    }, requiredRead);
    const secondRead = coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    });
    const secondGrant = coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "surviving-session",
      readRevision: secondRead,
      expiresAt: 500,
    }, requiredRead);
    const expected = {
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "surviving-session",
      requiresRead: true,
    };

    expect(coordinator.consume(firstGrant.token, expected)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("superseded"),
    });
    expect(coordinator.consume(secondGrant.token, expected)).toEqual({
      ok: true,
      grantId: secondGrant.grantId,
    });
  });

  it("atomically reserves one read revision for only one concurrent grant", async () => {
    const coordinator = new PluginOperationGrantCoordinator(() => 50);
    const readRevision = coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    });
    const issue = () => coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "same-intent",
      readRevision,
      expiresAt: 100,
    }, requiredRead);

    const results = await Promise.allSettled([
      Promise.resolve().then(issue),
      Promise.resolve().then(issue),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected"))
      .toMatchObject({ reason: expect.objectContaining({
        message: expect.stringContaining("already reserved"),
      }) });
  });

  it.each(["today", "week"] as const)(
    "burns a grant when a newer %s read supersedes its reserved revision",
    (supersedingOperation) => {
      let now = 50;
      const coordinator = new PluginOperationGrantCoordinator(() => now);
      const multiOperationRequiredRead = {
        ...requiredRead,
        readOperations: ["today", "week"],
      } as const;
      const readRevision = coordinator.recordRead({
        ...principal,
        readTool: requiredRead.readTool,
        readOperation: "today",
      });
      const grant = coordinator.issue({
        ...principal,
        toolName: "ep_attendance_write",
        operation: "clock",
        intentHash: "same-intent",
        readRevision,
        expiresAt: 500,
      }, multiOperationRequiredRead);

      coordinator.recordRead({
        ...principal,
        readTool: requiredRead.readTool,
        readOperation: supersedingOperation,
      });
      const expected = {
        ...principal,
        toolName: "ep_attendance_write",
        operation: "clock",
        intentHash: "same-intent",
        requiresRead: true,
      };
      expect(coordinator.consume(grant.token, expected)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("superseded"),
      });
      expect(coordinator.consume(grant.token, expected)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("already consumed"),
      });
    },
  );

  it.each(["today", "week"] as const)(
    "burns the older grant after a newer %s read is reserved by another grant",
    (supersedingOperation) => {
      const coordinator = new PluginOperationGrantCoordinator(() => 50);
      const multiOperationRequiredRead = {
        ...requiredRead,
        readOperations: ["today", "week"],
      } as const;
      const issue = (readRevision: string) => coordinator.issue({
        ...principal,
        toolName: "ep_attendance_write",
        operation: "clock",
        intentHash: "same-intent",
        readRevision,
        expiresAt: 500,
      }, multiOperationRequiredRead);
      const firstRead = coordinator.recordRead({
        ...principal,
        readTool: requiredRead.readTool,
        readOperation: "today",
      });
      const firstGrant = issue(firstRead);
      const secondRead = coordinator.recordRead({
        ...principal,
        readTool: requiredRead.readTool,
        readOperation: supersedingOperation,
      });
      const secondGrant = issue(secondRead);
      const expected = {
        ...principal,
        toolName: "ep_attendance_write",
        operation: "clock",
        intentHash: "same-intent",
        requiresRead: true,
      };

      expect(coordinator.consume(firstGrant.token, expected)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("superseded"),
      });
      expect(coordinator.consume(secondGrant.token, expected)).toEqual({
        ok: true,
        grantId: secondGrant.grantId,
      });
    },
  );

  it("rejects a reserved read that becomes stale before grant consumption", () => {
    let now = 50;
    const coordinator = new PluginOperationGrantCoordinator(() => now);
    const readRevision = coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    });
    const grant = coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "same-intent",
      readRevision,
      expiresAt: 5_000,
    }, requiredRead);

    now += requiredRead.maxAgeMs + 1;
    expect(coordinator.consume(grant.token, {
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "same-intent",
      requiresRead: true,
    })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("stale"),
    });
  });
});
