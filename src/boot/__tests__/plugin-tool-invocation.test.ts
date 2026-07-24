import { describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dispatchAppOnlyRuntimeInvocation,
  isAppOnlyRuntimeInvocation,
  appOnlyRuntimeInvocationRequiresUserAction,
} from "../plugin-tool-invocation.js";
import type { PluginToolInvocationContext } from "../../plugins/runtime.js";
import { TestPluginRuntime as PluginRuntime } from "../../plugins/__tests__/test-helpers.js";
import {
  currentInvocationOrigin,
  runWithInvocationOrigin,
} from "../../plugins/runtime/origin-chain.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { PluginManifest,
  PluginToolOperationPolicy,
  Tool,
} from "../../plugins/types.js";

function manifestTool(
  name: string,
  visibility: Array<"model" | "app">,
  operationPolicy?: PluginToolOperationPolicy,
): Tool {
  return {
      name,
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility },
      ...(operationPolicy ? { "lvisai/operationPolicy": operationPolicy } : {}),
    },
  };
  }

function normalize(
  tools: Tool[],
  auth?: { statusTool: string; loginTool: string; logoutTool?: string },
): PluginManifest {
  return {
    id: "meeting",
    name: "Meeting",
    version: "1.0.0",
    entry: "index.js",
    description: "test fixture",
    tools,
    ...(auth ? { auth } : {}),
  };
}

function runtimeWithManifest(
  tools: Tool[],
  auth?: { statusTool: string; loginTool: string; logoutTool?: string },
) {
  return {
    listPluginManifests: () => [
      {
        pluginId: "meeting",
        manifest: normalize(tools, auth),
      },
    ],
  } as any;
}

describe("plugin app-only runtime invocation", () => {
  it("routes app-only Tool methods through the app handler path", () => {
    expect(
      isAppOnlyRuntimeInvocation(
        runtimeWithManifest([
          manifestTool("meeting_upload_file", ["model"]),
          manifestTool("meeting_stage_upload_begin", ["app"]),
        ]),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(true);
  });

  it("keeps governed app-only tools on ToolExecutor instead of the trusted-panel bypass", () => {
    const manifest = normalize([
      manifestTool("meeting_write", ["app"], {
        discriminant: "operation",
        operations: { save: { kind: "write", minimumRisk: "write", appVisible: true },
      },
    }),
    ]);
    const runtime = { listPluginManifests: () => [{ pluginId: "meeting", manifest }],
    } as any;
    expect(isAppOnlyRuntimeInvocation(runtime, "meeting_write", { origin: "ui", ownerPluginId: "meeting" }, "ui",
      ),
    ).toBe(false);
  });

  it("keeps LLM-facing tools on the ToolExecutor path", () => {
    expect(
      isAppOnlyRuntimeInvocation(
        runtimeWithManifest([
          manifestTool("meeting_upload_file", ["model", "app"]),
        ]),
        "meeting_upload_file",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("does not bypass ToolExecutor for non-UI-origin calls", () => {
    expect(
      isAppOnlyRuntimeInvocation(
        runtimeWithManifest([
          manifestTool("meeting_stage_upload_begin", ["app"]),
        ]),
        "meeting_stage_upload_begin",
        { origin: "plugin", ownerPluginId: "meeting" },
        "plugin",
      ),
    ).toBe(false);
  });

  it("requires the runtime method to be declared app-visible in the owning plugin", () => {
    expect(
      isAppOnlyRuntimeInvocation(
        runtimeWithManifest([
          manifestTool("meeting_upload_file", ["model", "app"]),
        ]),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("keeps manifest tools on the ToolExecutor path even when registry sync is stale", () => {
    expect(
      isAppOnlyRuntimeInvocation(
        runtimeWithManifest([
          manifestTool("meeting_upload_file", ["model", "app"]),
        ]),
        "meeting_upload_file",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("allows auth status polling without a fresh user activation", () => {
    expect(
      appOnlyRuntimeInvocationRequiresUserAction(
        runtimeWithManifest(
          [
            manifestTool("meeting_upload_file", ["model"]),
            manifestTool("auth_status", ["app"]),
            manifestTool("auth_login", ["app"]),
          ],
          { statusTool: "auth_status", loginTool: "auth_login" },
        ),
        "auth_status",
        { origin: "ui", ownerPluginId: "meeting" },
      ),
    ).toBe(false);
  });

  it("requires user activation for non-status app-only actions", () => {
    const runtime = runtimeWithManifest(
      [
        manifestTool("meeting_upload_file", ["model"]),
        manifestTool("auth_status", ["app"]),
        manifestTool("auth_login", ["app"]),
        manifestTool("meeting_stage_upload_begin", ["app"]),
      ],
      { statusTool: "auth_status", loginTool: "auth_login" },
    );

    expect(
      appOnlyRuntimeInvocationRequiresUserAction(
        runtime,
        "auth_login",
        { origin: "ui", ownerPluginId: "meeting",
      }),
    ).toBe(true);
    expect(
      appOnlyRuntimeInvocationRequiresUserAction(
        runtime,
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
      ),
    ).toBe(true);
  });
});

// #1553 (relocated + wiring guard) — the app-only dispatch ceiling now lives
// STRUCTURALLY inside `PluginRuntime.callDeclaredAppOnlyTool` (proven directly at
// the runtime level in plugins/runtime/__tests__/ui-action-ceiling.test.ts).
// This block adds the wiring-level regression guard the cluster review asked
// for: a FAITHFUL reproduction of the production `invokePluginTool` app-only
// branch (boot/steps/plugin-tool-executor.ts) — runWithInvocationOrigin →
// isAppOnlyRuntimeInvocation → dispatchAppOnlyRuntimeInvocation — driven against a
// REAL PluginRuntime. It proves the boot dispatch path reaches that structural
// ceiling, so a hung app-only handler rejects at the global ceiling instead of
// blocking the renderer forever — even if this dispatch were ever reverted to a
// direct `pluginRuntime.callDeclaredAppOnlyTool(...)` call. (The analogous OTHER
// executor branch is reproduced in tools/__tests__/executor-effect-ledger.test.ts.)
// Fake timers advance to the SOT ceiling so the test does not wait the real 120s.
describe("invokePluginTool app-only branch — reaches the structural ceiling (#1553 wiring guard)", () => {
  const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..",
  );

  function realRuntimeWithTools(
    tools: Tool[],
    method: string,
    handler: (payload?: unknown) => Promise<unknown>,
  ): PluginRuntime {
    const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
    const internals = rt as unknown as {
      plugins: Map<string, { manifest: unknown }>;
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    internals.plugins.set("test.plugin", { manifest: normalize(tools),
    } as unknown as never);
    internals.methodMap.set(method, { pluginId: "test.plugin", handler });
    return rt;
  }

  // Faithful reproduction of the production invokePluginTool app-only branch.
  function invokePluginToolRepro(
    rt: PluginRuntime,
    toolName: string,
    payload: Record<string, unknown>,
    context: PluginToolInvocationContext,
  ): Promise<unknown> {
    return runWithInvocationOrigin(context.origin, context.parentOrigin, async () => {
      const effectiveOrigin = currentInvocationOrigin() ?? context.origin;
      if (isAppOnlyRuntimeInvocation(rt, toolName, context, effectiveOrigin)) {
        return dispatchAppOnlyRuntimeInvocation(rt, toolName, payload, context,
          );
      }
      throw new Error("reproduction did not take the app-only branch");
    },
    );
  }

  it("rejects at the global ceiling when an app-only handler hangs (caller does not block)", async () => {
    vi.useFakeTimers();
    try {
      const rt = realRuntimeWithTools(
        [
          manifestTool("meeting_upload_file", ["model"]),
          manifestTool("meeting_stage_upload_begin", ["app"]),
        ],
        "meeting_stage_upload_begin",
        // Never resolves — simulates a hung app-only handler.
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
      await vi.advanceTimersByTimeAsync(
        TOOL_TIMEOUT_POLICY.globalCeilingMs + 1,
      );
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

// #1556 — a nested plugin-origin `ctx.callTool` dispatches with
// `origin: "plugin"` and never forwards `userAction`, even while riding a
// UI-rooted chain via `parentOrigin: "ui"`) targeting an app-only-visibility
// non-status method must throw an error naming the REAL manifest constraint,
// not the generic user-activation error which misleads the plugin author.
describe("dispatchAppOnlyRuntimeInvocation — nested plugin-origin ctx.callTool clarity (#1556)", () => {
  it("throws the explicit app-only-visibility constraint error for a nested plugin-origin call (not the generic activation error)", async () => {
    let handlerCalled = false;
    const runtime = {
      listPluginManifests: () => [
        {
          pluginId: "meeting",
          manifest: normalize([
            manifestTool("meeting_upload_file", ["model"]),
            manifestTool("meeting_stage_upload_begin", ["app"]),
          ]),
        },
      ],
      callDeclaredAppOnlyTool: async () => {
        handlerCalled = true;
        return "unreached";
      },
    } as any;

    const err = await dispatchAppOnlyRuntimeInvocation(
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
      /app-only-visibility method .* cannot be invoked from a plugin-origin ctx\.callTool/,
    );
    // Must NOT be the old, misleading generic activation error.
    expect((err as Error).message).not.toMatch(
      /requires an active user activation/,
    );
    // The constraint is detected before dispatch — the handler is never run.
    expect(handlerCalled).toBe(false);
  });

  it("keeps the generic user-activation error for a genuine direct-UI call without activation", async () => {
    const runtime = {
      listPluginManifests: () => [
        {
          pluginId: "meeting",
          manifest: normalize([
            manifestTool("meeting_upload_file", ["model"]),
            manifestTool("meeting_stage_upload_begin", ["app"]),
          ]),
        },
      ],
      callDeclaredAppOnlyTool: async () => "unreached",
    } as any;

    await expect(
      dispatchAppOnlyRuntimeInvocation(
        runtime,
        "meeting_stage_upload_begin",
        {},
        { origin: "ui", ownerPluginId: "meeting" }, // direct UI, no userAction
      ),
    ).rejects.toThrow(/requires an active user activation/);
  });
});

// Defense-in-depth (cluster-review security LOW) — dispatchAppOnlyRuntimeInvocation
// is exported and must re-assert the app-only routing invariant at the boundary,
// not merely trust the caller's isAppOnlyRuntimeInvocation predicate. A caller
// that mis-routes a model-visible method here must be refused BEFORE the
// reviewer-skipping app-only dispatch bypass runs.
describe("dispatchAppOnlyRuntimeInvocation — boundary routing gate (security defense-in-depth)", () => {
  it("refuses a model-visible tool even when the caller mis-routes it to the bypass", async () => {
    let handlerCalled = false;
    const runtime = {
      listPluginManifests: () => [
        {
          pluginId: "meeting",
          manifest: normalize([
            manifestTool("meeting_upload_file", ["model", "app"]),
          ]),
        },
      ],
      callDeclaredAppOnlyTool: async () => {
        handlerCalled = true;
        return "unreached";
      },
    } as any;

    await expect(
      dispatchAppOnlyRuntimeInvocation(
        runtime,
        "meeting_upload_file",
        {},
        { origin: "ui", ownerPluginId: "meeting", userAction: true },
      ),
    ).rejects.toThrow(
      /is a model-visible tool; refusing ungoverned app-only dispatch/,
    );
    // The bypass handler is never reached — the boundary gate fails closed.
    expect(handlerCalled).toBe(false);
  });

  it("allows an app-only method (not model-visible) through the bypass", async () => {
    const callDeclaredAppOnlyTool = vi.fn(
      async (_method: string, payload: unknown) => ({
        ok: payload,
      }),
    );
    const runtime = {
      listPluginManifests: () => [
        {
          pluginId: "meeting",
          manifest: normalize([
            manifestTool("meeting_upload_file", ["model"]),
            manifestTool("meeting_stage_upload_begin", ["app"]),
          ]),
        },
      ],
      callDeclaredAppOnlyTool,
    } as any;

    await expect(
      dispatchAppOnlyRuntimeInvocation(
        runtime,
        "meeting_stage_upload_begin",
        { chunk: 2 },
        {
          origin: "ui",
          ownerPluginId: "meeting",
          ownerGenerationId: "generation-exact",
          userAction: true,
        },
      ),
    ).resolves.toEqual({ ok: { chunk: 2 } });
    expect(callDeclaredAppOnlyTool).toHaveBeenCalledWith(
      "meeting_stage_upload_begin",
      { chunk: 2 },
      undefined,
      "generation-exact",
    );
  });
});

// ─── MCP App origin ("mcp-app") — the app-only bypass is UNREACHABLE ───────────
//
// An MCP App is untrusted HTML in a sandboxed iframe; it is NOT the plugin's
// first-party React panel. It therefore dispatches with its OWN origin, and the
// app-only dispatch predicate answers "ui" and nothing else. The point of testing
// the PREDICATE (rather than only the runtime deny) is that this is the structural
// half of the fix: even if a future manifest/visibility change made an app-only
// tool look dispatchable, an app-origin chain still cannot select the bypass — and
// therefore cannot reach the `auth.statusTool` user-activation carve-out, which is
// what the verified exploit rode.
describe("isAppOnlyRuntimeInvocation — an MCP App origin never selects the ungoverned bypass", () => {
  const appOnlyRuntime = () =>
    runtimeWithManifest(
      [
        manifestTool("meeting_upload_file", ["model"]),
        manifestTool("meeting_stage_upload_begin", ["app"]),
        manifestTool("auth_status", ["app"]),
      ],
      { statusTool: "auth_status", loginTool: "meeting_stage_upload_begin" },
    );

  it("is false for an app-only tool called from an app (the panel's 'ui' answer is true)", () => {
    expect(
      isAppOnlyRuntimeInvocation(
        appOnlyRuntime(),
        "meeting_stage_upload_begin",
        { origin: "mcp-app", ownerPluginId: "meeting", userAction: false },
        "mcp-app",
      ),
    ).toBe(false);
    // Same tool, trusted panel origin → still true (the panel path is NOT regressed).
    expect(
      isAppOnlyRuntimeInvocation(
        appOnlyRuntime(),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting", userAction: true },
        "ui",
      ),
    ).toBe(true);
  });

  it("REGRESSION PIN: is false for the manifest's auth.statusTool called from an app", () => {
    // The exploited tool. `appOnlyRuntimeInvocationRequiresUserAction` returns
    // FALSE for it (status polling has no gesture), so if an app-origin call could
    // reach the app-only dispatch path, NOTHING would stop it. The origin check is
    // what stops it — one level earlier, structurally.
    expect(
      appOnlyRuntimeInvocationRequiresUserAction(
        appOnlyRuntime(),
        "auth_status",
        { origin: "mcp-app", ownerPluginId: "meeting" },
      ),
    ).toBe(false); // ← the carve-out still exists…
    expect(
      isAppOnlyRuntimeInvocation(
        appOnlyRuntime(),
        "auth_status",
        { origin: "mcp-app", ownerPluginId: "meeting", userAction: false },
        "mcp-app",
      ),
    ).toBe(false); // ← …and is unreachable from an app: the bypass is never selected.
  });

  it("is false for a dual-visibility tool called from an app (it takes the governed executor)", () => {
    expect(
      isAppOnlyRuntimeInvocation(
        runtimeWithManifest([
          manifestTool("meeting_upload_file", ["model", "app"]),
        ]),
        "meeting_upload_file",
        { origin: "mcp-app", ownerPluginId: "meeting", userAction: false },
        "mcp-app",
      ),
    ).toBe(false);
  });
});

// The chain must not be able to LAUNDER an app origin into the panel origin: if an
// app-rooted chain could inherit "ui" from an outer frame (or decay to "plugin" on
// a nested ctx.callTool), the structural guarantee above would hold only at depth 0.
describe("runWithInvocationOrigin — an mcp-app chain cannot be laundered", () => {
  it("keeps 'mcp-app' through a nested plugin-origin ctx.callTool hop", async () => {
    await runWithInvocationOrigin("mcp-app", undefined, async () => {
      expect(currentInvocationOrigin()).toBe("mcp-app");
      // The inner ctx.callTool hop uses origin "plugin", with no parentOrigin.
      await runWithInvocationOrigin("plugin", undefined, async () => {
        expect(currentInvocationOrigin()).toBe("mcp-app");
      });
    });
  });

  it("refuses to be re-labelled 'ui' by an inner frame's current or parentOrigin", async () => {
    await runWithInvocationOrigin("mcp-app", undefined, async () => {
      await runWithInvocationOrigin("ui", "ui", async () => {
        expect(currentInvocationOrigin()).toBe("mcp-app");
      });
      await runWithInvocationOrigin("plugin", "ui", async () => {
        expect(currentInvocationOrigin()).toBe("mcp-app");
      });
    });
  });

  it("still resolves a UI-rooted chain to 'ui' and a plugin-only chain to 'plugin' (#664 P2 intact)", async () => {
    await runWithInvocationOrigin("ui", undefined, async () => {
      await runWithInvocationOrigin("plugin", undefined, async () => {
        expect(currentInvocationOrigin()).toBe("ui");
      });
    });
    await runWithInvocationOrigin("plugin", undefined, async () => {
      expect(currentInvocationOrigin()).toBe("plugin");
    });
  });
});

// End-to-end through the production dispatch shape (the same faithful repro of
// boot/steps/plugin-tool-executor.ts's `invokePluginTool` used above), driven
// against a REAL PluginRuntime: which BRANCH does an app-origin call take?
describe("invokePluginTool routing — app-origin calls land on the governed executor, never the bypass", () => {
  const HOST_ROOT_2 = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );

  function realRuntime(
    tools: Tool[],
    auth?: { statusTool: string; loginTool: string },
  ): PluginRuntime {
    const rt = new PluginRuntime({ hostRoot: HOST_ROOT_2, manifestPaths: [] });
    const internals = rt as unknown as {
      plugins: Map<string, { manifest: unknown }>;
      methodMap: Map<
        string,
        { pluginId: string; handler: (p?: unknown) => Promise<unknown> }
      >;
    };
    const m = normalize(tools, auth);
    internals.plugins.set("meeting", { manifest: m } as unknown as never);
    for (const t of m.tools) {
      internals.methodMap.set(t.name, {
        pluginId: "meeting",
        handler: async () => "raw-handler",
      });
    }
    return rt;
  }

  /** Faithful reproduction of the production invokePluginTool BRANCH selection. */
  function routeOf(
    rt: PluginRuntime,
    toolName: string,
    context: PluginToolInvocationContext,
  ): Promise<"app-only-dispatch" | "governed-executor"> {
    return runWithInvocationOrigin(
      context.origin,
      context.parentOrigin,
      async () => {
        const effectiveOrigin = currentInvocationOrigin() ?? context.origin;
        return isAppOnlyRuntimeInvocation(
          rt,
          toolName,
          context,
          effectiveOrigin,
        )
          ? "app-only-dispatch"
          : "governed-executor";
      },
    );
  }

  const tools = [
    manifestTool("meeting_upload_file", ["model", "app"]),
    manifestTool("meeting_stage_upload_begin", ["app"]),
    manifestTool("auth_status", ["app"]),
  ];
  const auth = {
    statusTool: "auth_status",
    loginTool: "meeting_stage_upload_begin",
  };

  it("app origin + app-only tool → governed executor branch (and the runtime dispatches it THERE)", async () => {
    const rt = realRuntime(tools, auth);
    const ctx: PluginToolInvocationContext = {
      origin: "mcp-app",
      ownerPluginId: "meeting",
      userAction: false,
    };
    await expect(routeOf(rt, "meeting_stage_upload_begin", ctx)).resolves.toBe(
      "governed-executor",
    );
    // …and that branch is where the app arm actually sends it: an app-only tool is a
    // §6.4 registry Tool (the loopback projects it), so PluginRuntime.callFromApp
    // hands it to the executor — risk → reviewer/approval → audit — rather than
    // denying it for want of a gate. What it never gets is the panel's ungoverned
    // dispatch. (Proven in plugins/runtime/__tests__/call-from-app.test.ts.)
  });

  it("app origin + auth.statusTool → governed executor branch (the bypass is not selected)", async () => {
    const rt = realRuntime(tools, auth);
    await expect(
      routeOf(rt, "auth_status", {
        origin: "mcp-app",
        ownerPluginId: "meeting",
        userAction: false,
      }),
    ).resolves.toBe("governed-executor");
  });

  it("app origin + DUAL tool → governed executor branch", async () => {
    const rt = realRuntime(tools, auth);
    await expect(
      routeOf(rt, "meeting_upload_file", {
        origin: "mcp-app",
        ownerPluginId: "meeting",
        userAction: false,
      }),
    ).resolves.toBe("governed-executor");
  });

  it("panel origin + app-only tool → app-only dispatch branch (unchanged, incl. the statusTool)", async () => {
    const rt = realRuntime(tools, auth);
    await expect(
      routeOf(rt, "meeting_stage_upload_begin", {
        origin: "ui",
        ownerPluginId: "meeting",
        userAction: true,
      }),
    ).resolves.toBe("app-only-dispatch");
    await expect(
      routeOf(rt, "auth_status", { origin: "ui", ownerPluginId: "meeting" }),
    ).resolves.toBe("app-only-dispatch");
  });
});
