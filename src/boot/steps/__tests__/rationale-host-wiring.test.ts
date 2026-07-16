import { describe, expect, it, vi } from "vitest";
import type { RationaleAuditSink } from "../../../audit/rationale-audit-adapter.js";
import type { BootContext } from "../../context.js";
import type { RationaleHostService } from "../../../tools/pipeline/rationale-host-service.js";
import { MemorySecretStore } from "../../../audit/hmac-chain.js";
import { wireRationaleHost } from "../rationale-host-wiring.js";

function makeContext(): BootContext {
  return {
    rationaleHostService: undefined,
    bootAuditLogger: {
      getAuditDir: vi.fn(() => "C:\\audit"),
      getPermissionAuditSecret: vi.fn(() => "s".repeat(64)),
      getPermissionAuditSealStore: vi.fn(() => new MemorySecretStore()),
    },
    approvalGate: {},
    toolRegistry: { getGeneration: vi.fn(() => "registry-1") },
    rationaleScopeReviewer: { reevaluate: vi.fn() },
  } as unknown as BootContext;
}

function makeAuditSink(
  onInvocation?: (sessionId: string, record: unknown) => void,
): RationaleAuditSink {
  return {
    assertWritable: vi.fn(),
    appendTicket: vi.fn(),
    appendInvocation: vi.fn((sessionId, record) => {
      onInvocation?.(sessionId, record);
      return {} as never;
    }),
    appendProjection: vi.fn(() => ({} as never)),
  };
}

describe("wireRationaleHost", () => {
  it("publishes a dormant service without audit, recovery, or reviewer access", async () => {
    const ctx = makeContext();
    let reviewerReads = 0;
    Object.defineProperty(ctx, "rationaleScopeReviewer", {
      configurable: true,
      get: () => {
        reviewerReads += 1;
        return { reevaluate: vi.fn() };
      },
    });
    const service = {
      createCoordinatorFactory: vi.fn(),
      closeSession: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as RationaleHostService;
    const auditSink = makeAuditSink();
    const recoverAfterCrash = vi.fn();
    const createAuditSink = vi.fn(() => auditSink);
    const createInvocationJournal = vi.fn(() => ({
      commitStart: vi.fn(),
      commitTerminal: vi.fn(),
      recoverAfterCrash,
    }));
    const createHostService = vi.fn(() => service);

    await wireRationaleHost(ctx, {
      productionEnabled: false,
      createAuditSink,
      createInvocationJournal,
      createHostService,
    });

    expect(ctx.rationaleHostService).toBe(service);
    expect(ctx.bootAuditLogger.getAuditDir).toHaveBeenCalledOnce();
    expect(ctx.bootAuditLogger.getPermissionAuditSecret).toHaveBeenCalledOnce();
    expect(ctx.bootAuditLogger.getPermissionAuditSealStore).toHaveBeenCalledOnce();
    expect(createAuditSink).toHaveBeenCalledOnce();
    expect(createInvocationJournal).toHaveBeenCalledOnce();
    expect(createHostService).toHaveBeenCalledOnce();
    expect(auditSink.assertWritable).not.toHaveBeenCalled();
    expect(auditSink.appendInvocation).not.toHaveBeenCalled();
    expect(auditSink.appendProjection).not.toHaveBeenCalled();
    expect(recoverAfterCrash).not.toHaveBeenCalled();
    expect(reviewerReads).toBe(0);
  });

  it("publishes the service only after recovery and preserves origin session audit attribution", async () => {
    const ctx = makeContext();
    const service = {
      createCoordinatorFactory: vi.fn(),
      closeSession: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as RationaleHostService;
    const publicationStates: Array<RationaleHostService | undefined> = [];
    const appendInvocation = vi.fn((sessionId: string, record: unknown) => {
      publicationStates.push(ctx.rationaleHostService);
      expect(sessionId).toBe("origin-session");
      expect(record).toEqual({ state: "unknown-after-crash" });
    });
    const auditSink = makeAuditSink(appendInvocation);
    const recoverAfterCrash = vi.fn(async (input: {
      persistAudit: (sessionId: string, record: never) => Promise<void> | void;
    }) => {
      await input.persistAudit("origin-session", {
        state: "unknown-after-crash",
      } as never);
      publicationStates.push(ctx.rationaleHostService);
      return { recovered: 1, delivered: 1 };
    });
    const createHostService = vi.fn(() => {
      publicationStates.push(ctx.rationaleHostService);
      return service;
    });

    await wireRationaleHost(ctx, {
      productionEnabled: true,
      createAuditSink: () => auditSink,
      createInvocationJournal: () => ({
        commitStart: vi.fn(),
        commitTerminal: vi.fn(),
        recoverAfterCrash,
      }),
      createHostService,
    });

    expect(auditSink.assertWritable).toHaveBeenCalledOnce();
    expect(recoverAfterCrash).toHaveBeenCalledOnce();
    expect(appendInvocation).toHaveBeenCalledOnce();
    expect(publicationStates).toEqual([undefined, undefined, undefined]);
    expect(ctx.rationaleHostService).toBe(service);
  });

  it("fails closed when recovery reports corruption", async () => {
    const ctx = makeContext();
    const auditSink = makeAuditSink();
    const createHostService = vi.fn();

    await expect(
      wireRationaleHost(ctx, {
        productionEnabled: true,
        createAuditSink: () => auditSink,
        createInvocationJournal: () => ({
          commitStart: vi.fn(),
          commitTerminal: vi.fn(),
          recoverAfterCrash: vi.fn(async () => {
            throw new Error("corrupt C:\\secret\\journal");
          }),
        }),
        createHostService,
      }),
    ).resolves.toBeUndefined();

    expect(ctx.rationaleHostService).toBeUndefined();
    expect(createHostService).not.toHaveBeenCalled();
    expect(auditSink.appendInvocation).not.toHaveBeenCalled();
  });
});
