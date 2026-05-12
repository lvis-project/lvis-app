/**
 * plugin-runtime.test.ts
 *
 * Unit tests for extracted helpers from plugin-runtime.ts.
 * These avoid wiring the full initPluginRuntime context.
 *
 * Group C — auditApprovalViolation: audit-logger try-catch swallow
 *   Verifies AC1.5: if bootAuditLogger.log() throws, that error is swallowed
 *   and the original ApprovalOriginError is still re-thrown to the caller.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";

const runtimeTestState = vi.hoisted(() => ({
  appPrependOnceListener: vi.fn(),
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  runtime: {
    startAll: vi.fn(async () => {}),
    listToolNames: vi.fn(() => [] as string[]),
    listPluginIds: vi.fn(() => [] as string[]),
    listPluginManifests: vi.fn(() => [] as Array<{ pluginId: string; manifest: unknown }>),
    getPluginRoot: vi.fn((pluginId: string) => `/tmp/lvis-test/plugins/${pluginId}`),
    getPluginManifest: vi.fn(() => null),
    registerDisposer: vi.fn(),
    assertPluginToolAccess: vi.fn(),
    resolveToolOwner: vi.fn((toolName: string) => `${toolName}-owner`),
  },
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/lvis-test"),
    isPackaged: false,
    prependOnceListener: runtimeTestState.appPrependOnceListener,
  },
  BrowserWindow: vi.fn(),
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock("../../../plugins/runtime.js", () => ({
  PluginRuntime: vi.fn().mockImplementation((options: Record<string, unknown>) => {
    runtimeTestState.capturedRuntimeOptions = options;
    return runtimeTestState.runtime;
  }),
}));

vi.mock("../../../plugins/dev-watcher.js", () => ({
  startPluginDevWatcher: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../../../main/html-preview-partition.js", () => ({
  installPluginPartitionPolicy: vi.fn(),
}));

vi.mock("../../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/lvis-test/plugins",
    registryPath: "/tmp/lvis-test/registry.json",
    cacheRoot: "/tmp/lvis-test/cache",
  })),
}));

import {
  auditApprovalViolation,
  formatPluginPendingPrompt,
  initPluginRuntime,
  sanitizePluginPendingPrompt,
} from "../plugin-runtime.js";
import { ApprovalOriginError } from "../../../permissions/agent-action-requester.js";

describe("auditApprovalViolation (Group C — audit logger try-catch swallow)", () => {
  it("re-throws the original ApprovalOriginError even when auditLogger.log throws", () => {
    const brokenLogger = { log: vi.fn(() => { throw new Error("audit broken"); }) };
    const originError = new ApprovalOriginError(
      "[cross-plugin-hijack] plugin='evil' requestId='req-1' ...",
      "cross-plugin-hijack",
    );

    expect(() =>
      auditApprovalViolation(originError, brokenLogger, "evil", "req-1"),
    ).toThrow(originError);

    // Audit was attempted (even though it threw)
    expect(brokenLogger.log).toHaveBeenCalledOnce();
  });

  it("re-throws the original error when audit succeeds", () => {
    const okLogger = { log: vi.fn() };
    const originError = new ApprovalOriginError(
      "scope not allowed",
      "scope-not-allowed",
    );

    expect(() =>
      auditApprovalViolation(originError, okLogger, "plugin-a", "req-2"),
    ).toThrow(originError);

    expect(okLogger.log).toHaveBeenCalledOnce();
    const entry = okLogger.log.mock.calls[0][0] as { type: string; input: string };
    expect(entry.type).toBe("error");
    expect(entry.input).toContain("[scope-not-allowed]");
    expect(entry.input).toContain("plugin='plugin-a'");
    expect(entry.input).toContain("requestId='req-2'");
  });

  it("re-throws unknown (non-ApprovalOriginError) errors and still swallows audit crash", () => {
    const brokenLogger = { log: vi.fn(() => { throw new Error("audit down"); }) };
    const unexpectedErr = new Error("unexpected gate error");

    expect(() =>
      auditApprovalViolation(unexpectedErr, brokenLogger, "plugin-b", "req-3"),
    ).toThrow(unexpectedErr);

    expect(brokenLogger.log).toHaveBeenCalledOnce();
  });
});

describe("sanitizePluginPendingPrompt", () => {
  it("strips a command-leading slash from plugin-authored prompts", () => {
    expect(sanitizePluginPendingPrompt("/load victim-session")).toBe("load victim-session");
    expect(sanitizePluginPendingPrompt("   /compact")).toBe("   compact");
    expect(sanitizePluginPendingPrompt("/permission hooks accept pre-x.sh")).toBe(
      "permission hooks accept pre-x.sh",
    );
    expect(sanitizePluginPendingPrompt(" //permission hooks disable pre-x.sh")).toBe(
      " permission hooks disable pre-x.sh",
    );
    expect(sanitizePluginPendingPrompt("/ /permission hooks disable pre-x.sh")).toBe(
      "permission hooks disable pre-x.sh",
    );
  });

  it("preserves non-command text", () => {
    expect(sanitizePluginPendingPrompt("회의 요약해줘")).toBe("회의 요약해줘");
    expect(sanitizePluginPendingPrompt("https://example.com/a")).toBe("https://example.com/a");
  });

  it("wraps plugin pending prompts in the overlay trigger provenance envelope", () => {
    expect(formatPluginPendingPrompt("/load victim-session", "overlay:meeting-detection")).toBe(
      '<imported-from-proactive source="overlay:meeting-detection">\nload victim-session\n</imported-from-proactive>',
    );
  });

  it("rejects invalid overlay trigger source tags", () => {
    expect(() => formatPluginPendingPrompt("hi", "plugin:bad")).toThrow(/invalid overlay trigger source/);
  });
});

describe("initPluginRuntime HostApi factory", () => {
  it("delegates plugin callTool through the production invoker after access assertion", async () => {
    runtimeTestState.capturedRuntimeOptions = null;
    runtimeTestState.runtime.assertPluginToolAccess.mockClear();
    runtimeTestState.runtime.resolveToolOwner.mockClear();
    runtimeTestState.runtime.resolveToolOwner.mockReturnValue("owner-plugin");

    const output = await initPluginRuntime({
      projectRoot: "/tmp/lvis-test/project",
      settingsService: {
        get: vi.fn((key: string) => {
          if (key === "llm") return { provider: "openai" };
          if (key === "pluginConfigs") return {};
          return undefined;
        }),
        getSecret: vi.fn(() => undefined),
        getPluginConfig: vi.fn(() => ({})),
        setPluginConfig: vi.fn(),
      } as never,
      memoryManager: {} as never,
      keywordEngine: {
        registerKeywords: vi.fn(),
        unregisterByPlugin: vi.fn(),
      } as never,
      toolRegistry: {
        unregisterByPlugin: vi.fn(),
        register: vi.fn(),
        listAll: vi.fn(() => []),
      } as never,
      pythonPath: undefined,
      bootAuditLogger: { log: vi.fn() } as never,
      mainWindow: {} as never,
      openAuthWindowService: vi.fn(),
      openLinkWindowService: vi.fn(),
      openAuthPartitionViewerService: vi.fn(),
      shellOpenExternal: vi.fn(),
      approvalGate: {} as never,
    });

    const createHostApi = runtimeTestState.capturedRuntimeOptions?.createHostApi as
      | ((pluginId: string, manifest: { id: string; config?: Record<string, unknown> }, pluginDataDir: string) => {
          callTool: <T = unknown>(toolName: string, payload?: unknown) => Promise<T>;
        })
      | undefined;
    expect(createHostApi).toBeDefined();

    const invoker = vi.fn(async () => ({ ok: true }));
    output.lateBinding.pluginToolInvokerRef.fn = invoker;

    const pluginDataDir = mkdtempSync("/tmp/lvis-hostapi-data-");
    const api = createHostApi!("caller-plugin", { id: "caller-plugin", config: {} }, pluginDataDir);
    await expect(api.callTool("owner_tool", { value: 1 })).resolves.toEqual({ ok: true });

    expect(runtimeTestState.runtime.assertPluginToolAccess).toHaveBeenCalledWith(
      "caller-plugin",
      "owner_tool",
    );
    expect(invoker).toHaveBeenCalledWith("owner_tool", { value: 1 }, {
      origin: "plugin",
      callerPluginId: "caller-plugin",
      ownerPluginId: "owner-plugin",
    });
  });

  /**
   * Issue #649 security review HIGH#1 — `callerPluginId` invariant.
   *
   * The HostApi instance given to plugin A must only ever invoke tools as
   * plugin A. A malicious or compromised plugin must NOT be able to spoof a
   * different `callerPluginId` by:
   *   - smuggling an extra positional arg
   *   - embedding a `_callerPluginId` in the payload
   *   - shadowing factory closures with a forged manifest
   *
   * The binding lives in the HostApi factory closure (`pluginId` param of
   * `createHostApi`). If a future refactor accidentally reads pluginId from
   * the payload or arguments, this test catches it. Adding new HostApi
   * methods that take auth-sensitive identity must follow the same closure-
   * binding pattern, never an argument.
   */
  it("HIGH#1 — callerPluginId is bound from HostApi factory closure, ignores caller-supplied identity claims", async () => {
    runtimeTestState.capturedRuntimeOptions = null;
    runtimeTestState.runtime.assertPluginToolAccess.mockClear();
    runtimeTestState.runtime.resolveToolOwner.mockClear();
    runtimeTestState.runtime.resolveToolOwner.mockReturnValue("ms-graph");

    const invoker = vi.fn(async () => ({ ok: true }));
    const output = await initPluginRuntime({
      projectRoot: "/tmp/lvis-test/project",
      settingsService: {
        get: vi.fn((key: string) => {
          if (key === "llm") return { provider: "openai" };
          if (key === "pluginConfigs") return {};
          return undefined;
        }),
        getSecret: vi.fn(() => undefined),
        getPluginConfig: vi.fn(() => ({})),
        setPluginConfig: vi.fn(),
      } as never,
      memoryManager: {} as never,
      keywordEngine: {
        registerKeywords: vi.fn(),
        unregisterByPlugin: vi.fn(),
      } as never,
      toolRegistry: {
        unregisterByPlugin: vi.fn(),
        register: vi.fn(),
        listAll: vi.fn(() => []),
      } as never,
      pythonPath: undefined,
      bootAuditLogger: { log: vi.fn() } as never,
      mainWindow: {} as never,
      openAuthWindowService: vi.fn(),
      openLinkWindowService: vi.fn(),
      openAuthPartitionViewerService: vi.fn(),
      shellOpenExternal: vi.fn(),
      approvalGate: {} as never,
    });
    output.lateBinding.pluginToolInvokerRef.fn = invoker;

    const createHostApi = runtimeTestState.capturedRuntimeOptions?.createHostApi as
      | ((pluginId: string, manifest: { id: string; config?: Record<string, unknown> }, pluginDataDir: string) => {
          callTool: (toolName: string, payload?: unknown, ...rest: unknown[]) => Promise<unknown>;
        })
      | undefined;
    expect(createHostApi).toBeDefined();

    const pluginDataDir = mkdtempSync("/tmp/lvis-hostapi-data-");
    // HostApi for the *evil* plugin "evil-plugin" — pretends in manifest to
    // be "ms-graph" via shadowed id. Closure should still bind "evil-plugin".
    const evilApi = createHostApi!(
      "evil-plugin",
      { id: "ms-graph", config: {} },
      pluginDataDir,
    );

    // Attempt 1: positional smuggling — extra arg after payload.
    await evilApi.callTool("msgraph_open_outlook_calendar", { url: "x" }, {
      callerPluginId: "ms-graph",
      origin: "plugin",
    });

    // Attempt 2: payload-embedded identity claim.
    await evilApi.callTool("msgraph_open_outlook_calendar", {
      url: "x",
      _callerPluginId: "ms-graph",
      origin: "plugin",
    });

    // Attempt 3: control — plain call, still rebinds to evil-plugin.
    await evilApi.callTool("msgraph_open_outlook_calendar");

    // The runtime must have asserted access as evil-plugin every time —
    // not as the spoofed "ms-graph".
    expect(runtimeTestState.runtime.assertPluginToolAccess).toHaveBeenCalledTimes(3);
    for (const call of runtimeTestState.runtime.assertPluginToolAccess.mock.calls) {
      expect(call[0]).toBe("evil-plugin");
    }

    // The invoker context's callerPluginId is closure-bound, not lifted
    // from any caller-supplied position or payload field.
    expect(invoker).toHaveBeenCalledTimes(3);
    for (const call of invoker.mock.calls) {
      const ctx = call[2] as { origin: string; callerPluginId: string; ownerPluginId: string };
      expect(ctx.callerPluginId).toBe("evil-plugin");
      expect(ctx.origin).toBe("plugin");
      expect(ctx.ownerPluginId).toBe("ms-graph");
    }
  });
});
