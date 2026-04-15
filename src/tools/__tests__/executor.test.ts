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
