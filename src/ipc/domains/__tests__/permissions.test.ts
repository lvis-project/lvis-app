import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(null, ...args);
}

function makeDeferredEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "deferred-1",
    ts: "2026-05-10T00:00:00Z",
    toolName: "bash",
    source: "builtin",
    category: "shell",
    inputSummary: "bash command",
    verdict: { level: "high", reason: "test" },
    status: "pending",
    ...overrides,
  };
}

function makeDeps(options: {
  approvalChoice?: "allow-once" | "deny-once";
  auditReady?: boolean;
  auditAppendError?: Error;
  queue?: Record<string, unknown> | null;
} = {}) {
  const appWindows = [
    {
      isDestroyed: vi.fn(() => false),
      webContents: {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      },
    },
    {
      isDestroyed: vi.fn(() => false),
      webContents: {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      },
    },
  ];
  const permissionManager = {
    getMode: vi.fn(() => "default"),
    setMode: vi.fn(),
    setModePersist: vi.fn(async () => undefined),
    listPersistedRules: vi.fn(async () => []),
    addAlwaysAllowedPersist: vi.fn(async () => undefined),
    addAlwaysDeniedPersist: vi.fn(async () => undefined),
    removeRule: vi.fn(async () => undefined),
    getVisibilityDenyRules: vi.fn(() => []),
    getDeferredQueue: vi.fn(() => options.queue ?? null),
  };
  const deps = {
    conversationLoop: {
      permissionManager,
      addSessionAdditionalDirectory: vi.fn(),
    },
    approvalGate: {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: options.approvalChoice ?? "allow-once",
      })),
    },
    auditLogger: {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => options.auditReady ?? true),
      appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => {
        if (options.auditAppendError) throw options.auditAppendError;
        return {
          ...entry,
          prevHash: "h",
        };
      }),
      getAuditDir: vi.fn(() => mkdtempSync(join(tmpdir(), "lvis-permission-audit-"))),
      getPermissionAuditSecret: vi.fn(() => "secret"),
      getPermissionAuditSealStore: vi.fn(() => undefined),
    },
    toolRegistry: {
      setDenyRules: vi.fn(),
    },
    rewireReviewerAgent: vi.fn(),
    getAppWindows: vi.fn(() => appWindows),
  };
  return { deps, permissionManager, appWindows };
}

async function setup(options: Parameters<typeof makeDeps>[0] = {}) {
  handlers.clear();
  vi.clearAllMocks();
  const { deps, permissionManager, appWindows } = makeDeps(options);
  const { registerPermissionsHandlers } = await import("../permissions.js");
  registerPermissionsHandlers(deps as never);
  return { deps, permissionManager, appWindows };
}

beforeEach(() => {
  handlers.clear();
});

describe("permissions IPC handlers", () => {
  it("setMode routes through durable slash confirmation before persisting", async () => {
    const { deps, permissionManager } = await setup({ approvalChoice: "allow-once" });

    const result = await invoke(PERMISSIONS.setMode, { mode: "auto", intent: USER_INTENT });

    expect(result).toEqual({ ok: true, mode: "auto" });
    expect(deps.approvalGate.requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "/permission mode",
        args: expect.objectContaining({ fromMode: "default", toMode: "auto", durable: true }),
        trustOrigin: "user-keyboard",
      }),
    );
    expect(permissionManager.setModePersist).toHaveBeenCalledWith("auto");
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "mode_change", fromMode: "default", toMode: "auto", durable: true }),
    );
  });

  it("broadcasts successful durable mode changes to all app windows", async () => {
    const { appWindows } = await setup({ approvalChoice: "allow-once" });

    await invoke(PERMISSIONS.setMode, { mode: "auto", intent: USER_INTENT });

    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(PERMISSIONS.modeChanged, { mode: "auto" });
    }
  });

  it("setMode does not persist when durable confirmation is denied", async () => {
    const { permissionManager } = await setup({ approvalChoice: "deny-once" });

    const result = await invoke(PERMISSIONS.setMode, { mode: "strict", intent: USER_INTENT });

    expect(result).toMatchObject({ ok: false, error: "durable-mode-denied" });
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("setMode fails closed before persisting when permission audit append fails", async () => {
    const { permissionManager } = await setup({
      approvalChoice: "allow-once",
      auditAppendError: new Error("audit disk full"),
    });

    const result = await invoke(PERMISSIONS.setMode, { mode: "auto", intent: USER_INTENT });

    expect(result).toMatchObject({ ok: false, error: "permission-audit-write-failed" });
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("addRule and removeRule mutate only through parsed rule commands", async () => {
    const { deps, permissionManager } = await setup();

    await invoke(PERMISSIONS.addRule, {
      pattern: "write_file:path:/tmp/a.md",
      action: "allow",
      intent: USER_INTENT,
    });
    await invoke(PERMISSIONS.removeRule, {
      pattern: "write_file:path:/tmp/a.md",
      action: "allow",
      intent: USER_INTENT,
    });

    expect(permissionManager.addAlwaysAllowedPersist).toHaveBeenCalledWith("write_file:path:/tmp/a.md");
    expect(permissionManager.removeRule).toHaveBeenCalledWith("write_file:path:/tmp/a.md", "allow");
    expect(deps.toolRegistry.setDenyRules).toHaveBeenCalledTimes(2);
  });

  it("dirDispatch applies session additions returned by the slash command", async () => {
    const { deps } = await setup();
    const dir = mkdtempSync(join(tmpdir(), "lvis-session-dir-"));

    const result = await invoke(PERMISSIONS.dirDispatch, {
      rawArgs: `allow --session ${dir}`,
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: true, verb: "allow", sessionOnly: true });
    expect(deps.conversationLoop.addSessionAdditionalDirectory).toHaveBeenCalledWith(
      (result as { sessionDirectory: string }).sessionDirectory,
    );
  });

  it("permission mutations reject missing user-keyboard intent", async () => {
    await setup();

    const result = await invoke(PERMISSIONS.addRule, {
      pattern: "write_file:path:/tmp/a.md",
      action: "allow",
    });

    expect(result).toMatchObject({ ok: false, error: "user-keyboard-required" });
  });

  it("reviewerDispatch rejects invalid reviewer slash grammar without mutating local deps", async () => {
    const { permissionManager } = await setup();

    const result = await invoke(PERMISSIONS.reviewerDispatch, { rawArgs: "mode unknown" });

    expect(result).toMatchObject({ ok: false });
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("reviewerDispatch show does not rewire reviewer runtime", async () => {
    const { deps } = await setup();

    const result = await invoke(PERMISSIONS.reviewerDispatch, { rawArgs: "show" });

    expect(result).toMatchObject({ ok: true, verb: "show" });
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("reviewerDispatch rejects valid mutations without user-keyboard intent", async () => {
    const { deps } = await setup();

    const result = await invoke(PERMISSIONS.reviewerDispatch, { rawArgs: "mode rule" });

    expect(result).toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("reviewerDispatch restores reviewer settings when runtime rewire fails", async () => {
    const oldHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "lvis-reviewer-ipc-home-"));
    try {
      const { deps } = await setup();
      await invoke(PERMISSIONS.reviewerDispatch, {
        rawArgs: "mode rule",
        intent: USER_INTENT,
      });
      deps.rewireReviewerAgent.mockImplementation(() => {
        throw new Error("rewire failed");
      });

      const result = await invoke(PERMISSIONS.reviewerDispatch, {
        rawArgs: "mode llm",
        intent: USER_INTENT,
      });
      const current = await invoke(PERMISSIONS.reviewerDispatch, { rawArgs: "show" });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("reviewer-rewire-failed"),
      });
      expect(current).toMatchObject({
        ok: true,
        settings: expect.objectContaining({ mode: "rule" }),
      });
      expect(deps.rewireReviewerAgent).toHaveBeenCalledTimes(3);
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
    }
  });

  it("deferredResolve rejects missing user-keyboard intent before queue lookup", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => ({ ...entry, status: "approved", resolvedAt: "2026-05-10T00:00:01Z" })),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
    });

    expect(result).toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(queue.get).not.toHaveBeenCalled();
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it.each(["approved", "rejected"] as const)(
    "deferredResolve audits before queue mutation on %s",
    async (decision) => {
      const entry = makeDeferredEntry();
      const order: string[] = [];
      const queue = {
        get: vi.fn(() => entry),
        resolve: vi.fn(async (_id: string, status: string) => {
          order.push("resolve");
          return { ...entry, status, resolvedAt: "2026-05-10T00:00:01Z" };
        }),
      };
      const { deps } = await setup({ queue });
      deps.auditLogger.appendPermissionAuditEntry.mockImplementation(async (auditEntry: Record<string, unknown>) => {
        order.push("audit");
        return { ...auditEntry, prevHash: "h" };
      });

      const result = await invoke(PERMISSIONS.deferredResolve, {
        id: "deferred-1",
        decision,
        reason: "reviewed by user",
        intent: USER_INTENT,
      });

      expect(result).toMatchObject({
        ok: true,
        entry: expect.objectContaining({ id: "deferred-1", status: decision }),
      });
      expect(order).toEqual(["audit", "resolve"]);
      expect(queue.resolve).toHaveBeenCalledWith("deferred-1", decision, "reviewed by user");
      expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "deferred_resolve",
          resolution: decision,
          reason: "reviewed by user",
          queueId: "deferred-1",
          reviewerVerdict: entry.verdict,
        }),
      );
    },
  );

  it("deferredResolve fails closed before queue mutation when audit chain is not ready", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => ({ ...entry, status: "approved", resolvedAt: "2026-05-10T00:00:01Z" })),
    };
    const { deps } = await setup({ auditReady: false, queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      intent: USER_INTENT,
    });

    expect(result).toEqual({ ok: false, error: "permission-audit-not-ready" });
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("deferredResolve reports no queue without audit side effects", async () => {
    const { deps } = await setup({ queue: null });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "rejected",
      intent: USER_INTENT,
    });

    expect(result).toEqual({ ok: false, error: "no-deferred-queue" });
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("deferredResolve fails closed before queue mutation when audit append fails", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => ({ ...entry, status: "approved", resolvedAt: "2026-05-10T00:00:01Z" })),
    };
    const { deps } = await setup({
      queue,
      auditAppendError: new Error("audit write failed"),
    });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: false, error: "permission-audit-write-failed" });
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledOnce();
  });

  // ── Issue #690 P4 — approvalSource provenance in audit row ────────────
  // Round-1 test-engineer CRITICAL-1: end-to-end IPC → audit
  // integration assertion that the natural-language provenance reaches
  // the audit chain.
  it("deferredResolve records approvalSource='natural-language' in the audit entry", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({
        ...entry,
        status,
        resolvedAt: "2026-05-10T00:00:01Z",
      })),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      reason: "natural-language match: 허용해 주세요",
      approvalSource: "natural-language",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: true });
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deferred_resolve",
        resolution: "approved",
        approvalSource: "natural-language",
        queueId: "deferred-1",
      }),
    );
  });

  it("deferredResolve defaults approvalSource to 'button' when omitted (backward compat)", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({
        ...entry,
        status,
        resolvedAt: "2026-05-10T00:00:01Z",
      })),
    };
    const { deps } = await setup({ queue });

    await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      intent: USER_INTENT,
    });

    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalSource: "button",
      }),
    );
  });

  it("deferredResolve rejects an unknown approvalSource value as invalid-params", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => ({ ...entry, status: "approved" })),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "voice-assistant",
      intent: USER_INTENT,
    });

    expect(result).toEqual({ ok: false, error: "invalid-params" });
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });
});
