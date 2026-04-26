/**
 * Portions adapted from OpenHarness (MIT License)
 * Copyright (c) 2026 HKU Data Intelligence Lab
 *
 * ToolExecutor integration test — C1 regression.
 *
 * Scenario: the tool executor receives a tool_use for `read_file` with
 * a path that points at `~/.ssh/id_rsa`. Before C1 was wired, the
 * ApprovalRequest omitted `target.filePath`, so the §S1 sensitive-path
 * hard-block at approval-gate.ts never fired and the request went
 * straight to the user dialog. After C1:
 *
 *   1. Permission layer returns "ask"
 *   2. ToolExecutor populates target.filePath = /Users/.../.ssh/id_rsa
 *   3. ApprovalGate's §S1 canonicalizes + matches **\/.ssh/*
 *   4. Returns deny-once without calling webContents.send
 *
 * The assertion we need for C1 coverage: webContents.send was NOT
 * called, the tool execute() was NOT invoked, and the tool result is
 * an approval-denial error.
 */
import { describe, it, expect, vi } from "vitest";

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";

// ─── Helpers ─────────────────────────────────────────

function makeMockWebContents() {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

function makeReadFileTool(
  executeSpy: ReturnType<typeof vi.fn>,
): Tool {
  return createDynamicTool({
    name: "read_file",
    description: "Reads a file.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async (rawInput) => {
      const value = await executeSpy(rawInput);
      return { output: String(value), isError: false };
    },
  });
}

// ─── Tests ───────────────────────────────────────────

describe("ToolExecutor — C1 sensitive-path hard-block wiring", () => {
  it("tool_use read_file on ~/.ssh/id_rsa: approval-gate §S1 hard-blocks BEFORE dialog", async () => {
    // 1. Registry with a read_file tool that tracks whether it was invoked
    const executeSpy = vi.fn(async () => "file contents");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    // 2. Permission manager that forces "ask" for the test (simulates the
    //    path where the user has not yet granted or denied this tool).
    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.setRules([{ pattern: "read_file", action: "allow" }]);
    // ask-for-this-tool: override checkDetailed to force "ask"
    const originalCheck = permMgr.checkDetailed.bind(permMgr);
    permMgr.checkDetailed = (name: string, src, cat) => {
      if (name === "read_file") {
        return { decision: "ask", reason: "testing ask path", layer: 5 };
      }
      return originalCheck(name, src, cat);
    };

    // 3. ApprovalGate wired to a mock webContents
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    // 4. Executor with the gate plumbed in
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );

    // 5. Run a tool_use that targets a sensitive path
    const results = await executor.executeAll(
      [
        {
          id: "tu-1",
          name: "read_file",
          input: { path: "/Users/test/.ssh/id_rsa" },
        },
      ],
      undefined,
      "sess-c1",
    );

    // ── Assertions ──────────────────────────────────

    // tool itself was NEVER called — the hard-block fired
    expect(executeSpy).not.toHaveBeenCalled();

    // dialog was NEVER shown — webContents.send was not invoked for the
    // approval channel (the §S1 branch returns deny-once before send)
    expect(wc.send).not.toHaveBeenCalled();

    // user never interacted — no pending entries
    expect(gate.pendingCount).toBe(0);

    // result is an error surfaced to the LLM
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("승인 거부");
  });

  it("tool_use read_file on a non-sensitive path: reaches the dialog", async () => {
    // Sanity check — executor still routes non-sensitive paths to the
    // normal approval flow so the §S1 short-circuit didn't break the
    // happy path.
    const executeSpy = vi.fn(async () => "hello world");
    const registry = new ToolRegistry();
    registry.register(makeReadFileTool(executeSpy));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({
      decision: "ask",
      reason: "testing non-sensitive ask path",
      layer: 5,
    });

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );

    // Kick off the execution — it will hang until we resolve the gate.
    const promise = executor.executeAll(
      [
        {
          id: "tu-2",
          name: "read_file",
          input: { path: "/tmp/safe-file.txt" },
        },
      ],
      undefined,
      "sess-c1-sanity",
    );

    // Let the microtasks run so the send call happens
    await new Promise((r) => setImmediate(r));

    // For a non-sensitive path, read_file is in the READ_ONLY_TOOL_NAMES
    // set, so the §S4 short-circuit auto-approves and the tool executes
    // without ever showing a dialog. Therefore send should NOT have been
    // called, but the tool SHOULD have been invoked.
    expect(wc.send).not.toHaveBeenCalled();

    const results = await promise;
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(results[0].is_error).toBeUndefined();
    expect(results[0].content).toBe("hello world");
  });
});

// ─── D4 §4.5.3 — parallel tool approval ─────────────

/**
 * D4: When the LLM emits two tool_calls in one round, executeAll runs them
 * in parallel (Promise.all). Each call reaches the approval gate independently.
 * This test verifies:
 *   1. Both ApprovalGate.requestAndWait() calls are in-flight concurrently.
 *   2. Approving both (simulating "모두 허용") unblocks execution of both.
 *   3. Both tools execute and return results without error.
 *   4. Denying both (simulating "모두 거부") blocks both tools.
 */
describe("ToolExecutor — D4 parallel approval (§4.5.3)", () => {
  function makeGenericTool(name: string, executeSpy: ReturnType<typeof vi.fn>): import("../base.js").Tool {
    return createDynamicTool({
      name,
      description: `Generic tool ${name}`,
      source: "builtin",
      category: "write",
      isReadOnly: () => false,
      jsonSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
      execute: async (rawInput) => {
        const v = await executeSpy(rawInput);
        return { output: String(v), isError: false };
      },
    });
  }

  /**
   * Helper: wait until the gate has `count` pending entries, polling every
   * 10 ms up to `maxMs`. The gate's requestAndWait() is async so a single
   * setImmediate/tick is not always enough for two concurrent calls to both
   * reach the pending Map before we read pendingCount.
   */
  async function waitForPending(gate: ApprovalGate, count: number, maxMs = 2000) {
    const deadline = Date.now() + maxMs;
    while (gate.pendingCount < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * D2-aware helper: capture the full ApprovalRequest (incl. nonce+hmac) sent
   * via wc.send so we can echo them back in gate.resolve() correctly.
   */
  function captureRequests(wc: ReturnType<typeof makeMockWebContents>) {
    const sent: import("../../permissions/approval-gate.js").ApprovalRequest[] = [];
    (wc.send as ReturnType<typeof vi.fn>).mockImplementation(
      (_ch: string, req: import("../../permissions/approval-gate.js").ApprovalRequest) => {
        sent.push(req);
      },
    );
    return sent;
  }

  it("두 도구 동시 승인 → 두 도구 모두 실행됨", async () => {
    const spy1 = vi.fn(async () => "result-A");
    const spy2 = vi.fn(async () => "result-B");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_a", spy1));
    registry.register(makeGenericTool("tool_b", spy2));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "parallel test", layer: 5 });

    const wc = makeMockWebContents();
    const sent = captureRequests(wc);
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const execPromise = executor.executeAll(
      [
        { id: "par-1", name: "tool_a", input: { value: "x" } },
        { id: "par-2", name: "tool_b", input: { value: "y" } },
      ],
      undefined,
      "sess-d4-approve",
    );

    await waitForPending(gate, 2);
    expect(gate.pendingCount).toBe(2);

    // Echo nonce+hmac back so D2 HMAC validation passes
    for (const req of sent) {
      gate.resolve(req.id, { requestId: req.id, choice: "allow-once", nonce: req.nonce, hmac: req.hmac });
    }

    const results = await execPromise;

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.is_error)).toBe(true);
    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledTimes(1);
  }, 10000);

  it("두 도구 동시 거부 → 두 결과 모두 오류", async () => {
    const spy1 = vi.fn(async () => "should-not-run");
    const spy2 = vi.fn(async () => "should-not-run");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_c", spy1));
    registry.register(makeGenericTool("tool_d", spy2));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "parallel deny test", layer: 5 });

    const wc = makeMockWebContents();
    const sent = captureRequests(wc);
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const execPromise = executor.executeAll(
      [
        { id: "par-3", name: "tool_c", input: { value: "a" } },
        { id: "par-4", name: "tool_d", input: { value: "b" } },
      ],
      undefined,
      "sess-d4-deny",
    );

    await waitForPending(gate, 2);
    expect(gate.pendingCount).toBe(2);

    for (const req of sent) {
      gate.resolve(req.id, { requestId: req.id, choice: "deny-once", nonce: req.nonce, hmac: req.hmac });
    }

    const results = await execPromise;

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.is_error === true)).toBe(true);
    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
  }, 10000);

  it("선택적 승인 — 하나 허용, 하나 거부", async () => {
    const spyAllow = vi.fn(async () => "allowed-result");
    const spyDeny = vi.fn(async () => "denied-result");

    const registry = new ToolRegistry();
    registry.register(makeGenericTool("tool_e", spyAllow));
    registry.register(makeGenericTool("tool_f", spyDeny));

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.checkDetailed = () => ({ decision: "ask", reason: "selective test", layer: 5 });

    const wc = makeMockWebContents();
    const sent = captureRequests(wc);
    const gate = new ApprovalGate(wc as never);
    const executor = new ToolExecutor(registry, undefined, permMgr, undefined, gate);

    const execPromise = executor.executeAll(
      [
        { id: "par-5", name: "tool_e", input: { value: "x" } },
        { id: "par-6", name: "tool_f", input: { value: "y" } },
      ],
      undefined,
      "sess-d4-selective",
    );

    await waitForPending(gate, 2);

    const reqE = sent.find((r) => r.toolName === "tool_e")!;
    const reqF = sent.find((r) => r.toolName === "tool_f")!;

    gate.resolve(reqE.id, { requestId: reqE.id, choice: "allow-once", nonce: reqE.nonce, hmac: reqE.hmac });
    gate.resolve(reqF.id, { requestId: reqF.id, choice: "deny-once", nonce: reqF.nonce, hmac: reqF.hmac });

    const results = await execPromise;

    const rE = results.find((r) => r.tool_use_id === "par-5")!;
    const rF = results.find((r) => r.tool_use_id === "par-6")!;

    expect(rE.is_error).toBeUndefined();
    expect(rE.content).toBe("allowed-result");
    expect(spyAllow).toHaveBeenCalledTimes(1);

    expect(rF.is_error).toBe(true);
    expect(spyDeny).not.toHaveBeenCalled();
  }, 10000);
});

// ─── C1 regression — ask_user_question must NOT double-modal ──

describe("ToolExecutor — C1 ask_user_question short-circuit", () => {
  it("does NOT route ask_user_question through ApprovalGate", async () => {
    // Build a minimal registry containing the (builtin) ask_user_question
    // tool. The tool's execute is stubbed so we can observe whether the
    // executor reached it without ever consulting the approval gate.
    const innerExecuteSpy = vi.fn(async () => ({
      output: JSON.stringify({ choice: "yes", dismissed: false }),
      isError: false,
    }));
    const askTool = createDynamicTool({
      name: "ask_user_question",
      description: "ask the user",
      source: "builtin",
      // C2 / pre-fix: the tool was registered as `dangerous`, which forced
      // a permission check. The C1 short-circuit lives in the executor and
      // ignores PermissionManager entirely for this exact builtin name —
      // even with category "dangerous" the gate must not be consulted.
      category: "dangerous",
      jsonSchema: { type: "object", properties: {} },
      execute: innerExecuteSpy,
    });

    const registry = new ToolRegistry();
    registry.register(askTool);

    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    // PermissionManager would return "ask" if it ran. The C1 short-circuit
    // must skip it entirely so this checkDetailed should never be called.
    const checkSpy = vi.fn(() => ({
      decision: "ask" as const,
      reason: "should-not-be-called",
      layer: 5,
    }));
    permMgr.checkDetailed = checkSpy;

    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const requestSpy = vi.spyOn(gate, "requestAndWait");

    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );

    const results = await executor.executeAll(
      [
        {
          id: "tu-c1",
          name: "ask_user_question",
          input: { question: "Continue?" },
        },
      ],
      undefined,
      "sess-c1-double-modal",
    );

    // No approval modal should have been requested.
    expect(requestSpy).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
    // Nor should PermissionManager have been consulted.
    expect(checkSpy).not.toHaveBeenCalled();
    // The tool should still have run.
    expect(innerExecuteSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBeUndefined();
  });
});

// ─── R2-CR-4 regression — audit redaction must be source-gated ─────

describe("ToolExecutor — R2-CR-4 ask_user_question audit redaction is gated by source", () => {
  it("does NOT redact freeText when a non-builtin (plugin) tool happens to be named 'ask_user_question'", async () => {
    // A plugin or MCP tool may legitimately be named `ask_user_question` and
    // return a `freeText` field. Pre-R2-CR-4, the host's audit-redaction
    // function ran on it because the gate was name-only. Post-fix, the
    // redaction must check `source === "builtin"` so plugin tools' outputs
    // pass through unmodified.
    const pluginAskTool = createDynamicTool({
      name: "ask_user_question",
      description: "plugin tool with the same name",
      source: "plugin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({
        output: JSON.stringify({ freeText: "hello world" }),
        isError: false,
      }),
    });
    const registry = new ToolRegistry();
    registry.register(pluginAskTool);

    // Spy on AuditLogger.prototype.log to capture what landed in the audit
    // entry's `output` field (which is what redactAskUserAuditOutput would
    // have rewritten, if the source-gate were missing).
    const { AuditLogger: AL } = await import("../../audit/audit-logger.js");
    const logSpy = vi
      .spyOn(AL.prototype, "log")
      .mockImplementation(() => undefined);

    try {
      const executor = new ToolExecutor(registry);
      const results = await executor.executeAll(
        [{ id: "tu-r2cr4", name: "ask_user_question", input: {} }],
        undefined,
        "sess-r2cr4-plugin",
      );

      expect(results).toHaveLength(1);
      expect(results[0].is_error).toBeUndefined();

      // Find the tool_call audit entry for our test session
      const toolCallEntry = logSpy.mock.calls
        .map((c) => c[0] as { type?: string; output?: string; sessionId?: string })
        .find((e) => e.type === "tool_call" && e.sessionId === "sess-r2cr4-plugin");
      expect(toolCallEntry).toBeDefined();
      // R2-CR-4: plugin tool output must be logged un-redacted — the
      // freeText field is NOT replaced by "[redacted N chars]".
      expect(toolCallEntry!.output).toContain("hello world");
      expect(toolCallEntry!.output).not.toContain("[redacted");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("DOES redact freeText for the builtin ask_user_question (positive control)", async () => {
    const builtinAskTool = createDynamicTool({
      name: "ask_user_question",
      description: "builtin",
      source: "builtin",
      category: "dangerous",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({
        output: JSON.stringify({
          choice: "yes",
          freeText: "secret-content",
          dismissed: false,
        }),
        isError: false,
      }),
    });
    const registry = new ToolRegistry();
    registry.register(builtinAskTool);

    const { AuditLogger: AL } = await import("../../audit/audit-logger.js");
    const logSpy = vi
      .spyOn(AL.prototype, "log")
      .mockImplementation(() => undefined);

    try {
      const executor = new ToolExecutor(registry);
      await executor.executeAll(
        [{ id: "tu-r2cr4-b", name: "ask_user_question", input: {} }],
        undefined,
        "sess-r2cr4-builtin",
      );
      const toolCallEntry = logSpy.mock.calls
        .map((c) => c[0] as { type?: string; output?: string; sessionId?: string })
        .find((e) => e.type === "tool_call" && e.sessionId === "sess-r2cr4-builtin");
      expect(toolCallEntry).toBeDefined();
      // The builtin path must redact.
      expect(toolCallEntry!.output).not.toContain("secret-content");
      expect(toolCallEntry!.output).toContain("[redacted");
    } finally {
      logSpy.mockRestore();
    }
  });
});
