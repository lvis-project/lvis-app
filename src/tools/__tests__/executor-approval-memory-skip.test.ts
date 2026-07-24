/**
 * Foreground modal-skip via explicit-approval memory (Store B).
 *
 * Root cause this guards: approving with "allow this session" recorded the
 * decision in Store B (the exact-tuple user-approval memory) but the
 * foreground ask path never READ Store B — only the reviewer lane did. So
 * the modal kept reappearing on the next call with the same args.
 *
 * ToolExecutor.tryUserApprovalMemorySkip now mirrors the reviewer lane's
 * lookup at the foreground choke point. These tests pin:
 *   (a) session approval → same tuple re-call skips the modal + emits an
 *       audit entry with userApprovalUsed.memoryHit === true
 *   (b) session approval but args mutated to a higher rule verdict
 *       (maxVerdict escalation) → re-prompt
 *   (c) revoked entry (lookup returns null) → re-prompt
 *   (d) legacy-null verdictAtApproval → re-prompt (fail-closed)
 *   (e) deny rule + prior approval → deny wins (Store B never consulted)
 *   (f) overlay-trigger mutating + prior approval → ask wins (layer 2 hard
 *       gate is never memory-skipped)
 *   (g) headless path is unchanged — Store B is foreground-only
 *   (h) plugin panel user action suppresses the normal agent approval modal
 *       for foreground plugin asks, while hard/forceModal asks still prompt
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWriteProbeTool } from "./approval-memory-test-fixtures.js";

// Store B lookup + audit sink — shaped per-test. vi.mock factories are
// hoisted above all imports, so the mock fns must be created via vi.hoisted
// (which runs even earlier) to be referenceable inside the factories.
const { lookupApprovalMock, emitSandboxAuditMock, state } = vi.hoisted(() => ({
  lookupApprovalMock: vi.fn(async (): Promise<unknown> => state.lookupResult),
  emitSandboxAuditMock: vi.fn(async () => {}),
  state: { lookupResult: null as unknown },
}));

vi.mock("../../permissions/user-approval-store.js", async () => {
  const actual: typeof import("../../permissions/user-approval-store.js") =
    await vi.importActual("../../permissions/user-approval-store.js");
  return {
    ...actual,
    lookupApproval: lookupApprovalMock,
  };
});

vi.mock("../../audit/sandbox-audit-sink.js", async () => {
  const actual: typeof import("../../audit/sandbox-audit-sink.js") =
    await vi.importActual("../../audit/sandbox-audit-sink.js");
  return {
    ...actual,
    emitSandboxAudit: emitSandboxAuditMock,
  };
});

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { tryUserApprovalMemorySkip } from "../pipeline/approval-memory-skip.js";

function userPermissionContext(
  overrides: Partial<import("../executor.js").ToolPermissionContext> = {},
): import("../executor.js").ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

/** A permission manager whose checkDetailed returns a fixed result. */
function pmReturning(result: ReturnType<PermissionManager["checkDetailed"]>): PermissionManager {
  const pm = new PermissionManager("/tmp/nonexistent-permissions-memory-skip.json");
  pm.checkDetailed = () => result;
  return pm;
}

describe("ToolExecutor — explicit-approval memory skips the foreground modal (Store B)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lvis-memory-skip-"));
    state.lookupResult = null;
    lookupApprovalMock.mockClear();
    emitSandboxAuditMock.mockClear();
  });

  it("(a) session approval → same tuple re-call skips the modal and audits memoryHit", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    // Normal foreground ask (layer 6) — eligible for Store B skip.
    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });

    // Path is a direct LEAF of the allowed dir → rule verdict LOW.
    // Stored verdict LOW → max(LOW, LOW) === LOW === stored → skip.
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-skip", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-skip",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Modal NOT shown — memory hit auto-allowed and the tool executed.
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBeUndefined();

    // Audit entry records the memory-hit provenance.
    expect(emitSandboxAuditMock).toHaveBeenCalled();
    const entry = emitSandboxAuditMock.mock.calls[0]?.[0] as unknown as {
      reviewer: {
        llmVerdict: string | null;
        userApprovalUsed: { memoryHit: boolean; verdictAtApproval: string | null } | null;
      };
      tool: { name: string };
    };
    expect(entry.tool.name).toBe("write_probe");
    expect(entry.reviewer.llmVerdict).toBeNull();
    expect(entry.reviewer.userApprovalUsed?.memoryHit).toBe(true);
    expect(entry.reviewer.userApprovalUsed?.verdictAtApproval).toBe("low");
  });

  it("approval-memory audit persists the Host-owned governed projection", async () => {
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "high",
      nlJustification: null,
      revokedAt: null,
    };

    const result = await tryUserApprovalMemorySkip(
      "plugin_attendance_read",
      "plugin",
      "read",
      [],
      {
        operation: "status",
        opaqueSecret: "must-never-reach-audit",
      },
      [],
      [],
      userPermissionContext({ trustOrigin: "plugin-emitted" }),
      undefined,
      {},
      undefined,
      undefined,
      "com.lvis.attendance",
      undefined,
      { operation: "status" },
    );

    expect(result?.decision).toBe("allow");
    const entry = emitSandboxAuditMock.mock.calls.at(-1)?.[0] as unknown as
      | { tool: { args: string } }
      | undefined;
    expect(entry?.tool.args).toBe('{"operation":"status"}');
    expect(entry?.tool.args).not.toContain("must-never-reach-audit");
  });

  it("(a2) foreground-auto reviewer path checks Store B before reviewer dispatch", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({
      decision: "ask",
      reason: "foreground reviewer route",
      layer: 6,
      reviewer: { route: "foreground-auto" },
    });
    const classifySpy = vi.fn(() => ({ level: "high" as const, reason: "should not run" }));
    permMgr.setReviewer({
      classifier: { classify: classifySpy },
      cache: {} as never,
      deferredQueue: {} as never,
    });
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-foreground-auto-skip", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-foreground-auto-skip",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(result[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(classifySpy).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("(b) prior approval but args mutated to a higher rule verdict → re-prompt (maxVerdict)", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });

    // Stored LOW. Current path is DEEP inside the allowed dir → rule MEDIUM.
    // max(MEDIUM, LOW) === MEDIUM !== stored LOW → escalation → re-prompt.
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-escalate", name: "write_probe", input: { path: join(dir, "nested", "deep", "file.txt") } }],
      {
        sessionId: "sess-escalate",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Modal IS shown (escalation) — and we denied it, so the tool did not run.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result[0].is_error).toBe(true);
  });

  it("(c) revoked / absent approval (lookup null) → re-prompt", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });

    // lookupApproval returns null for revoked or missing entries.
    state.lookupResult = null;

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    await executor.executeAll(
      [{ id: "tu-revoked", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-revoked",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledTimes(1);
  });

  it("(d) legacy-null verdictAtApproval → re-prompt (fail-closed)", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Legacy entry — verdictAtApproval is null (provenance lost).
    state.lookupResult = {
      scope: "persistent",
      verdictAtApproval: null,
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    await executor.executeAll(
      [{ id: "tu-legacy-null", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-legacy-null",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Modal shown — legacy entry rejected. Stable structured marker emitted.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    const legacyCall = warnSpy.mock.calls.find((args: unknown[]) => {
      const marker = args[1];
      return (
        marker != null &&
        typeof marker === "object" &&
        (marker as { event?: unknown }).event === "legacy-null-verdict"
      );
    });
    expect(legacyCall).toBeDefined();
    warnSpy.mockRestore();
  });

  it("(e) deny rule + prior approval → deny wins, Store B never consulted", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    // Layer 1 deny rule.
    const permMgr = pmReturning({ decision: "deny", reason: "deny rule", layer: 1 });

    // A matching prior approval exists — it must be IGNORED.
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-deny", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-deny",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    // Store B must not even be queried for a deny decision.
    expect(lookupApprovalMock).not.toHaveBeenCalled();
  });

  it("(f) overlay-trigger mutating + prior approval → ask wins (layer 2 hard gate not skipped)", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    // Overlay-trigger mutating guard returns ask at layer 2 (hard gate).
    const permMgr = pmReturning({
      decision: "ask",
      reason: "overlay trigger mutating",
      layer: 2,
    });

    // A matching prior approval exists — it must NOT skip the hard-ask gate.
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-overlay", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-overlay",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Modal shown — layer 2 hard gate is never memory-skipped.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    // Store B must not be consulted for a layer <= 2 hard gate.
    expect(lookupApprovalMock).not.toHaveBeenCalled();
  });

  it("(g) headless path is unchanged — Store B is foreground-only", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    // Normal foreground-eligible ask (layer 6) but headless context.
    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });

    // A matching prior approval exists — headless must not read it.
    state.lookupResult = {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-headless", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-headless",
        permissionContext: userPermissionContext({ headless: true, trustOrigin: "llm-tool-arg" }),
      },
    );

    // Headless ask with no headless reviewer route → blocked, tool not run.
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    // Store B is foreground-only — never consulted on the headless path.
    expect(lookupApprovalMock).not.toHaveBeenCalled();
  });

  it("(h) plugin panel user action suppresses normal foreground plugin ask", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy, { source: "plugin", pluginId: "meeting" }));

    const permMgr = pmReturning({ decision: "ask", reason: "needs confirm", layer: 6 });
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-plugin-panel", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-plugin-panel",
        permissionContext: userPermissionContext({
          additionalDirectories: [dir],
          pluginPanelUserAction: true,
          trustOrigin: "plugin-emitted",
        }),
      },
    );

    expect(result[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(lookupApprovalMock).not.toHaveBeenCalled();
  });

  it("(h2) plugin panel user action does not suppress layer-2 hard asks", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy, { source: "plugin", pluginId: "meeting" }));

    const permMgr = pmReturning({ decision: "ask", reason: "hard gate", layer: 2 });
    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-plugin-panel-hard", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-plugin-panel-hard",
        permissionContext: userPermissionContext({
          additionalDirectories: [dir],
          pluginPanelUserAction: true,
          trustOrigin: "plugin-emitted",
        }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result[0].is_error).toBe(true);
  });

  it("(h3) plugin panel user action does not suppress forceModal asks", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy, { source: "plugin", pluginId: "meeting" }));

    const permMgr = pmReturning({
      decision: "ask",
      reason: "explicit per-invocation confirmation",
      layer: 6,
      forceModal: true,
    });
    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "tu-plugin-panel-force", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-plugin-panel-force",
        permissionContext: userPermissionContext({
          additionalDirectories: [dir],
          pluginPanelUserAction: true,
          trustOrigin: "plugin-emitted",
        }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result[0].is_error).toBe(true);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
