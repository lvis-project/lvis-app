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

import { beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";

const runtimeTestState = vi.hoisted(() => ({
  appPrependOnceListener: vi.fn(),
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  readPluginRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
  runtime: {
    startAll: vi.fn(async () => {}),
    listToolNames: vi.fn(() => [] as string[]),
    listPluginIds: vi.fn(() => [] as string[]),
    listPluginManifests: vi.fn(() => [] as Array<{ pluginId: string; manifest: unknown }>),
    getPluginRoot: vi.fn((pluginId: string) => `/tmp/lvis-test/plugins/${pluginId}`),
    getPluginManifest: vi.fn(() => null),
    getApprovedPluginAccess: vi.fn(() => undefined),
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
  PluginRuntime: vi.fn().mockImplementation(function (this: unknown, options: Record<string, unknown>) {
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

vi.mock("../../../plugins/registry.js", () => ({
  readPluginRegistry: runtimeTestState.readPluginRegistry,
}));

import {
  auditApprovalViolation,
  declaresHostManagedPythonRuntime,
  deriveOverlaySummaryForDisplay,
  formatPluginPendingPrompt,
  initPluginRuntime,
  sanitizePluginPendingPrompt,
} from "../plugin-runtime.js";
import { ApprovalOriginError } from "../../../permissions/agent-action-requester.js";
import { installPluginPartitionPolicy } from "../../../main/html-preview-partition.js";
import { pluginPartitionName } from "../../../shared/plugin-partition.js";
import { emitEvent } from "../../types.js";

beforeEach(() => {
  runtimeTestState.readPluginRegistry.mockReset();
  runtimeTestState.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [] });
});

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

describe("declaresHostManagedPythonRuntime", () => {
  it("uses the same lockfile declaration shapes as Python runtime discovery", () => {
    const manifest = (overrides: Record<string, unknown>) => ({
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      entry: "index.js",
      tools: [],
      description: "",
      ...overrides,
    } as unknown as Parameters<typeof declaresHostManagedPythonRuntime>[0]);

    expect(declaresHostManagedPythonRuntime(manifest({
      python: { managedBy: "lvis-app" },
    }))).toBe(true);
    expect(declaresHostManagedPythonRuntime(manifest({
      pythonRequirementsLock: "requirements/python.lock",
    }))).toBe(true);
    expect(declaresHostManagedPythonRuntime(manifest({
      runtime: { python: { requirementsLock: "requirements/python.lock" } },
    }))).toBe(true);
    expect(declaresHostManagedPythonRuntime(manifest({
      config: { pythonRequirementsLock: "requirements/python.lock" },
    }))).toBe(true);
    expect(declaresHostManagedPythonRuntime(manifest({}))).toBe(false);
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

describe("deriveOverlaySummaryForDisplay", () => {
  it("strips untrusted wrapper tags from explicit plugin summaries", () => {
    expect(
      deriveOverlaySummaryForDisplay({
        prompt: "fallback",
        summary: "<untrusted-highlight>회의 요약</untrusted-highlight>",
      }),
    ).toBe("회의 요약");
  });

  it("strips untrusted wrapper tags from prompt-derived summaries", () => {
    expect(
      deriveOverlaySummaryForDisplay({
        prompt: "<untrusted-meeting-title>대화 내용 확인</untrusted-meeting-title>",
      }),
    ).toBe("대화 내용 확인");
  });

  it("caps long explicit summaries and appends a truncation marker", () => {
    const summary = deriveOverlaySummaryForDisplay({
      prompt: "fallback",
      summary: "긴 요약 ".repeat(600),
    });
    expect(summary.length).toBeLessThanOrEqual(2_000);
    expect(summary).toContain("[잘림");
    expect(summary).toContain("확인하기");
  });
});

describe("initPluginRuntime partition policy", () => {
  it("registers plugin webview preload policy from onEnable after managed bootstrap restartAll", async () => {
    runtimeTestState.capturedRuntimeOptions = null;
    runtimeTestState.runtime.listPluginIds.mockReturnValue([]);
    runtimeTestState.runtime.listPluginManifests.mockReturnValue([]);
    runtimeTestState.runtime.getPluginRoot.mockImplementation(
      (pluginId: string) => `/tmp/lvis-test/plugins/${pluginId}`,
    );
    const installPolicy = vi.mocked(installPluginPartitionPolicy);
    installPolicy.mockClear();

    await initPluginRuntime({
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
        listPluginIds: vi.fn(() => []),
        replacePluginTools: vi.fn(),
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

    const onEnable = runtimeTestState.capturedRuntimeOptions?.onEnable as
      | ((pluginId: string) => void)
      | undefined;
    expect(onEnable).toBeDefined();

    onEnable!("managed-plugin");

    expect(installPolicy).toHaveBeenCalledWith(
      pluginPartitionName("managed-plugin"),
      { pluginRoot: "/tmp/lvis-test/plugins/managed-plugin" },
    );
  });
});

describe("initPluginRuntime HostApi factory", () => {
  it("rejects agentApproval.request before prompting when the manifest has not declared the scope", async () => {
    runtimeTestState.capturedRuntimeOptions = null;
    runtimeTestState.runtime.getApprovedPluginAccess.mockReturnValue({
      agentApprovalScopes: ["agent_task_delegate"],
    });
    const bootAuditLogger = { log: vi.fn() };
    const approvalGate = { requestAndWait: vi.fn() };

    await initPluginRuntime({
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
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
} as never,
      pythonPath: undefined,
      bootAuditLogger: bootAuditLogger as never,
      mainWindow: {} as never,
      openAuthWindowService: vi.fn(),
      openLinkWindowService: vi.fn(),
      openAuthPartitionViewerService: vi.fn(),
      shellOpenExternal: vi.fn(),
      approvalGate: approvalGate as never,
    });

    const createHostApi = runtimeTestState.capturedRuntimeOptions?.createHostApi as
      | ((pluginId: string, manifest: {
          id: string;
          config?: Record<string, unknown>;
          pluginAccess?: { agentApprovalScopes?: string[] };
        }, pluginDataDir: string) => {
          agentApproval: {
            request: (input: {
              toolName: string;
              args: unknown;
              reason: string;
              scope: string;
            }) => Promise<unknown>;
          };
        })
      | undefined;
    expect(createHostApi).toBeDefined();

    const pluginDataDir = mkdtempSync("/tmp/lvis-hostapi-data-");
    const api = createHostApi!(
      "plugin-a",
      {
        id: "plugin-a",
        config: {},
        pluginAccess: { agentApprovalScopes: ["agent_external_api_call"] },
      },
      pluginDataDir,
    );

    await expect(api.agentApproval.request({
      toolName: "agent_external_call",
      args: { target: "example" },
      reason: "plugin wants host approval",
      scope: "agent_external_api_call",
    })).rejects.toMatchObject({ code: "scope-not-allowed" });

    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(runtimeTestState.runtime.getApprovedPluginAccess).toHaveBeenCalledWith("plugin-a");
    expect(bootAuditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        input: expect.stringContaining("[scope-not-allowed]"),
      }),
    );
  });

  it("allows agentApproval.request only from the approved grant and forwards issuer provenance", async () => {
    runtimeTestState.capturedRuntimeOptions = null;
    runtimeTestState.runtime.getApprovedPluginAccess.mockReturnValue({
      agentApprovalScopes: ["agent_external_api_call"],
    });
    const bootAuditLogger = { log: vi.fn() };
    const approvalGate = {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: "allow-once" as const,
      })),
    };

    await initPluginRuntime({
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
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
} as never,
      pythonPath: undefined,
      bootAuditLogger: bootAuditLogger as never,
      mainWindow: {} as never,
      openAuthWindowService: vi.fn(),
      openLinkWindowService: vi.fn(),
      openAuthPartitionViewerService: vi.fn(),
      shellOpenExternal: vi.fn(),
      approvalGate: approvalGate as never,
    });

    const createHostApi = runtimeTestState.capturedRuntimeOptions?.createHostApi as
      | ((pluginId: string, manifest: {
          id: string;
          config?: Record<string, unknown>;
          pluginAccess?: { agentApprovalScopes?: string[] };
        }, pluginDataDir: string) => {
          agentApproval: {
            request: (input: {
              toolName: string;
              args: unknown;
              reason: string;
              scope: string;
            }) => Promise<unknown>;
          };
        })
      | undefined;
    expect(createHostApi).toBeDefined();

    const pluginDataDir = mkdtempSync("/tmp/lvis-hostapi-data-");
    const api = createHostApi!(
      "plugin-a",
      {
        id: "plugin-a",
        config: {},
        pluginAccess: { agentApprovalScopes: [] },
      },
      pluginDataDir,
    );

    await expect(api.agentApproval.request({
      toolName: "agent_external_call",
      args: { target: "example" },
      reason: "plugin wants host approval",
      scope: "agent_external_api_call",
    })).resolves.toBe("allow-once");

    expect(runtimeTestState.runtime.getApprovedPluginAccess).toHaveBeenCalledWith("plugin-a");
    expect(approvalGate.requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "agent-action",
        kind: "agent-action",
        source: "plugin",
        sourcePluginId: "plugin-a",
        approvalScope: "agent_external_api_call",
      }),
    );
  });

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
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
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
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
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

  // PR #894 review B6 — active-vendor cross-check in getSecret
  it("B6 — getSecret denies non-active-vendor llm.apiKey.* even when allowlisted", async () => {
    runtimeTestState.capturedRuntimeOptions = null;
    const bootAuditLogger = { log: vi.fn() };

    // #893 Stage 2 — seed the whitelist registry with a grant for plugin-b6
    // so tier-3 lets the call through; B6 specifically exercises tier-4
    // active-vendor cross-check inside getSecret.
    const { whitelistRegistry } = await import(
      "../../../plugins/whitelist/whitelist-registry.js"
    );
    const { WhitelistCache } = await import(
      "../../../plugins/whitelist/whitelist-cache.js"
    );
    const { WHITELIST_PRIMARY_KEY_ID } = await import(
      "../../../plugins/marketplace-keys.js"
    );
    const { canonicalJSON } = await import(
      "../../../plugins/whitelist/canonical-json.js"
    );
    const { generateKeyPairSync, sign, createHash } = await import("node:crypto");
    const { mkdtempSync: mkdtempSyncOs } = await import("node:fs");
    whitelistRegistry.resetForTesting();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawPub = publicKey.export({ type: "spki", format: "der" }).slice(-32);
    // Ralph cycle 1 — production keys are frozen; tests inject via the
    // singleton's dedicated helper.
    whitelistRegistry.setPublicKeysForTesting({
      [WHITELIST_PRIMARY_KEY_ID]: rawPub.toString("base64"),
    });
    const grantDoc = {
      version: 1,
      schemaVersion: 1,
      issuedAt: "2026-05-17T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      pluginGrants: {
        "plugin-b6": {
          publisher: "test",
          hostSecrets: { read: ["llm.apiKey.openai", "llm.apiKey.claude"] },
          // Hash of the canonicalized manifest used below. The host now
          // canonicalizes via the recursive `canonicalJSON` helper
          // (Ralph cycle 1 fix to the manifest-sha pin) so the test
          // mirrors the production path.
          approvedManifestSha256: createHash("sha256")
            .update(
              canonicalJSON({
                id: "plugin-b6",
                config: {},
                hostSecrets: { read: ["llm.apiKey.openai", "llm.apiKey.claude"] },
              }),
            )
            .digest("hex"),
        },
      },
    };
    const grantBody = JSON.stringify(grantDoc);
    const grantSig = sign(null, Buffer.from(grantBody, "utf-8"), privateKey);
    const envelope = {
      version: 1,
      iat: Math.floor(Date.now() / 1000),
      artifact_sha256: createHash("sha256").update(Buffer.from(grantBody, "utf-8")).digest("hex"),
      signatures: [
        { key_id: WHITELIST_PRIMARY_KEY_ID, alg: "ed25519", sig: grantSig.toString("base64") },
      ],
    };
    const cacheRoot = mkdtempSyncOs("/tmp/lvis-b6-whitelist-");
    const cache = new WhitelistCache(cacheRoot);
    await cache.store({ body: grantBody, signature: JSON.stringify(envelope), meta: {} });
    await whitelistRegistry.init({ userDataDir: cacheRoot, online: false });

    const getSecretMock = vi.fn((key: string) => {
      if (key === "llm.apiKey.openai") return "sk-openai";
      if (key === "llm.apiKey.claude") return "sk-claude";
      return null;
    });

    await initPluginRuntime({
      projectRoot: "/tmp/lvis-test/project",
      settingsService: {
        get: vi.fn((key: string) => {
          // openai is the active vendor for this test
          if (key === "llm") return { provider: "openai" };
          if (key === "pluginConfigs") return {};
          return undefined;
        }),
        getSecret: getSecretMock,
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
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
} as never,
      pythonPath: undefined,
      bootAuditLogger: bootAuditLogger as never,
      mainWindow: {} as never,
      openAuthWindowService: vi.fn(),
      openLinkWindowService: vi.fn(),
      openAuthPartitionViewerService: vi.fn(),
      shellOpenExternal: vi.fn(),
      approvalGate: { requestAndWait: vi.fn() } as never,
    });

    const createHostApi = runtimeTestState.capturedRuntimeOptions?.createHostApi as
      | ((pluginId: string, manifest: {
          id: string;
          config?: Record<string, unknown>;
          hostSecrets?: { read?: string[] };
        }, pluginDataDir: string) => {
          getSecret: (key: string) => string | null;
        })
      | undefined;
    expect(createHostApi).toBeDefined();

    const pluginDataDir = mkdtempSync("/tmp/lvis-hostapi-data-");
    const api = createHostApi!(
      "plugin-b6",
      {
        id: "plugin-b6",
        config: {},
        // Plugin allowlists BOTH vendors; without B6 it could read both.
        hostSecrets: { read: ["llm.apiKey.openai", "llm.apiKey.claude"] },
      },
      pluginDataDir,
    );

    // Active vendor (openai) — allowed
    expect(api.getSecret("llm.apiKey.openai")).toBe("sk-openai");

    // Non-active vendor (claude) — denied even though allowlisted
    expect(api.getSecret("llm.apiKey.claude")).toBeNull();

    // Audit captured non-active-vendor warn
    const denyAudit = bootAuditLogger.log.mock.calls.find((c) => {
      const input = (c[0] as { input?: string }).input ?? "";
      return input.includes("non-active-vendor") && input.includes("llm.apiKey.claude");
    });
    expect(denyAudit).toBeDefined();
  });

  it("B7 — getSecret denied for unknown prefix falls into `other` counter bucket", async () => {
    runtimeTestState.capturedRuntimeOptions = null;
    const bootAuditLogger = { log: vi.fn() };
    const { resetHostSecretCountersForTesting, getHostSecretCounter } = await import(
      "../../../telemetry/host-secret-counters.js"
    );
    resetHostSecretCountersForTesting();

    await initPluginRuntime({
      projectRoot: "/tmp/lvis-test/project",
      settingsService: {
        get: vi.fn((key: string) => {
          if (key === "llm") return { provider: "openai" };
          if (key === "pluginConfigs") return {};
          return undefined;
        }),
        getSecret: vi.fn(() => null),
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
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
} as never,
      pythonPath: undefined,
      bootAuditLogger: bootAuditLogger as never,
      mainWindow: {} as never,
      openAuthWindowService: vi.fn(),
      openLinkWindowService: vi.fn(),
      openAuthPartitionViewerService: vi.fn(),
      shellOpenExternal: vi.fn(),
      approvalGate: { requestAndWait: vi.fn() } as never,
    });

    const createHostApi = runtimeTestState.capturedRuntimeOptions?.createHostApi as
      | ((pluginId: string, manifest: {
          id: string;
          config?: Record<string, unknown>;
          hostSecrets?: { read?: string[] };
        }, pluginDataDir: string) => {
          getSecret: (key: string) => string | null;
        })
      | undefined;
    expect(createHostApi).toBeDefined();

    const pluginDataDir = mkdtempSync("/tmp/lvis-hostapi-data-");
    const api = createHostApi!(
      "plugin-b7",
      { id: "plugin-b7", config: {}, hostSecrets: { read: [] } },
      pluginDataDir,
    );

    // Attacker-controlled prefix gets folded into `other`
    expect(api.getSecret("attacker.x")).toBeNull();
    expect(api.getSecret("garbage.y")).toBeNull();
    expect(api.getSecret("evilprefix.z")).toBeNull();

    expect(getHostSecretCounter("hostSecret_denied", "plugin-b7", "other")).toBe(3);
    expect(getHostSecretCounter("hostSecret_denied", "plugin-b7", "attacker")).toBe(0);
  });

  it("clears registry-entry cache on refresh failure so admin secret bypass fails closed (#959)", async () => {
    runtimeTestState.capturedRuntimeOptions = null;
    const { canonicalJSON } = await import("../../../plugins/whitelist/canonical-json.js");
    const { createHash } = await import("node:crypto");
    const manifest = {
      id: "plugin-cache-fail",
      installPolicy: "admin",
      config: {},
      hostSecrets: { read: ["llm.apiKey.openai"] },
    };
    const manifestSha256 = createHash("sha256")
      .update(canonicalJSON(manifest))
      .digest("hex");
    runtimeTestState.readPluginRegistry.mockResolvedValueOnce({
      version: 1,
      plugins: [
        {
          id: "plugin-cache-fail",
          manifestPath: "plugin-cache-fail/plugin.json",
          enabled: true,
          installSource: "admin",
          manifestSha256,
        },
      ],
    });

    await initPluginRuntime({
      projectRoot: "/tmp/lvis-test/project",
      settingsService: {
        get: vi.fn((key: string) => {
          if (key === "llm") return { provider: "openai" };
          if (key === "pluginConfigs") return {};
          return undefined;
        }),
        getSecret: vi.fn((key: string) => key === "llm.apiKey.openai" ? "sk-openai" : null),
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
        listPluginIds: vi.fn(() => []),
        replacePluginTools: vi.fn(),
      } as never,
      pythonPath: undefined,
      bootAuditLogger: { log: vi.fn() } as never,
      mainWindow: {} as never,
      openAuthWindowService: vi.fn(),
      openLinkWindowService: vi.fn(),
      openAuthPartitionViewerService: vi.fn(),
      shellOpenExternal: vi.fn(),
      approvalGate: { requestAndWait: vi.fn() } as never,
    });

    const createHostApi = runtimeTestState.capturedRuntimeOptions?.createHostApi as
      | ((pluginId: string, manifest: {
          id: string;
          installPolicy?: "admin" | "user";
          config?: Record<string, unknown>;
          hostSecrets?: { read?: string[] };
        }, pluginDataDir: string) => {
          getSecret: (key: string) => string | null;
        })
      | undefined;
    expect(createHostApi).toBeDefined();

    const api = createHostApi!(
      "plugin-cache-fail",
      manifest,
      mkdtempSync("/tmp/lvis-hostapi-data-"),
    );
    expect(api.getSecret("llm.apiKey.openai")).toBe("sk-openai");

    runtimeTestState.readPluginRegistry.mockRejectedValue(new Error("registry unavailable"));
    emitEvent("plugin.installed", { pluginId: "plugin-cache-fail" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.getSecret("llm.apiKey.openai")).toBeNull();
  });
});
