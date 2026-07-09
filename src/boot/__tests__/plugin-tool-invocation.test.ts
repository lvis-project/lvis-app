import { describe, expect, it } from "vitest";
import {
  dispatchUiOnlyRuntimeInvocation,
  isUiOnlyRuntimeInvocation,
  uiOnlyRuntimeInvocationRequiresUserAction,
} from "../plugin-tool-invocation.js";

function runtimeWithManifest(manifest: {
  tools?: string[];
  uiActions?: Record<string, { description?: string }>;
  auth?: { statusTool: string; loginTool: string; logoutTool?: string };
}) {
  return {
    listPluginManifests: () => [
      {
        pluginId: "meeting",
        manifest,
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

// #1553 — the UI-only bypass must still pass through the governed
// `runWithCeiling` cap so a hung uiActions handler cannot block the renderer
// caller forever. `dispatchUiOnlyRuntimeInvocation` accepts a `ceilingMs`
// test seam (default = TOOL_TIMEOUT_POLICY.globalCeilingMs) so we can prove
// the ceiling without waiting the real 120s and without weakening the SOT.
describe("dispatchUiOnlyRuntimeInvocation — ceiling on the uiActions bypass", () => {
  function runtimeWithHandler(
    manifest: {
      tools?: string[];
      uiActions?: Record<string, { description?: string }>;
      auth?: { statusTool: string; loginTool: string; logoutTool?: string };
    },
    callDeclaredUiAction: (method: string, payload?: unknown) => Promise<unknown>,
  ) {
    return {
      listPluginManifests: () => [{ pluginId: "meeting", manifest }],
      callDeclaredUiAction,
    } as any;
  }

  it("rejects at the global ceiling when the uiActions handler never resolves (caller does not hang)", async () => {
    const runtime = runtimeWithHandler(
      { tools: ["meeting_upload_file"], uiActions: { meeting_stage_upload_begin: {} } },
      // Never resolves — simulates a hung uiActions handler.
      () => new Promise<never>(() => {}),
    );

    await expect(
      dispatchUiOnlyRuntimeInvocation(
        runtime,
        "meeting_stage_upload_begin",
        {},
        { origin: "ui", ownerPluginId: "meeting", userAction: true },
        5, // small ceiling via the test seam — the SOT default is untouched
      ),
    ).rejects.toThrow(/exceeded global ceiling \(5ms\): meeting_stage_upload_begin/);
  });

  it("returns the handler value when it resolves within the ceiling", async () => {
    const runtime = runtimeWithHandler(
      { tools: ["meeting_upload_file"], uiActions: { meeting_stage_upload_begin: {} } },
      async (_method, payload) => ({ echoed: payload }),
    );

    await expect(
      dispatchUiOnlyRuntimeInvocation(
        runtime,
        "meeting_stage_upload_begin",
        { chunk: 1 },
        { origin: "ui", ownerPluginId: "meeting", userAction: true },
        5_000,
      ),
    ).resolves.toEqual({ echoed: { chunk: 1 } });
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
          manifest: {
            tools: ["meeting_upload_file"],
            uiActions: { meeting_stage_upload_begin: {} },
          },
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
          manifest: {
            tools: ["meeting_upload_file"],
            uiActions: { meeting_stage_upload_begin: {} },
          },
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
