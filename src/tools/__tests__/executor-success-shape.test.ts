/**
 * C1 gap-lock — ToolExecutor.executeOne success-shape contract.
 *
 * Locks the shape of a ToolResult produced by a successful tool call as it
 * exists today: a plain read-only success omits `is_error`/`uiPayload`/
 * `rawResult` and always carries a numeric `durationMs`; a tool that returns
 * `metadata.uiPayload` / `metadata.rawResult` has those propagated onto the
 * result (and `uiPayload` handed to the `onToolEnd` callback).
 */
import { describe, expect, it, vi } from "vitest";

import { ToolExecutor, type ToolPermissionContext } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";

function userPermissionContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

describe("ToolExecutor.executeOne success shape", () => {
  it("binds the required conversation cwd into the shared tool execution context", async () => {
    const registry = new ToolRegistry();
    const executionCwd = "C:\\workspace\\agent-connector";
    let receivedCwd: string | undefined;
    let receivedAllowedDirectories: string[] | undefined;
    registry.register(createDynamicTool({
      name: "shape_cwd",
      description: "conversation cwd probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (_input, ctx) => {
        receivedCwd = ctx.cwd;
        receivedAllowedDirectories = ctx.extraAllowedDirectories;
        return { output: "ok", isError: false };
      },
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      new PermissionManager("/tmp/nonexistent-shape-cwd.json"),
    );

    const results = await executor.executeConversationTools(
      [{ id: "tu-shape-cwd", name: "shape_cwd", input: {} }],
      {
        executionCwd,
        sessionId: "sess-shape-cwd",
        permissionContext: userPermissionContext(),
      },
    );

    expect(results[0].content).toBe("ok");
    expect(receivedCwd).toBe(executionCwd);
    const normalizePath = (value: string) => value.replaceAll("\\", "/").toLowerCase();
    const normalizedAllowedDirectories = receivedAllowedDirectories?.map(normalizePath);
    expect(normalizedAllowedDirectories).toContain(normalizePath(executionCwd));
    expect(normalizedAllowedDirectories).not.toContain(normalizePath(process.cwd()));
  });

  it("read-only success returns { tool_use_id, content, durationMs } with no error/ui/raw fields", async () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "shape_read",
      description: "read-only shape probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "hello shape", isError: false }),
    }));
    const executor = new ToolExecutor(registry, undefined, new PermissionManager("/tmp/nonexistent-shape.json"));

    const results = await executor.executeAll(
      [{ id: "tu-shape-1", name: "shape_read", input: {} }],
      { sessionId: "sess-shape", permissionContext: userPermissionContext() },
    );

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.tool_use_id).toBe("tu-shape-1");
    expect(r.content).toBe("hello shape");
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    // Success omits these keys entirely (not just undefined values).
    expect(Object.prototype.hasOwnProperty.call(r, "is_error")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(r, "uiPayload")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(r, "rawResult")).toBe(false);
  });

  it("propagates metadata.uiPayload and metadata.rawResult onto the result and into onToolEnd", async () => {
    const uiPayload = { type: "html", html: "<div>ok</div>" };
    const rawResult = { records: [1, 2, 3] };
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "shape_ui",
      description: "uiPayload/rawResult shape probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({
        output: "rendered",
        isError: false,
        metadata: { uiPayload, rawResult },
      }),
    }));
    const executor = new ToolExecutor(registry, undefined, new PermissionManager("/tmp/nonexistent-shape2.json"));

    const onToolEnd = vi.fn();
    const results = await executor.executeAll(
      [{ id: "tu-shape-2", name: "shape_ui", input: {} }],
      {
        sessionId: "sess-shape-ui",
        callbacks: { onToolEnd },
        permissionContext: userPermissionContext(),
      },
    );

    const r = results[0];
    expect(r.content).toBe("rendered");
    expect(r.uiPayload).toEqual(uiPayload);
    expect(r.rawResult).toEqual(rawResult);
    expect(r.is_error).toBeUndefined();
    // onToolEnd(name, content, isError, meta, uiPayload, durationMs)
    const call = onToolEnd.mock.calls.at(-1);
    expect(call?.[0]).toBe("shape_ui");
    expect(call?.[2]).toBe(false);
    expect(call?.[4]).toEqual(uiPayload);
    expect(typeof call?.[5]).toBe("number");
  });
});
