import { describe, expect, it } from "vitest";
import {
  PluginOperationExecutionLeaseAbortedError,
  PluginOperationGrantCoordinator,
  pluginOperationExecutionDomain,
  type PluginOperationPrincipal,
} from "../plugin-operation-grant.js";

const principal = {
  ownerPluginId: "ep-api",
  ownerVersion: "1.2.3",
  generationId: "gen-1",
  appSessionId: "window-7",
  accountScopeHash: "acct-scope-hash",
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
      {
        ...principal,
        accountScopeHash: "another-account-scope",
        accountHash: "another-account",
      },
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

  it("serializes every governed operation through one FIFO exclusive lease", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const domain = "a".repeat(64);
    const first = await coordinator.acquireExecutionLease(domain, principal);
    let secondStarted = false;
    const second = coordinator.acquireExecutionLease(domain, principal).then((lease) => {
      secondStarted = true;
      return lease;
    });
    let thirdStarted = false;
    const third = coordinator.acquireExecutionLease(domain, principal).then((lease) => {
      thirdStarted = true;
      return lease;
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    expect(thirdStarted).toBe(false);

    first.release();
    const secondLease = await second;
    expect(secondStarted).toBe(true);
    expect(thirdStarted).toBe(false);
    secondLease.release();
    const thirdLease = await third;
    expect(thirdStarted).toBe(true);
    thirdLease.release();
  });

  it("queues an account transition behind an admitted operation and ahead of replacement work", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const active = await coordinator.acquireExecutionLease(
      grantDomain,
      principal,
    );
    const order: string[] = [];
    const transition = coordinator.acquireAccountTransitionLease(
      principal,
    ).then((lease) => {
      order.push("transition");
      return lease;
    });
    const replacementPrincipal = {
      ...principal,
      generationId: "generation-replacement",
      accountHash: "account-principal-replacement",
    };
    const replacementDomain = pluginOperationExecutionDomain(
      replacementPrincipal,
      "ep_attendance_write",
      "clock",
      [{
        name: "ep_attendance_write",
        pluginId: principal.ownerPluginId,
        pluginGeneration: {
          generationId: replacementPrincipal.generationId,
        },
        operationPolicy: {
          discriminant: "operation",
          operations: {
            clock: {
              kind: "write",
              minimumRisk: "network",
              appVisible: true,
            },
          },
        },
      }],
    );
    const replacement = coordinator.acquireExecutionLease(
      replacementDomain,
      replacementPrincipal,
    ).then((lease) => {
      order.push("replacement");
      return lease;
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    active.release();
    const transitionLease = await transition;
    expect(order).toEqual(["transition"]);
    await Promise.resolve();
    expect(order).toEqual(["transition"]);
    transitionLease.release();
    const replacementLease = await replacement;
    expect(order).toEqual(["transition", "replacement"]);
    replacementLease.release();
  });

  it("refuses an account transition after an admitted operation becomes indeterminate", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const active = await coordinator.acquireExecutionLease(
      grantDomain,
      principal,
    );
    const transition = coordinator.acquireAccountTransitionLease(
      principal,
    );

    coordinator.poisonDomain(grantDomain);
    active.release();

    await expect(transition).rejects.toThrow(
      "plugin operation account scope is indeterminate",
    );
  });

  it.each(["generation", "session"] as const)(
    "cancels a queued account transition when its %s is revoked",
    async (revocation) => {
      const coordinator = new PluginOperationGrantCoordinator();
      const active = await coordinator.acquireExecutionLease(
        grantDomain,
        principal,
      );
      const transitionResult = coordinator.acquireAccountTransitionLease(
        principal,
      ).then(
        () => "granted",
        (error: Error) => error.message,
      );

      if (revocation === "generation") {
        coordinator.revokeGeneration(
          principal.ownerPluginId,
          principal.generationId,
        );
      } else {
        coordinator.revokeSession(principal.appSessionId);
      }

      await expect(transitionResult).resolves.toContain(
        `plugin operation ${revocation} is revoked`,
      );
      active.release();
    },
  );

  it("rechecks a resolved account transition before handler entry", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const active = await coordinator.acquireExecutionLease(
      grantDomain,
      principal,
    );
    const transition = coordinator.acquireAccountTransitionLease(principal);

    active.release();
    const lease = await transition;
    // The request is no longer queued at this point. A session teardown in
    // this exact async-continuation window must still block the handler.
    coordinator.revokeSession(principal.appSessionId);

    expect(() => lease.assertAuthorized()).toThrow(
      "plugin operation session is revoked",
    );
    lease.release();
  });

  it("serializes consecutive auth transitions behind governed work", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const active = await coordinator.acquireExecutionLease(
      grantDomain,
      principal,
    );
    const order: string[] = [];
    const first = coordinator.acquireAccountTransitionLease(principal)
      .then((lease) => {
        order.push("first-auth");
        return lease;
      });
    const second = coordinator.acquireAccountTransitionLease({
      ...principal,
      appSessionId: "window-second-auth",
    }).then((lease) => {
      order.push("second-auth");
      return lease;
    });

    active.release();
    const firstLease = await first;
    expect(order).toEqual(["first-auth"]);
    await Promise.resolve();
    expect(order).toEqual(["first-auth"]);
    firstLease.release();
    const secondLease = await second;
    expect(order).toEqual(["first-auth", "second-auth"]);
    secondLease.release();
  });

  it("removes a queued auth transition when its admission signal aborts", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const active = await coordinator.acquireExecutionLease(
      grantDomain,
      principal,
    );
    const controller = new AbortController();
    const transition = coordinator.acquireAccountTransitionLease(
      principal,
      controller.signal,
    );

    controller.abort();

    await expect(transition).rejects.toBeInstanceOf(
      PluginOperationExecutionLeaseAbortedError,
    );
    active.release();
    const next = await coordinator.acquireAccountTransitionLease(principal);
    next.release();
  });

  it("serializes a replacement generation through the stable plugin-account scope", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const predecessorDomain = "3".repeat(64);
    const replacementDomain = "4".repeat(64);
    const predecessor = await coordinator.acquireExecutionLease(
      predecessorDomain,
      principal,
    );
    const replacementPrincipal = {
      ...principal,
      ownerVersion: "2.0.0",
      generationId: "gen-2",
      accountHash: "rotated-account-principal",
    };
    let replacementStarted = false;
    const replacement = coordinator.acquireExecutionLease(
      replacementDomain,
      replacementPrincipal,
    ).then((lease) => {
      replacementStarted = true;
      return lease;
    });

    await Promise.resolve();
    expect(replacementStarted).toBe(false);
    coordinator.revokeGeneration(
      principal.ownerPluginId,
      principal.generationId,
    );
    expect(replacementStarted).toBe(false);

    predecessor.release();
    const replacementLease = await replacement;
    expect(replacementStarted).toBe(true);
    replacementLease.release();
  });

  it("rejects a queued replacement when predecessor completion poisons the stable scope", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const predecessorDomain = "5".repeat(64);
    const replacementDomain = "6".repeat(64);
    const predecessor = await coordinator.acquireExecutionLease(
      predecessorDomain,
      principal,
    );
    const replacement = coordinator.acquireExecutionLease(
      replacementDomain,
      {
        ...principal,
        ownerVersion: "2.0.0",
        generationId: "gen-2",
        accountHash: "replacement-account-principal",
      },
    );

    coordinator.poisonDomain(predecessorDomain);
    coordinator.revokeGeneration(
      principal.ownerPluginId,
      principal.generationId,
    );
    predecessor.release();

    await expect(replacement).rejects.toThrow(
      "plugin operation domain is indeterminate",
    );
  });

  it("releases an aborted queued execution lease without blocking the domain", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const domain = "b".repeat(64);
    const writer = await coordinator.acquireExecutionLease(domain, principal);
    const controller = new AbortController();
    const queued = coordinator.acquireExecutionLease(
      domain,
      principal,
      controller.signal,
    );
    controller.abort();
    await expect(queued).rejects.toThrow("aborted");
    writer.release();
    const next = await coordinator.acquireExecutionLease(domain, principal);
    next.release();
  });

  it("keeps an active revoked domain poisoned until its holder releases", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    const writer = await coordinator.acquireExecutionLease(grantDomain, principal);
    const queued = coordinator.acquireExecutionLease(grantDomain, principal);

    coordinator.revokeAccount(
      principal.ownerPluginId,
      principal.generationId,
      principal.accountHash,
    );
    await expect(queued).rejects.toThrow("revoked");
    await expect(
      coordinator.acquireExecutionLease(grantDomain, principal),
    ).rejects.toThrow("revoked");
    expect(() => coordinator.markDomainMutation(grantDomain)).not.toThrow();

    writer.release();
    const state = coordinator as unknown as {
      executionDomains: Map<string, unknown>;
      domainRevisions: Map<string, unknown>;
    };
    expect(state.executionDomains.size).toBe(0);
    expect(state.domainRevisions.has(grantDomain)).toBe(false);
  });

  it("tombstones account and generation revocation before their first domain admission", async () => {
    const accountCoordinator = new PluginOperationGrantCoordinator();
    accountCoordinator.revokeAccount(
      principal.ownerPluginId,
      principal.generationId,
      principal.accountHash,
    );
    await expect(accountCoordinator.acquireExecutionLease(
      grantDomain,
      principal,
    )).rejects.toThrow("account is revoked");

    const generationCoordinator = new PluginOperationGrantCoordinator();
    generationCoordinator.revokeGeneration(
      principal.ownerPluginId,
      principal.generationId,
    );
    await expect(generationCoordinator.acquireExecutionLease(
      grantDomain,
      principal,
    )).rejects.toThrow("generation is revoked");
  });

  it("rejects only the revoked session's queued operations and cannot recreate its read authority", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const holderPrincipal = { ...principal, appSessionId: "window-holder" };
    const survivorPrincipal = { ...principal, appSessionId: "window-survivor" };
    const holder = await coordinator.acquireExecutionLease(
      grantDomain,
      holderPrincipal,
    );
    const revokedRead = coordinator.acquireExecutionLease(
      grantDomain,
      principal,
    );
    const revokedWrite = coordinator.acquireExecutionLease(
      grantDomain,
      principal,
    );
    const survivor = coordinator.acquireExecutionLease(
      grantDomain,
      survivorPrincipal,
    );

    coordinator.revokeSession(principal.appSessionId);
    await expect(revokedRead).rejects.toThrow("session is revoked");
    await expect(revokedWrite).rejects.toThrow("session is revoked");
    expect(coordinator.canRecordRead(principal, grantDomain)).toBe(false);
    expect(() => coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain)).toThrow("session is revoked");

    holder.release();
    const survivorLease = await survivor;
    expect(coordinator.canRecordRead(survivorPrincipal, grantDomain)).toBe(true);
    survivorLease.release();
  });

  it("serializes writes per domain without blocking a different account domain", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    const firstAccountDomain = "c".repeat(64);
    const secondAccountDomain = "d".repeat(64);
    const firstWrite = await coordinator.acquireExecutionLease(
      firstAccountDomain,
      principal,
    );
    let sameAccountStarted = false;
    const sameAccountWrite = coordinator.acquireExecutionLease(
      firstAccountDomain,
      principal,
    ).then((lease) => {
      sameAccountStarted = true;
      return lease;
    });
    let otherAccountStarted = false;
    const otherAccountWrite = coordinator.acquireExecutionLease(
      secondAccountDomain,
      {
        ...principal,
        accountScopeHash: "other-account-scope",
        accountHash: "other-account",
      },
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

  it("does not let later reads clear an indeterminate post-hook domain", () => {
    const coordinator = new PluginOperationGrantCoordinator(() => 1_000);
    coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    coordinator.poisonDomain(grantDomain);

    expect(() => coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain)).toThrow("plugin operation domain is indeterminate");

    expect(
      coordinator.latestRequiredRead(
        principal,
        requiredRead.readTool,
        requiredRead.readOperations,
        requiredRead.maxAgeMs,
        grantDomain,
      ),
    ).toBeUndefined();
  });

  it("rejects issued, future, and queued operations after domain poison", async () => {
    const coordinator = new PluginOperationGrantCoordinator(() => 1_000);
    const directBinding = {
      ...principal,
      toolName: "ep_parking_write",
      operation: "reserve",
      intentHash: "direct-write",
      readRevision: null,
      expiresAt: 2_000,
    };
    const issuedBeforePoison = coordinator.issue(
      directBinding,
      grantDomain,
    );
    const holder = await coordinator.acquireExecutionLease(
      grantDomain,
      principal,
    );
    const queued = coordinator.acquireExecutionLease(
      grantDomain,
      principal,
    );

    coordinator.poisonDomain(grantDomain);

    expect(() => coordinator.issue(
      { ...directBinding, intentHash: "future-write" },
      grantDomain,
    )).toThrow("plugin operation domain is indeterminate");
    expect(() =>
      coordinator.assertExecutionAuthorized(principal, grantDomain)
    ).toThrow("plugin operation domain is indeterminate");

    holder.release();
    await expect(queued).rejects.toThrow(
      "plugin operation domain is indeterminate",
    );
    expect(coordinator.consume(
      issuedBeforePoison.token,
      {
        ...principal,
        toolName: directBinding.toolName,
        operation: directBinding.operation,
        intentHash: directBinding.intentHash,
        requiresRead: false,
      },
      grantDomain,
    )).toMatchObject({
      ok: false,
      reason: "operation grant domain is indeterminate",
    });
    await expect(coordinator.acquireExecutionLease(
      grantDomain,
      principal,
    )).rejects.toThrow("plugin operation domain is indeterminate");
  });

  it("carries poison across replacement generations for the same plugin account", async () => {
    const coordinator = new PluginOperationGrantCoordinator();
    coordinator.recordRead({
      ...principal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    coordinator.poisonDomain(grantDomain);
    coordinator.revokeGeneration(principal.ownerPluginId, principal.generationId);

    const replacement = {
      ...principal,
      ownerVersion: "2.0.0",
      generationId: "gen-2",
      appSessionId: "replacement-window",
      accountHash: "replacement-principal",
    };
    const replacementDomain = "1".repeat(64);
    await expect(
      coordinator.acquireExecutionLease(replacementDomain, replacement),
    ).rejects.toThrow("plugin operation domain is indeterminate");
    expect(() => coordinator.recordRead({
      ...replacement,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, replacementDomain)).toThrow("plugin operation domain is indeterminate");

    const otherAccount = {
      ...replacement,
      accountScopeHash: "different-account-scope",
      accountHash: "different-account",
    };
    const otherAccountLease = await coordinator.acquireExecutionLease(
      "2".repeat(64),
      otherAccount,
    );
    otherAccountLease.release();
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
    const sessionCoordinator = new PluginOperationGrantCoordinator(() => now);
    const session = sessionCoordinator.issue({
      ...principal,
      toolName: expected.toolName,
      operation: expected.operation,
      intentHash: expected.intentHash,
      readRevision: null,
      expiresAt: 100,
    }, grantDomain);
    sessionCoordinator.revokeSession(principal.appSessionId);
    expect(sessionCoordinator.consume(session.token, expected, grantDomain)).toMatchObject({ ok: false });
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

    const survivingPrincipal = {
      ...principal,
      appSessionId: "window-surviving",
    };
    const firstRead = coordinator.recordRead({
      ...survivingPrincipal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    const firstGrant = coordinator.issue({
      ...survivingPrincipal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "surviving-session",
      readRevision: firstRead,
      expiresAt: 500,
    }, grantDomain, requiredRead);
    const secondRead = coordinator.recordRead({
      ...survivingPrincipal,
      readTool: requiredRead.readTool,
      readOperation: "today",
    }, grantDomain);
    const secondGrant = coordinator.issue({
      ...survivingPrincipal,
      toolName: "ep_attendance_write",
      operation: "clock",
      intentHash: "surviving-session",
      readRevision: secondRead,
      expiresAt: 500,
    }, grantDomain, requiredRead);
    const expected = {
      ...survivingPrincipal,
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

  it("bounds revocation tombstones by degrading globally fail-closed", async () => {
    const coordinator = new PluginOperationGrantCoordinator(
      Date.now,
      1024,
      2048,
      4096,
      2,
    );
    coordinator.revokeSession("revoked-1");
    coordinator.revokeSession("revoked-2");
    coordinator.revokeSession("revoked-3");

    const state = coordinator as unknown as {
      revokedSessions: Set<string>;
      revokedGenerations: Set<string>;
      revokedAccounts: Set<string>;
      revocationCapacityExhausted: boolean;
    };
    expect(
      state.revokedSessions.size +
      state.revokedGenerations.size +
      state.revokedAccounts.size,
    ).toBe(0);
    expect(state.revocationCapacityExhausted).toBe(true);
    await expect(coordinator.acquireExecutionLease(
      grantDomain,
      { ...principal, appSessionId: "otherwise-fresh" },
    )).rejects.toThrow("revocation capacity exhausted");
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
