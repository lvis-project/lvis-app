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
 * plugin-app-visibility-guard.test.ts uses) so the REAL callDeclaredAppOnlyTool is
 * exercised without spinning up a plugin entry file. `ceilingMs` is a defaulted
 * (= SOT) parameter used only as a test seam so we can prove the ceiling without
 * waiting the real 120s and without weakening the SOT.
 */
import { describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestPluginRuntime as PluginRuntime } from "../../__tests__/test-helpers.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function runtimeWithAppVisibleTool(
  method: string,
  handler: (payload?: unknown) => Promise<unknown>,
): PluginRuntime {
  const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
  const internals = rt as unknown as {
    plugins: Map<string, { manifest: unknown }>;
    methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
  };
  // The runtime method is one app-only Tool.
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
    const rt = runtimeWithAppVisibleTool(
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
    const rt = runtimeWithAppVisibleTool(
      "meeting_stage_upload_begin",
      async (payload) => ({ echoed: payload }),
    );
    await expect(
      rt.callDeclaredAppOnlyTool("meeting_stage_upload_begin", { chunk: 1 }, 5_000),
    ).resolves.toEqual({ echoed: { chunk: 1 } });
  });

  it("rejects an app-only invocation pinned to a stale generation", async () => {
    const handler = vi.fn(async () => "must-not-run");
    const rt = runtimeWithAppVisibleTool(
      "meeting_stage_upload_begin",
      handler,
    );

    await expect(
      rt.callDeclaredAppOnlyTool(
        "meeting_stage_upload_begin",
        {},
        5_000,
        "stale-generation",
      ),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("retains the exact generation lease until a ceiling-detached handler settles", async () => {
    let settle!: (value: unknown) => void;
    const handler = vi.fn(
      () =>
        new Promise<unknown>((resolvePromise) => {
          settle = resolvePromise;
        }),
    );
    const method = "meeting_stage_upload_begin";
    const rt = runtimeWithAppVisibleTool(method, handler);
    const release = vi.fn();
    const manifest = {
      tools: [{
        name: method,
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      }],
    };
    const generation = {
      pluginId: "test.plugin",
      generationId: "generation-current",
      state: {
        runtime: {
          manifest,
          methods: new Map([[method, handler]]),
        },
      },
    };
    rt.setGenerationAccess({
      getActive: vi.fn(() => generation),
      acquire: vi.fn(async () => ({ generation, release })),
      acquireExact: vi.fn(async (
        _pluginId: string,
        expectedGenerationId: string,
      ) => {
        if (expectedGenerationId !== generation.generationId) {
          throw new Error("stale generation");
        }
        return { generation, release };
      }),
      runWithLease: vi.fn(async (
        _lease: unknown,
        operation: () => Promise<unknown>,
      ) => operation()),
      replaceRuntime: vi.fn(),
    } as never);

    await expect(
      rt.callDeclaredAppOnlyTool(
        method,
        {},
        5,
        generation.generationId,
      ),
    ).rejects.toThrow(/exceeded global ceiling/);
    expect(release).not.toHaveBeenCalled();

    settle("late completion");
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 0);
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("enforces the app-visible tool allowlist BEFORE the ceiling wrap (a non-app-visible method is rejected)", async () => {
    const rt = runtimeWithAppVisibleTool("meeting_stage_upload_begin", async () => "ok");
    // A method present in methodMap but NOT declared app-visible must be
    // rejected by app-visible Tool admission, which runs before runWithCeiling.
    const internals = rt as unknown as {
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    internals.methodMap.set("meeting_not_ui", {
      pluginId: "test.plugin",
      handler: async () => "should-never-run",
    });
    await expect(
      rt.callDeclaredAppOnlyTool("meeting_not_ui", {}, 5_000),
    ).rejects.toThrow(/not an app-visible Tool/);
  });
});
