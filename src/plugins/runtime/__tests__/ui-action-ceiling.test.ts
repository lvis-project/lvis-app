/**
 * #1553 (relocated, root-cause) — the app-only dispatch ceiling now lives
 * STRUCTURALLY inside `PluginRuntime.callDeclaredAppOnlyTool`, the SOLE entry point
 * of the bypass, rather than in the boot wiring that reaches it. This is the
 * root-cause guard the cluster review asked for: any caller of
 * callDeclaredAppOnlyTool is capped regardless of how boot dispatches, so a future
 * revert of the boot wiring back to a direct callDeclaredAppOnlyTool call cannot
 * silently drop the ceiling (CLAUDE.md §Tool Execution Timeout Policy: every
 * tool path passes through `runWithCeiling`).
 *
 * The runtime is built with a hand-crafted plugins/methodMap (the same seam
 * destructive-ui-actions-guard.test.ts uses) so the REAL callDeclaredAppOnlyTool is
 * exercised without spinning up a plugin entry file. `ceilingMs` is a defaulted
 * (= SOT) parameter used only as a test seam so we can prove the ceiling without
 * waiting the real 120s and without weakening the SOT.
 */
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNoopHostApiForTests, PluginRuntime } from "../../runtime.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function runtimeWithUiAction(
  method: string,
  handler: (payload?: unknown) => Promise<unknown>,
): PluginRuntime {
  const rt = new PluginRuntime({
      createHostApi: createNoopHostApiForTests, hostRoot: HOST_ROOT, manifestPaths: [] });
  const internals = rt as unknown as {
    plugins: Map<string, { manifest: unknown }>;
    methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
  };
  // #885 v6 — normalized manifest: the UI action is one Tool with visibility
  // ["app"] (an app-only-visibility method).
  internals.plugins.set("test.plugin", {
    manifest: {
      tools: [
        {
          name: method,
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["app"] } },
        },
      ],
    },
  } as unknown as never);
  internals.methodMap.set(method, { pluginId: "test.plugin", handler });
  return rt;
}

describe("PluginRuntime.callDeclaredAppOnlyTool — structural ceiling (#1553)", () => {
  it("rejects at the ceiling when the app-only handler never resolves (caller does not hang)", async () => {
    const rt = runtimeWithUiAction(
      "meeting_stage_upload_begin",
      // Never resolves — simulates a hung app-only handler.
      () => new Promise<never>(() => {}),
    );
    await expect(
      // small ceiling via the test seam — the SOT default is untouched
      rt.callDeclaredAppOnlyTool("meeting_stage_upload_begin", {}, 5),
    ).rejects.toThrow(/exceeded global ceiling \(5ms\): meeting_stage_upload_begin/);
  });

  it("returns the handler value when it resolves within the ceiling", async () => {
    const rt = runtimeWithUiAction(
      "meeting_stage_upload_begin",
      async (payload) => ({ echoed: payload }),
    );
    await expect(
      rt.callDeclaredAppOnlyTool("meeting_stage_upload_begin", { chunk: 1 }, 5_000),
    ).resolves.toEqual({ echoed: { chunk: 1 } });
  });

  it("enforces the app-visible tool allowlist BEFORE the ceiling wrap (a non-app-visible method is rejected)", async () => {
    const rt = runtimeWithUiAction("meeting_stage_upload_begin", async () => "ok");
    // A method present in methodMap but NOT declared app-visible must be
    // rejected by assertUiActionInvokable, which runs before runWithCeiling.
    const internals = rt as unknown as {
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    internals.methodMap.set("meeting_not_ui", {
      pluginId: "test.plugin",
      handler: async () => "should-never-run",
    });
    await expect(
      rt.callDeclaredAppOnlyTool("meeting_not_ui", {}, 5_000),
    ).rejects.toThrow(/not declared as a UI action/);
  });
});
