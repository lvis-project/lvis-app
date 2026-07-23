import { describe, expect, it } from "vitest";
import {
  PluginOperationGrantCoordinator,
  pluginOperationExecutionDomain,
  type PluginOperationPrincipal,
} from "../plugin-operation-grant.js";

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
const grantDomain = "f".repeat(64);

describe("PluginOperationGrantCoordinator", () => {
  it("derives one Host-owned domain for every governed operation in an account", () => {
    const tools = [
      {
        name: "ep_attendance_read",
        pluginId: "ep-api",
        pluginGeneration: { generationId: "gen-1" },
        operationPolicy: {
          discriminant: "operation" as const,
          operations: {
            today: { kind: "read" as const, minimumRisk: "read" as const },
            week: { kind: "read" as const, minimumRisk: "network" as const },
          },
        },
      },
      {
        name: "ep_attendance_write",
        pluginId: "ep-api",
        pluginGeneration: { generationId: "gen-1" },
        operationPolicy: {
          discriminant: "operation" as const,
          operations: {
            clock: {
              kind: "write" as const,
              minimumRisk: "write" as const,
              requiresRead: {
                tool: "ep_attendance_read",
                operations: ["today", "week"],
                maxAgeMs: 1_000,
              },
            },
          },
        },
      },
    ];

    const readDomain = pluginOperationExecutionDomain(
      principal,
      "ep_attendance_read",
      "today",
      tools,
    );
    const writeDomain = pluginOperationExecutionDomain(
      { ...principal, appSessionId: "another-window" },
      "ep_attendance_write",
      "clock",
      tools,
    );
    const anotherAccount = pluginOperationExecutionDomain(
      { ...principal, accountHash: "another-account" },
      "ep_attendance_write",
      "clock",
      tools,
    );

    expect(writeDomain).toBe(readDomain);
    expect(anotherAccount).not.toBe(readDomain);
    expect(
      pluginOperationExecutionDomain(
        principal,
        "ep_attendance_read",
        "week",
        tools,
      ),
    ).toBe(readDomain);
  });

  it("runs domain reads concurrently but queues them behind writes without writer starvation", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const domain = "a".repeat(64);
    const firstRead = await coordinator.acquireExecutionLease(domain, "read");
    let concurrentReadStarted = false;
    const concurrentRead = coordinator.acquireExecutionLease(domain, "read").then((lease) => {
      concurrentReadStarted = true;
      return lease;
    });
    const concurrentReadLease = await concurrentRead;
    expect(concurrentReadStarted).toBe(true);

    let writeStarted = false;
    const write = coordinator.acquireExecutionLease(domain, "write").then((lease) => {
      writeStarted = true;
      return lease;
    });
    await Promise.resolve();
    expect(writeStarted).toBe(false);

    let lateReadStarted = false;
    const lateRead = coordinator.acquireExecutionLease(domain, "read").then((lease) => {
      lateReadStarted = true;
      return lease;
    });
    await Promise.resolve();
    expect(lateReadStarted).toBe(false);

    firstRead.release();
    await Promise.resolve();
    expect(writeStarted).toBe(false);
    concurrentReadLease.release();
    const writeLease = await write;
    expect(writeStarted).toBe(true);
    expect(lateReadStarted).toBe(false);
    writeLease.release();
    const lateReadLease = await lateRead;
    expect(lateReadStarted).toBe(true);
    lateReadLease.release();
  });

  it("releases an aborted queued execution lease without blocking the domain", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const domain = "b".repeat(64);
    const writer = await coordinator.acquireExecutionLease(domain, "write");
    const controller = new AbortController();
    const queued = coordinator.acquireExecutionLease(
      domain,
      "read",
      controller.signal,
    );
    controller.abort();
    await expect(queued).rejects.toThrow("aborted");
    writer.release();
    const next = await coordinator.acquireExecutionLease(domain, "write");
    next.release();
  });

  it("keeps an active revoked domain poisoned until its holder releases", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    const writer = await coordinator.acquireExecutionLease(grantDomain, "write");
    const queued = coordinator.acquireExecutionLease(grantDomain, "read");

    coordinator.revokeAccount(
      principal.ownerPluginId,
      principal.generationId,
      principal.accountHash,
    );
    await expect(queued).rejects.toThrow("revoked");
    await expect(
      coordinator.acquireExecutionLease(grantDomain, "write"),
    ).rejects.toThrow("revoked");
    expect(() => coordinator.markDomainMutation(grantDomain)).not.toThrow();

    writer.release();
    const state = coordinator as unknown as {
      executionDomains: Map<string, unknown>;
      domainRevisions: Map<string, unknown>;
    };
    expect(state.executionDomains.has(grantDomain)).toBe(false);
    expect(state.domainRevisions.has(grantDomain)).toBe(false);
  });

  it("serializes writes per domain without blocking a different account domain", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const firstAccountDomain = "c".repeat(64);
    const secondAccountDomain = "d".repeat(64);
    const firstWrite = await coordinator.acquireExecutionLease(
      firstAccountDomain,
      "write",
    );
    let sameAccountStarted = false;
    const sameAccountWrite = coordinator.acquireExecutionLease(
      firstAccountDomain,
      "write",
    ).then((lease) => {
      sameAccountStarted = true;
      return lease;
    });
    let otherAccountStarted = false;
    const otherAccountWrite = coordinator.acquireExecutionLease(
      secondAccountDomain,
      "write",
    ).then((lease) => {
      otherAccountStarted = true;
      return lease;
    });
    await Promise.resolve();
    expect(sameAccountStarted).toBe(false);
    expect(otherAccountStarted).toBe(true);

    const otherAccountLease = await otherAccountWrite;
    otherAccountLease.release();
    firstWrite.release();
    const sameAccountLease = await sameAccountWrite;
    expect(sameAccountStarted).toBe(true);
    sameAccountLease.release();
  });

  it("invalidates another session's pre-write grant after a domain mutation", () => {
    const coordinator = new PluginOperationGrantCoordinator(() => 50);
    const sessionB = { ...principal, appSessionId: "window-8" };
    const issueFor = (
      sessionPrincipal: PluginOperationPrincipal,
      readRevision: string,
    ) =>
      coordinator.issue({
        ...sessionPrincipal,
        toolName: "ep_attendance_write",
        operation: "clock",
        intentHash: "shared-account-intent",
        readRevision,
        expiresAt: 500,
      }, grantDomain, requiredRead);
    const expectedFor = (sessionPrincipal: PluginOperationPrincipal) => ({
      ...sessionPrincipal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "shared-account-intent",
      requiresRead: true,
    });

    const readA = coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    const readB = coordinator.recordRead({
      ...sessionB,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    const grantA = issueFor(principal, readA);
    const staleGrantB = issueFor(sessionB, readB);

    expect(
      coordinator.consume(grantA.token, expectedFor(principal), grantDomain),
    ).toMatchObject({ ok: true });
    coordinator.markDomainMutation(grantDomain);
    expect(
      coordinator.consume(
        staleGrantB.token,
        expectedFor(sessionB),
        grantDomain,
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("intervening write"),
    });

    const freshReadB = coordinator.recordRead({
      ...sessionB,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    const freshGrantB = issueFor(sessionB, freshReadB);
    expect(
      coordinator.consume(
        freshGrantB.token,
        expectedFor(sessionB),
        grantDomain,
      ),
    ).toMatchObject({ ok: true });
  });

  it("records opaque read revisions and consumes a matching grant exactly once", () => {
    let now = 1_000;
    const coordinator = new PluginOperationGrantCoordinator(() => now);
    const readRevision = coordinator.recordRead(
      { ...principal, readTool: "ep_attendance_read", readOperation: "today" },
      grantDomain,
    );
    expect(coordinator.latestRequiredRead(principal, "ep_attendance_read", ["today"], 1_000, grantDomain)).toBe(readRevision);
    const grant = coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "intent",
      readRevision,
      expiresAt: now + 500,
    }, grantDomain, requiredRead);
    const expected = {
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "intent",
      requiresRead: true,
    };
    expect(coordinator.latestRequiredRead(principal, "ep_attendance_read", ["today"], 1_000, grantDomain)).toBeUndefined();
    expect(coordinator.consume(grant.token, expected, grantDomain)).toEqual({ ok: true, grantId: grant.grantId });
    expect(coordinator.consume(grant.token, expected, grantDomain)).toMatchObject({ ok: false, reason: expect.stringContaining("already consumed") });
    now += 2_000;
    expect(coordinator.latestRequiredRead(principal, "ep_attendance_read", ["today"], 1_000, grantDomain)).toBeUndefined();
  });

  it("burns before comparison so a mismatch cannot be retried", () => {
    const coordinator = new PluginOperationGrantCoordinator(() => 10);
    const readRevision = coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    const grant = coordinator.issue({
      ...principal,
      toolName: "ep_parking_write",
      operation: "apply",
      intentHash: "one",
      readRevision,
      expiresAt: 100,
    }, grantDomain, requiredRead);
    const expected = {
      ...principal,
      toolName: "ep_parking_write",
      operation: "apply",
      intentHash: "one",
      requiresRead: true,
    };
    expect(coordinator.consume(grant.token, { ...expected, accountHash: "forged" }, grantDomain)).toMatchObject({ ok: false, reason: "operation grant accountHash mismatch" });
    expect(coordinator.consume(grant.token, expected, grantDomain)).toMatchObject({ ok: false });
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
    expect(coordinator.consume(undefined, expected, grantDomain)).toMatchObject({ ok: false, reason: expect.stringContaining("missing") });
    expect(coordinator.consume("forged", expected, grantDomain)).toMatchObject({ ok: false });
    const expired = coordinator.issue({
      ...principal,
      toolName: expected.toolName,
      operation: expected.operation,
      intentHash: expected.intentHash,
      readRevision: null,
      expiresAt: 51,
    }, grantDomain);
    now = 52;
    expect(coordinator.consume(expired.token, expected, grantDomain)).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
    const generation = coordinator.issue({
      ...principal,
      toolName: expected.toolName,
      operation: expected.operation,
      intentHash: expected.intentHash,
      readRevision: null,
      expiresAt: 100,
    }, grantDomain);
    coordinator.revokeGeneration(principal.ownerPluginId, principal.generationId);
    expect(coordinator.consume(generation.token, expected, grantDomain)).toMatchObject({ ok: false });
    const session = coordinator.issue({
      ...principal,
      toolName: expected.toolName,
      operation: expected.operation,
      intentHash: expected.intentHash,
      readRevision: null,
      expiresAt: 100,
    }, grantDomain);
    coordinator.revokeSession(principal.appSessionId);
    expect(coordinator.consume(session.token, expected, grantDomain)).toMatchObject({ ok: false });
  });

  it("revokes unused grants and read snapshots for one authenticated account session", () => {
    const coordinator = new PluginOperationGrantCoordinator(() => 50);
    const readRevision = coordinator.recordRead({
      ...principal,
      readTool: "ep_attendance_read",
      readOperation: "today",
    }, grantDomain);
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
    }, grantDomain, requiredRead);

    coordinator.revokeAccount(
      principal.ownerPluginId,
      principal.generationId,
      principal.accountHash,
    );

    expect(coordinator.consume(grant.token, expected, grantDomain)).toMatchObject({ ok: false });
    expect(
      coordinator.latestRequiredRead(
        principal,
        "ep_attendance_read",
        ["today"],
        1_000,
        grantDomain,
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
      }, grantDomain);
      coordinator.issue({
        ...sessionPrincipal,
        toolName: "ep_attendance_write",
        operation: "clock",
        intentHash: `intent-${index}`,
        readRevision,
        expiresAt: 100,
      }, grantDomain, requiredRead);
      coordinator.recordRead({
        ...sessionPrincipal,
        readTool: requiredRead.readTool,
        readOperation: "week",
      }, grantDomain);
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
    }, grantDomain);
    const firstGrant = coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "surviving-session",
      readRevision: firstRead,
      expiresAt: 500,
    }, grantDomain, requiredRead);
    const secondRead = coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    const secondGrant = coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "surviving-session",
      readRevision: secondRead,
      expiresAt: 500,
    }, grantDomain, requiredRead);
    const expected = {
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "surviving-session",
      requiresRead: true,
    };

    expect(coordinator.consume(firstGrant.token, expected, grantDomain)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("superseded"),
    });
    expect(coordinator.consume(secondGrant.token, expected, grantDomain)).toEqual({
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
    }, grantDomain);
    const issue = () => coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "same-intent",
      readRevision,
      expiresAt: 100,
    }, grantDomain, requiredRead);

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
      }, grantDomain);
      const grant = coordinator.issue({
        ...principal,
        toolName: "ep_attendance_write",
        operation: "clock",
        intentHash: "same-intent",
        readRevision,
        expiresAt: 500,
      }, grantDomain, multiOperationRequiredRead);

      coordinator.recordRead({
        ...principal,
        readTool: requiredRead.readTool,
        readOperation: supersedingOperation,
      }, grantDomain);
      const expected = {
        ...principal,
        toolName: "ep_attendance_write",
        operation: "clock",
        intentHash: "same-intent",
        requiresRead: true,
      };
      expect(coordinator.consume(grant.token, expected, grantDomain)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("superseded"),
      });
      expect(coordinator.consume(grant.token, expected, grantDomain)).toMatchObject({
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
      }, grantDomain, multiOperationRequiredRead);
      const firstRead = coordinator.recordRead({
        ...principal,
        readTool: requiredRead.readTool,
        readOperation: "today",
      }, grantDomain);
      const firstGrant = issue(firstRead);
      const secondRead = coordinator.recordRead({
        ...principal,
        readTool: requiredRead.readTool,
        readOperation: supersedingOperation,
      }, grantDomain);
      const secondGrant = issue(secondRead);
      const expected = {
        ...principal,
        toolName: "ep_attendance_write",
        operation: "clock",
        intentHash: "same-intent",
        requiresRead: true,
      };

      expect(coordinator.consume(firstGrant.token, expected, grantDomain)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("superseded"),
      });
      expect(coordinator.consume(secondGrant.token, expected, grantDomain)).toEqual({
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
    }, grantDomain);
    const grant = coordinator.issue({
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "same-intent",
      readRevision,
      expiresAt: 5_000,
    }, grantDomain, requiredRead);

    now += requiredRead.maxAgeMs + 1;
    expect(coordinator.consume(grant.token, {
      ...principal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "same-intent",
      requiresRead: true,
    }, grantDomain)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("stale"),
    });
  });
});
