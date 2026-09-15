/**
 * End-to-end integration coverage for the foreground modal-skip via
 * explicit-approval memory (Store B).
 *
 * Unlike the sibling unit suite (executor-approval-memory-skip.test.ts) these
 * tests do NOT stub `PermissionManager.checkDetailed` and do NOT mock the
 * user-approval store or the audit sink. They drive a REAL PermissionManager
 * plus the REAL user-approval store (isolated via LVIS_HOME) so the layer
 * contract is pinned end-to-end:
 *
 *   (a) a deny rule wins over a prior approval — Store B is never consulted
 *       (Layer 1 hard gate).
 *   (b) an overlay-trigger mutating ask + a prior approval still shows the
 *       modal — Store B is never consulted (Layer 2 hard gate). The global
 *       strict-mode variant is asserted the same way.
 *   (c) a persistent-scope approval recorded through the real store skips the
 *       modal on the next identical invocation (Layer 6 normal ask).
 *   (d) an approval recorded under one (trustOrigin, approvalCacheKey) does
 *       NOT match a lookup with a different key dimension — the modal is shown
 *       (the cache key dimensions are load-bearing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor } from "../executor.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { ToolRegistry } from "../registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import {
  recordApproval,
  __resetSessionStoreForTest,
  captureApprovalWorkingDirectory,
} from "../../permissions/user-approval-store.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { makeWriteProbeTool } from "./approval-memory-test-fixtures.js";
import { approvalCacheKeyFor } from "../pipeline/display-mask.js";
import { WriteFileTool } from "../file-tools.js";
import { createDynamicTool } from "../base.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";

describe("ToolExecutor — Store B memory skip end-to-end (real PermissionManager + real store)", () => {
  let dir: string;
  let lvisHomeDir: string;
  let prevLvisHome: string | undefined;
  let auditLogger: AuditLogger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lvis-memory-skip-e2e-"));
    lvisHomeDir = mkdtempSync(join(tmpdir(), "lvis-home-e2e-"));
    prevLvisHome = process.env.LVIS_HOME;
    process.env.LVIS_HOME = lvisHomeDir;
    __resetSessionStoreForTest();
    // OWN the audit logger rather than letting `ToolExecutor` construct one.
    //
    // `auditLogger` is the SEVENTH constructor parameter and these tests pass five, so
    // without this every executor built its own `new AuditLogger()` rooted at
    // `join(lvisHome(), "audit")` — i.e. inside `lvisHomeDir`. `AuditLogger.log()` returns
    // `void` and only enqueues (`audit-logger.ts:567` → `enqueuePlainWrite`), the tail is
    // awaited by nothing but `flush()`, and the permission path logs on EVERY invocation
    // including denials. That is the writer that actually raced `rmSync(lvisHomeDir)`.
    auditLogger = new AuditLogger(join(lvisHomeDir, "audit"));
  });

  afterEach(async () => {
    // Flush the audit writer FIRST — it is the only thing here that outlives its caller.
    //
    // An earlier version of this teardown drained the approval store instead and claimed
    // `recordApproval` "resolves when the write is QUEUED". That is FALSE, and a reviewer
    // demonstrated it: `mutatePersistentApprovals` RETURNS the promise covering
    // `readApprovalsFile → mutator → atomicWrite` (`user-approval-store.ts:214-224`) and
    // `recordApproval` awaits it, so an awaited `recordApproval` has already landed. All
    // five calls in this file are awaited, so the approval queue was never the racer and the
    // drain was a no-op.
    //
    // WHY THAT NO-OP COINCIDED WITH CI GOING GREEN IS NOT ESTABLISHED. A previous version of
    // this comment asserted the drain bought time by inserting an `await` — a timing yield
    // letting the audit writer finish. A reviewer disproved it and the experiment reproduces
    // here: firing an unawaited `appendFile`, then awaiting a settled promise, then ten
    // microtask ticks, leaves the write NOT landed; only a `setTimeout(0)` macrotask lets it
    // land. The drain awaited an already-settled queue, which is microtasks only, so it cannot
    // have given a threadpool write time to complete. The race is timing-dependent and that
    // particular run's outcome is unexplained. Saying otherwise teaches "add an `await` before
    // `rmSync`", which is the class of no-op fix the drain removal exists to discourage.
    await auditLogger.close();
    // Safe only because the flush above has completed: with nothing in flight, reverting
    // `LVIS_HOME` cannot redirect a pending write at the real home.
    if (prevLvisHome === undefined) delete process.env.LVIS_HOME;
    else process.env.LVIS_HOME = prevLvisHome;
    __resetSessionStoreForTest();
    await cleanupTmpDir(dir);
    await cleanupTmpDir(lvisHomeDir);
  });

  it("(a) deny rule wins over a prior approval — Layer 1, Store B never consulted", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.setRules([{ pattern: "write_probe", action: "deny" }]);

    // A matching prior approval exists — it must be ignored under a deny.
    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "session", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
    );

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real
      // `lvisHome()`; see the note in `beforeEach`.
      auditLogger,
    );

    const result = await executor.executeAll(
      [{ id: "tu-deny", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-deny",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    // Deny short-circuits at Layer 1 — the modal is never reached.
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("(b) overlay-trigger mutating ask + prior approval → modal shown — Layer 2 hard gate", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));

    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "session", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
    );

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
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real
      // `lvisHome()`; see the note in `beforeEach`.
      auditLogger,
    );

    const result = await executor.executeAll(
      [{ id: "tu-overlay", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-overlay",
        executionCwd: dir,
        // Overlay trigger forces a Layer 2 ask for mutating tools.
        overlayTriggerOrigin: "overlay:meeting-detection",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ durableApprovalRecordAllowed: false }));
    // Layer 2 hard gate is never memory-skipped — modal shown, tool denied.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("(b') global strict mode + prior approval → modal shown — Layer 2 hard gate", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.setMode("strict");

    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "session", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
    );

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
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real
      // `lvisHome()`; see the note in `beforeEach`.
      auditLogger,
    );

    const result = await executor.executeAll(
      [{ id: "tu-strict", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-strict",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("(c) persistent-scope approval recorded via the real store skips the modal on re-call", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    // Default mode + builtin write → Layer 6 normal ask (no reviewer route),
    // which is the lane eligible for the Store B skip.
    const permMgr = new PermissionManager(join(dir, "permissions.json"));

    // Record a PERSISTENT approval for the exact tuple the executor will look up.
    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "persistent", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
    );

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real
      // `lvisHome()`; see the note in `beforeEach`.
      auditLogger,
    );

    const result = await executor.executeAll(
      [{ id: "tu-persist", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-persist",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Memory hit — modal skipped, tool executed.
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBeUndefined();
  });

  it("(d) approval under a different (trustOrigin, approvalCacheKey) does NOT match — modal shown", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));

    // Recorded under approvalCacheKey "key-A". The invocation below carries no
    // approvalCacheKey and trustOrigin "user-keyboard", so the derived key
    // differs → lookup misses → modal shown.
    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      {
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        trustOrigin: "user-keyboard",
        approvalCacheKey: "key-A",
      },
    );

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
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real
      // `lvisHome()`; see the note in `beforeEach`.
      auditLogger,
    );

    const result = await executor.executeAll(
      // No approvalCacheKey on this invocation → key mismatch vs the stored entry.
      [{ id: "tu-keymiss", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-keymiss",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Key dimensions are load-bearing — a mismatch is a miss → modal shown.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it.each(["printf hello", "inspect_local_fixture"])("reuses unassessed %s in the same directory and asks for a different directory or input", async (command) => {
    const otherDir = join(dir, "other-project");
    mkdirSync(otherDir);
    const execute = vi.fn(async () => ({ output: "hello", isError: false }));
    const tool = createDynamicTool({
      name: "shell_probe", description: "shell probe", source: "builtin", category: "shell",
      jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute,
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setMode("auto");
    manager.setInteractiveAutoApprove("low");
    const cards: ApprovalRequest[] = [];
    const recordings: Promise<void>[] = [];
    const gate = new ApprovalGate({
      isDestroyed: () => false,
      send: (channel: string, request: ApprovalRequest) => {
        if (channel !== "lvis:approval:request") return;
        cards.push(request);
        recordings.push((async () => {
          const snapshot = gate.getRequestSnapshot(request.id)!;
          expect(snapshot.persistentAllowAllowed).toBe(true);
          expect(snapshot.verdictAtApproval).toBe("high");
          await recordApproval(snapshot.toolName, canonicalStringify(snapshot.args), snapshot.source, {
            scope: "persistent", verdictAtApproval: snapshot.verdictAtApproval, nlJustification: null,
            trustOrigin: snapshot.trustOrigin, approvalCacheKey: snapshot.approvalCacheKey,
            workingDirectoryIdentity: snapshot.workingDirectoryIdentity, riskCeilingAtApproval: snapshot.riskCeilingAtApproval,
          });
          gate.resolveFromDesktopRenderer(request.id, {
            requestId: request.id, choice: "allow-always", nonce: request.nonce, hmac: request.hmac,
          });
        })());
      },
    } as never);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, auditLogger);
    const run = (id: string, cwd: string, nextCommand = command) => executor.executeAll(
      [{ id, name: tool.name, input: { command: nextCommand } }],
      { sessionId: "unavailable-reviewer", executionCwd: cwd, permissionContext: userPermissionContext({ additionalDirectories: [dir] }) },
    );
    expect((await run("first", dir))[0].is_error).toBeUndefined();
    expect(cards).toHaveLength(1);
    __resetSessionStoreForTest();
    expect((await run("repeat", dir))[0].is_error).toBeUndefined();
    expect(cards).toHaveLength(1);
    expect((await run("other-project", otherDir))[0].is_error).toBeUndefined();
    expect(cards).toHaveLength(2);
    expect((await run("changed-input", dir, "printf changed"))[0].is_error).toBeUndefined();
    expect(cards).toHaveLength(3);
    await Promise.all(recordings);
    expect(execute).toHaveBeenCalledTimes(4);
  });
  it("preserves a path-specific policy deny without widening the tool key", async () => {
    const tool = new WriteFileTool();
    const input = { path: join(dir, "blocked.txt"), content: "must not write" };
    const key = approvalCacheKeyFor(tool, input, dir)!;
    expect(key).toBe("write_file:path:" + input.path);
    const registry = new ToolRegistry();
    registry.register(tool);
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setRules([{ pattern: key, action: "deny" }]);
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, auditLogger);
    const result = await executor.executeAll([{ id: "exact-policy-deny", name: tool.name, input }], {
      executionCwd: dir, permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
    });
    expect(result[0].is_error).toBe(true);
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it.each(["riskCeilingAtApproval", "verdictAtApproval"])("rejects malformed persisted %s before foreground reuse", async (field) => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));
    const manager = new PermissionManager(join(dir, "permissions.json"));
    const disclose = vi.fn();
    manager.setBroadcastUserApprovalHit(disclose);
    const input = { path: join(dir, "file.txt") };
    await recordApproval("write_probe", canonicalStringify(input), "builtin", {
      scope: "persistent", verdictAtApproval: "high", riskCeilingAtApproval: "low", nlJustification: null,
      trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity,
    });
    const storePath = join(lvisHomeDir, "permissions", "user-approvals.json");
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    (Object.values(stored.approvals)[0] as Record<string, unknown>)[field] = "invalid";
    await writeFile(storePath, JSON.stringify(stored));
    __resetSessionStoreForTest();
    const requestAndWait = vi.fn(async (request: { id: string }) => ({ requestId: request.id, choice: "deny-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, auditLogger);
    const result = await executor.executeAll([{ id: "malformed", name: "write_probe", input }], {
      executionCwd: dir, permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
    });
    expect(result[0].is_error).toBe(true);
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(disclose).not.toHaveBeenCalled();
  });

});
