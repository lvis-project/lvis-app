/**
 * C1 gap-lock — ToolExecutor.executeOne success-shape contract.
 *
 * Locks the shape of a ToolResult produced by a successful tool call as it
 * exists today: a plain read-only success omits `is_error`/`uiPayload`/
 * `rawResult` and always carries a numeric `durationMs`; a tool that returns
 * `metadata.uiPayload` / `metadata.rawResult` has those propagated onto the
 * result (and `uiPayload` handed to the `onToolEnd` callback).
 */
import { resolve } from "node:path";
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
    const executionCwd = resolve("test-fixtures", "agent-connector");
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

  it("inherits the outer conversation cwd across a re-entrant executor call", async () => {
    const executionCwd = resolve("test-fixtures", "nested-agent-connector");
    let innerCwd: string | undefined;
    let innerAllowedDirectories: string[] | undefined;

    const innerRegistry = new ToolRegistry();
    innerRegistry.register(createDynamicTool({
      name: "shape_inner_cwd",
      description: "nested cwd probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async (_input, ctx) => {
        innerCwd = ctx.cwd;
        innerAllowedDirectories = ctx.extraAllowedDirectories;
        return { output: "inner-ok", isError: false };
      },
    }));
    const innerExecutor = new ToolExecutor(
      innerRegistry,
      undefined,
      new PermissionManager("/tmp/nonexistent-shape-inner-cwd.json"),
    );

    const outerRegistry = new ToolRegistry();
    outerRegistry.register(createDynamicTool({
      name: "shape_outer_cwd",
      description: "nested executor wrapper",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => {
        const [inner] = await innerExecutor.executeAll(
          [{ id: "tu-shape-inner", name: "shape_inner_cwd", input: {} }],
          { permissionContext: userPermissionContext() },
        );
        return { output: inner.content, isError: inner.is_error === true };
      },
    }));
    const outerExecutor = new ToolExecutor(
      outerRegistry,
      undefined,
      new PermissionManager("/tmp/nonexistent-shape-outer-cwd.json"),
    );

    const [result] = await outerExecutor.executeConversationTools(
      [{ id: "tu-shape-outer", name: "shape_outer_cwd", input: {} }],
      {
        executionCwd,
        sessionId: "sess-shape-nested-cwd",
        permissionContext: userPermissionContext(),
      },
    );

    expect(result.content).toBe("inner-ok");
    expect(innerCwd).toBe(executionCwd);
    const normalizePath = (value: string) => value.replaceAll("\\", "/").toLowerCase();
    expect(innerAllowedDirectories?.map(normalizePath)).toContain(normalizePath(executionCwd));
  });

  it("isolates concurrent re-entrant cwd chains", async () => {
    const observed = new Map<string, string>();
    const innerRegistry = new ToolRegistry();
    innerRegistry.register(createDynamicTool({
      name: "shape_concurrent_inner",
      description: "concurrent nested cwd probe",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: { key: { type: "string" } } },
      execute: async (input, ctx) => {
        observed.set(String(input.key), ctx.cwd);
        return { output: "ok", isError: false };
      },
    }));
    const innerExecutor = new ToolExecutor(
      innerRegistry,
      undefined,
      new PermissionManager("/tmp/nonexistent-shape-concurrent-inner.json"),
    );

    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolveStarted) => {
      release = resolveStarted;
    });
    const outerRegistry = new ToolRegistry();
    outerRegistry.register(createDynamicTool({
      name: "shape_concurrent_outer",
      description: "concurrent nested executor wrapper",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: { key: { type: "string" } } },
      execute: async (input) => {
        started += 1;
        if (started === 2) release();
        await bothStarted;
        const [inner] = await innerExecutor.executeAll(
          [{
            id: `tu-concurrent-inner-${String(input.key)}`,
            name: "shape_concurrent_inner",
            input,
          }],
          { permissionContext: userPermissionContext() },
        );
        return { output: inner.content, isError: inner.is_error === true };
      },
    }));
    const outerExecutor = new ToolExecutor(
      outerRegistry,
      undefined,
      new PermissionManager("/tmp/nonexistent-shape-concurrent-outer.json"),
    );
    const cwdA = resolve("test-fixtures", "project-a");
    const cwdB = resolve("test-fixtures", "project-b");

    await Promise.all([
      outerExecutor.executeConversationTools(
        [{ id: "tu-concurrent-outer-a", name: "shape_concurrent_outer", input: { key: "a" } }],
        { executionCwd: cwdA, permissionContext: userPermissionContext() },
      ),
      outerExecutor.executeConversationTools(
        [{ id: "tu-concurrent-outer-b", name: "shape_concurrent_outer", input: { key: "b" } }],
        { executionCwd: cwdB, permissionContext: userPermissionContext() },
      ),
    ]);

    expect(observed).toEqual(new Map([
      ["a", cwdA],
      ["b", cwdB],
    ]));
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
