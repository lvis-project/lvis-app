import { describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dispatchUiOnlyRuntimeInvocation,
  isUiOnlyRuntimeInvocation,
  uiOnlyRuntimeInvocationRequiresUserAction,
} from "../plugin-tool-invocation.js";
import { PluginRuntime, type PluginToolInvocationContext } from "../../plugins/runtime.js";
import {
  currentInvocationOrigin,
  runWithInvocationOrigin,
} from "../../plugins/runtime/origin-chain.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { normalizeManifest } from "../../plugins/types.js";
import type { NormalizedManifest, Tool } from "../../plugins/types.js";

// #885 v6 — the gate reads the NORMALIZED manifest (`Tool[]` + `_meta.ui.visibility`).
// The pure `tools: string[]` + `uiActions` legacy reader was removed in Phase R,
// so these fixtures compile surface membership into each tool's explicit
// `_meta.ui.visibility` here (tools[]-only→["model"], uiActions-only→["app"],
// both→dual), then run the pure manifest through the real `normalizeManifest`.
function normalize(spec: {
  tools?: string[];
  uiActions?: Record<string, { description?: string }>;
  auth?: { statusTool: string; loginTool: string; logoutTool?: string };
}): NormalizedManifest {
  const names = spec.tools ?? [];
  const uiNames = Object.keys(spec.uiActions ?? {});
  const allNames = [...names, ...uiNames.filter((n) => !names.includes(n))];
  const tools: Tool[] = allNames.map((name) => {
    const visibility: Array<"model" | "app"> = [
      ...(names.includes(name) ? (["model"] as const) : []),
      ...(uiNames.includes(name) ? (["app"] as const) : []),
    ];
    return {
      name,
      inputSchema: { type: "object" as const, properties: {} },
      _meta: { ui: { visibility } },
    };
  });
  return normalizeManifest({
    id: "meeting",
    name: "Meeting",
    version: "1.0.0",
    entry: "index.js",
    description: "test fixture",
    tools,
    ...(spec.auth ? { auth: spec.auth } : {}),
  });
}

function runtimeWithManifest(spec: {
  tools?: string[];
  uiActions?: Record<string, { description?: string }>;
  auth?: { statusTool: string; loginTool: string; logoutTool?: string };
}) {
  return {
    listPluginManifests: () => [
      {
        pluginId: "meeting",
        manifest: normalize(spec),
      },
    ],
  } as any;
}

describe("plugin UI-only runtime invocation", () => {
  it("routes UI action runtime methods that are not LLM tools through the UI action handler path", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiActions: { meeting_stage_upload_begin: {} } }),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(true);
  });

  it("routes uiActions runtime methods that are not LLM tools through the UI action handler path", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiActions: { meeting_stage_upload_begin: {} } }),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(true);
  });

  it("keeps LLM-facing tools on the ToolExecutor path", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiActions: { meeting_upload_file: {} } }),
        "meeting_upload_file",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("does not bypass ToolExecutor for non-UI-origin calls", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ uiActions: { meeting_stage_upload_begin: {} } }),
        "meeting_stage_upload_begin",
        { origin: "plugin", ownerPluginId: "meeting" },
        "plugin",
      ),
    ).toBe(false);
  });

  it("requires the runtime method to be declared in the owning plugin uiActions list", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiActions: { meeting_upload_file: {} } }),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("keeps manifest tools on the ToolExecutor path even when registry sync is stale", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiActions: { meeting_upload_file: {} } }),
        "meeting_upload_file",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("allows auth status polling without a fresh user activation", () => {
    expect(
      uiOnlyRuntimeInvocationRequiresUserAction(
        runtimeWithManifest({
          tools: ["meeting_upload_file"],
          uiActions: { auth_status: {}, auth_login: {} },
          auth: { statusTool: "auth_status", loginTool: "auth_login" },
        }),
        "auth_status",
        { origin: "ui", ownerPluginId: "meeting" },
      ),
    ).toBe(false);
  });

  it("requires user activation for non-status UI-only actions", () => {
    const runtime = runtimeWithManifest({
      tools: ["meeting_upload_file"],
      uiActions: { auth_status: {}, auth_login: {}, meeting_stage_upload_begin: {} },
      auth: { statusTool: "auth_status", loginTool: "auth_login" },
    });

    expect(
      uiOnlyRuntimeInvocationRequiresUserAction(
        runtime,
        "auth_login",
        { origin: "ui", ownerPluginId: "meeting" },
      ),
    ).toBe(true);
    expect(
      uiOnlyRuntimeInvocationRequiresUserAction(
        runtime,
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
      ),
    ).toBe(true);
  });
});

// #1553 (relocated + wiring guard) — the uiActions bypass ceiling now lives
// STRUCTURALLY inside `PluginRuntime.callDeclaredUiAction` (proven directly at
// the runtime level in plugins/runtime/__tests__/ui-action-ceiling.test.ts).
// This block adds the wiring-level regression guard the cluster review asked
// for: a FAITHFUL reproduction of the production `invokePluginTool` UI-only
// branch (boot/steps/plugin-tool-executor.ts) — runWithInvocationOrigin →
// isUiOnlyRuntimeInvocation → dispatchUiOnlyRuntimeInvocation — driven against a
// REAL PluginRuntime. It proves the boot dispatch path reaches that structural
// ceiling, so a hung uiActions handler rejects at the global ceiling instead of
// blocking the renderer forever — even if this dispatch were ever reverted to a
// direct `pluginRuntime.callDeclaredUiAction(...)` call. (The analogous OTHER
// executor branch is reproduced in tools/__tests__/executor-effect-ledger.test.ts.)
// Fake timers advance to the SOT ceiling so the test does not wait the real 120s.
describe("invokePluginTool UI-only branch — reaches the structural ceiling (#1553 wiring guard)", () => {
  const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  function realRuntimeWithUiAction(
    manifest: { tools?: string[]; uiActions?: Record<string, { description?: string }> },
    method: string,
    handler: (payload?: unknown) => Promise<unknown>,
  ): PluginRuntime {
    const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
    const internals = rt as unknown as {
      plugins: Map<string, { manifest: unknown }>;
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    internals.plugins.set("test.plugin", { manifest: normalize(manifest) } as unknown as never);
    internals.methodMap.set(method, { pluginId: "test.plugin", handler });
    return rt;
  }

  // Faithful reproduction of the production invokePluginTool UI-only branch.
  function invokePluginToolRepro(
    rt: PluginRuntime,
    toolName: string,
    payload: Record<string, unknown>,
    context: PluginToolInvocationContext,
  ): Promise<unknown> {
    return runWithInvocationOrigin(context.origin, context.parentOrigin, async () => {
      const effectiveOrigin = currentInvocationOrigin() ?? context.origin;
      if (isUiOnlyRuntimeInvocation(rt, toolName, context, effectiveOrigin)) {
        return dispatchUiOnlyRuntimeInvocation(rt, toolName, payload, context);
      }
      throw new Error("reproduction did not take the UI-only branch");
    });
  }

  it("rejects at the global ceiling when a uiActions-only handler hangs (caller does not block)", async () => {
    vi.useFakeTimers();
    try {
      const rt = realRuntimeWithUiAction(
        { tools: ["meeting_upload_file"], uiActions: { meeting_stage_upload_begin: {} } },
        "meeting_stage_upload_begin",
        // Never resolves — simulates a hung uiActions handler.
        () => new Promise<never>(() => {}),
      );
      const pending = invokePluginToolRepro(
        rt,
        "meeting_stage_upload_begin",
        {},
        { origin: "ui", ownerPluginId: "test.plugin", userAction: true },
      );
      // Attach the rejection expectation BEFORE advancing so the ceiling
      // rejection is never an unhandled rejection.
      const rejection = expect(pending).rejects.toThrow(
        new RegExp(
          `exceeded global ceiling \\(${TOOL_TIMEOUT_POLICY.globalCeilingMs}ms\\): meeting_stage_upload_begin`,
        ),
      );
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs + 1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

// #1556 — a nested plugin-origin `ctx.callTool` (HostApi.callTool builds
// `origin: "plugin"` and never forwards `userAction`, even while riding a
// UI-rooted chain via `parentOrigin: "ui"`) targeting a uiActions-only
// non-status method must throw an error naming the REAL manifest constraint,
// not the generic user-activation error which misleads the plugin author.
describe("dispatchUiOnlyRuntimeInvocation — nested plugin-origin ctx.callTool clarity (#1556)", () => {
  it("throws the explicit uiActions-only constraint error for a nested plugin-origin call (not the generic activation error)", async () => {
    let handlerCalled = false;
    const runtime = {
      listPluginManifests: () => [
        {
          pluginId: "meeting",
          manifest: normalize({
            tools: ["meeting_upload_file"],
            uiActions: { meeting_stage_upload_begin: {} },
          }),
        },
      ],
      callDeclaredUiAction: async () => {
        handlerCalled = true;
        return "unreached";
      },
    } as any;

    const err = await dispatchUiOnlyRuntimeInvocation(
      runtime,
      "meeting_stage_upload_begin",
      {},
      // nested hop: origin "plugin" but effective chain is UI (parentOrigin).
      { origin: "plugin", ownerPluginId: "meeting", parentOrigin: "ui" },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /uiActions-only method and cannot be invoked from a plugin-origin ctx\.callTool/,
    );
    // Must NOT be the old, misleading generic activation error.
    expect((err as Error).message).not.toMatch(/requires an active user activation/);
    // The constraint is detected before dispatch — the handler is never run.
    expect(handlerCalled).toBe(false);
  });

  it("keeps the generic user-activation error for a genuine direct-UI call without activation", async () => {
    const runtime = {
      listPluginManifests: () => [
        {
          pluginId: "meeting",
          manifest: normalize({
            tools: ["meeting_upload_file"],
            uiActions: { meeting_stage_upload_begin: {} },
          }),
        },
      ],
      callDeclaredUiAction: async () => "unreached",
    } as any;

    await expect(
      dispatchUiOnlyRuntimeInvocation(
        runtime,
        "meeting_stage_upload_begin",
        {},
        { origin: "ui", ownerPluginId: "meeting" }, // direct UI, no userAction
      ),
    ).rejects.toThrow(/requires an active user activation/);
  });
});

// Defense-in-depth (cluster-review security LOW) — dispatchUiOnlyRuntimeInvocation
// is exported and must re-assert the not-in-tools[] routing invariant at the
// boundary, not merely trust the caller's isUiOnlyRuntimeInvocation predicate. A
// caller that mis-routes a tools[]-declared method here must be refused BEFORE
// the reviewer-skipping uiActions bypass runs.
describe("dispatchUiOnlyRuntimeInvocation — boundary routing gate (security defense-in-depth)", () => {
  it("refuses a tools[] method even when the caller mis-routes it to the bypass", async () => {
    let handlerCalled = false;
    const runtime = {
      listPluginManifests: () => [
        {
          pluginId: "meeting",
          manifest: normalize({
            // dual-declared: present in BOTH tools[] and uiActions → visibility ["model","app"]
            tools: ["meeting_upload_file"],
            uiActions: { meeting_upload_file: {} },
          }),
        },
      ],
      callDeclaredUiAction: async () => {
        handlerCalled = true;
        return "unreached";
      },
    } as any;

    await expect(
      dispatchUiOnlyRuntimeInvocation(
        runtime,
        "meeting_upload_file",
        {},
        { origin: "ui", ownerPluginId: "meeting", userAction: true },
      ),
    ).rejects.toThrow(/is a model-visible tool; refusing ungoverned uiActions dispatch/);
    // The bypass handler is never reached — the boundary gate fails closed.
    expect(handlerCalled).toBe(false);
  });

  it("allows a uiActions-only method (not in tools[]) through the bypass", async () => {
    const runtime = {
      listPluginManifests: () => [
        {
          pluginId: "meeting",
          manifest: normalize({
            tools: ["meeting_upload_file"],
            uiActions: { meeting_stage_upload_begin: {} },
          }),
        },
      ],
      callDeclaredUiAction: async (_method: string, payload: unknown) => ({ ok: payload }),
    } as any;

    await expect(
      dispatchUiOnlyRuntimeInvocation(
        runtime,
        "meeting_stage_upload_begin",
        { chunk: 2 },
        { origin: "ui", ownerPluginId: "meeting", userAction: true },
      ),
    ).resolves.toEqual({ ok: { chunk: 2 } });
  });
});
