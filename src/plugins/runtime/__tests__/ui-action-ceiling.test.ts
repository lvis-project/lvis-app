/**
 * #1553 (relocated, root-cause) — the uiActions bypass ceiling now lives
 * STRUCTURALLY inside `PluginRuntime.callDeclaredUiAction`, the SOLE entry point
 * of the bypass, rather than in the boot wiring that reaches it. This is the
 * root-cause guard the cluster review asked for: any caller of
 * callDeclaredUiAction is capped regardless of how boot dispatches, so a future
 * revert of the boot wiring back to a direct callDeclaredUiAction call cannot
 * silently drop the ceiling (CLAUDE.md §Tool Execution Timeout Policy: every
 * tool path passes through `runWithCeiling`).
 *
 * The runtime is built with a hand-crafted plugins/methodMap (the same seam
 * destructive-ui-actions-guard.test.ts uses) so the REAL callDeclaredUiAction is
 * exercised without spinning up a plugin entry file. `ceilingMs` is a defaulted
 * (= SOT) parameter used only as a test seam so we can prove the ceiling without
 * waiting the real 120s and without weakening the SOT.
 */
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRuntime } from "../../runtime.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function runtimeWithUiAction(
  method: string,
  handler: (payload?: unknown) => Promise<unknown>,
): PluginRuntime {
  const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
  const internals = rt as unknown as {
    plugins: Map<string, { manifest: { uiActions: Record<string, unknown> } }>;
    methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
  };
  internals.plugins.set("test.plugin", {
    manifest: { uiActions: { [method]: {} } },
  } as unknown as never);
  internals.methodMap.set(method, { pluginId: "test.plugin", handler });
  return rt;
}

describe("PluginRuntime.callDeclaredUiAction — structural ceiling (#1553)", () => {
  it("rejects at the ceiling when the uiActions handler never resolves (caller does not hang)", async () => {
    const rt = runtimeWithUiAction(
      "meeting_stage_upload_begin",
      // Never resolves — simulates a hung uiActions handler.
      () => new Promise<never>(() => {}),
    );
    await expect(
      // small ceiling via the test seam — the SOT default is untouched
      rt.callDeclaredUiAction("meeting_stage_upload_begin", {}, 5),
    ).rejects.toThrow(/exceeded global ceiling \(5ms\): meeting_stage_upload_begin/);
  });

  it("returns the handler value when it resolves within the ceiling", async () => {
    const rt = runtimeWithUiAction(
      "meeting_stage_upload_begin",
      async (payload) => ({ echoed: payload }),
    );
    await expect(
      rt.callDeclaredUiAction("meeting_stage_upload_begin", { chunk: 1 }, 5_000),
    ).resolves.toEqual({ echoed: { chunk: 1 } });
  });

  it("enforces the uiActions allowlist BEFORE the ceiling wrap (a non-uiActions method is rejected)", async () => {
    const rt = runtimeWithUiAction("meeting_stage_upload_begin", async () => "ok");
    // A method present in methodMap but NOT declared in uiActions must be
    // rejected by assertUiActionInvokable, which runs before runWithCeiling.
    const internals = rt as unknown as {
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    internals.methodMap.set("meeting_not_ui", {
      pluginId: "test.plugin",
      handler: async () => "should-never-run",
    });
    await expect(
      rt.callDeclaredUiAction("meeting_not_ui", {}, 5_000),
    ).rejects.toThrow(/not declared as a UI action/);
  });
});
