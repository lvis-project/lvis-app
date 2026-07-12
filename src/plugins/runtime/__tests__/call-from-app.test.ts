/**
 * `PluginRuntime.callFromApp` — the MCP App (untrusted `ui://` card) invocation
 * path, and the fix for the verified app-only bypass.
 *
 * THE BUG THIS PINS. A card's `oncalltool` used to reach the plugin through
 * `callFromUi`, i.e. dispatched with `origin: "ui"` — the PANEL's origin. That is
 * the one origin from which `isAppOnlyRuntimeInvocation` routes to
 * `callDeclaredAppOnlyTool`, which skips the ToolExecutor entirely (no
 * `inspectHostRisk`, no reviewer, no approval gate, no audit row). The only thing
 * standing in front of that path was a `userAction` check — and it has a carve-out
 * for the manifest's `auth.statusTool`. Net effect: a hostile (or XSSed) card could
 * invoke the plugin's auth-status tool with attacker-chosen arguments, ungoverned,
 * and read the result. Declaring `["app"]` on an auth-status probe is the idiomatic
 * declaration, so this was live on shipped first-party plugins.
 *
 * The fix is structural, not another check: an MCP App gets its OWN origin
 * (`"mcp-app"`), which never enters the app-only dispatch path at all — so the
 * statusTool carve-out is unreachable from a card rather than merely "hard to hit".
 * From an app, only tools the governed executor can actually run (model-visible AND
 * app-visible ⇒ in the §6.4 registry) are callable; an app-only tool fails CLOSED.
 *
 * Hand-crafted plugins/methodMap internals (the same seam
 * ui-action-ceiling.test.ts / destructive-ui-actions-guard.test.ts use) so the REAL
 * callFromApp / callFromUi run without a plugin entry file.
 */
import { describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRuntime, MCP_APP_TOOL_NOT_APP_CALLABLE } from "../index.js";
import type { PluginToolInvocationContext } from "../index.js";
import type { PluginManifest, Tool } from "../../types.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

type Visibility = Array<"model" | "app">;

function tool(name: string, visibility: Visibility): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    _meta: { ui: { visibility } },
  };
}

/**
 * A started plugin whose manifest declares:
 *  - `acme_open`   — DUAL (model + app): the SEP-1865 default surface, and the only
 *                    kind of tool an MCP App can call (it is a registry `Tool`).
 *  - `acme_stage`  — APP-ONLY: panel-only, not in the registry.
 *  - `acme_status` — APP-ONLY *and* the manifest's `auth.statusTool`: the exact tool
 *                    the bypass handed to an untrusted card.
 *  - `acme_secret` — MODEL-ONLY: not app-visible at all.
 */
function runtimeWithPlugin(handlers: Record<string, (p?: unknown) => Promise<unknown>>) {
  const manifest: PluginManifest = {
    id: "acme-cards",
    name: "acme-cards",
    version: "1.0.0",
    entry: "index.js",
    description: "test fixture",
    tools: [
      tool("acme_open", ["model", "app"]),
      tool("acme_stage", ["app"]),
      tool("acme_status", ["app"]),
      tool("acme_secret", ["model"]),
    ],
    auth: { statusTool: "acme_status", loginTool: "acme_stage" },
  };
  const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
  const internals = rt as unknown as {
    plugins: Map<string, { manifest: PluginManifest }>;
    methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
  };
  internals.plugins.set("acme-cards", { manifest } as unknown as never);
  for (const [name, handler] of Object.entries(handlers)) {
    internals.methodMap.set(name, { pluginId: "acme-cards", handler });
  }
  return rt;
}

function harness() {
  const handler = vi.fn(async (payload?: unknown) => ({ ran: payload }));
  const rt = runtimeWithPlugin({
    acme_open: handler,
    acme_stage: handler,
    acme_status: handler,
    acme_secret: handler,
  });
  // Stands in for the GOVERNED path: boot installs the plugin-surface ToolExecutor
  // (risk → reviewer/approval → audit) as this delegate. Reaching it IS reaching
  // the gate; not reaching it is the bypass.
  const executor = vi.fn(async (_m: string, _p: unknown, _c: PluginToolInvocationContext) => "governed");
  rt.setToolInvocationDelegate(executor);
  // The ungoverned path. It must never be entered from an app origin.
  const appOnlyDispatch = vi.spyOn(rt, "callDeclaredAppOnlyTool");
  return { rt, executor, handler, appOnlyDispatch };
}

describe("PluginRuntime.callFromApp — an MCP App is NOT the plugin's trusted panel", () => {
  it("DENIES an app-only tool, fail-closed, without running its handler", async () => {
    const { rt, executor, handler, appOnlyDispatch } = harness();

    await expect(rt.callFromApp("acme_stage", { chunk: 1 })).rejects.toThrow(
      new RegExp(MCP_APP_TOOL_NOT_APP_CALLABLE),
    );
    // Nothing ran, nowhere: not the ungoverned dispatch, not the executor, not the
    // plugin handler.
    expect(appOnlyDispatch).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("REGRESSION (the verified bypass): denies the app-only tool EVEN when it is the manifest's auth.statusTool", async () => {
    const { rt, executor, handler, appOnlyDispatch } = harness();

    // Pre-fix this exact call succeeded UNGOVERNED: origin "ui" + app-only
    // visibility routed to callDeclaredAppOnlyTool, and
    // `appOnlyRuntimeInvocationRequiresUserAction` returns FALSE for the
    // statusTool, so the `userAction !== true` throw never fired and the raw
    // handler result went straight back to the untrusted card.
    await expect(rt.callFromApp("acme_status", { token: "attacker-chosen" })).rejects.toThrow(
      new RegExp(MCP_APP_TOOL_NOT_APP_CALLABLE),
    );
    expect(appOnlyDispatch).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("gives the card an ACTIONABLE error: the kebab-case code + how to fix the manifest", async () => {
    const { rt } = harness();
    // The IPC handler turns this rejection into `{ ok: false, message }`, which the
    // bridge renders as an `isError` CallToolResult — the card sees this text.
    await expect(rt.callFromApp("acme_stage")).rejects.toThrow(
      /\[mcp-app-tool-not-app-callable\].*acme_stage.*visibility.*\["model","app"\]/s,
    );
  });

  it("routes a DUAL-visibility tool through the governed executor with origin 'mcp-app' and no user gesture", async () => {
    const { rt, executor, appOnlyDispatch } = harness();

    await expect(rt.callFromApp("acme_open", { id: 7 })).resolves.toBe("governed");
    expect(executor).toHaveBeenCalledWith("acme_open", { id: 7 }, {
      origin: "mcp-app",
      ownerPluginId: "acme-cards",
      userAction: false,
    });
    expect(appOnlyDispatch).not.toHaveBeenCalled();
  });

  it("keeps the app-visibility allow-list (the spec MUST): a model-only tool is not app-callable", async () => {
    const { rt, executor } = harness();
    await expect(rt.callFromApp("acme_secret")).rejects.toThrow(/not declared as a UI action/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("fails closed when the executor is not wired (never a direct handler call)", async () => {
    const { handler } = harness();
    const rt = runtimeWithPlugin({ acme_open: handler });
    await expect(rt.callFromApp("acme_open")).rejects.toThrow(/executor is not wired/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an unknown method", async () => {
    const { rt } = harness();
    await expect(rt.callFromApp("nope_open")).rejects.toThrow(/Plugin method not found/);
  });
});

describe("PluginRuntime.callFromUi — the trusted panel keeps its existing behavior", () => {
  it("still dispatches origin 'ui' and still forwards a real user gesture", async () => {
    const { rt, executor } = harness();

    await expect(rt.callFromUi("acme_open", { id: 7 }, { userAction: true })).resolves.toBe("governed");
    expect(executor).toHaveBeenCalledWith("acme_open", { id: 7 }, {
      origin: "ui",
      ownerPluginId: "acme-cards",
      userAction: true,
    });
  });

  it("still reaches app-only tools (incl. the auth.statusTool) — the panel path is NOT regressed", async () => {
    const { rt, executor } = harness();

    // The panel CAN drive app-only methods; boot's `isAppOnlyRuntimeInvocation`
    // then routes them to the runtime dispatch (see plugin-tool-invocation.test.ts).
    // What matters here: callFromUi does not acquire the app arm's app-only deny.
    await expect(rt.callFromUi("acme_stage", {}, { userAction: true })).resolves.toBe("governed");
    await expect(rt.callFromUi("acme_status", {})).resolves.toBe("governed");
    expect(executor).toHaveBeenCalledWith("acme_status", {}, {
      origin: "ui",
      ownerPluginId: "acme-cards",
      userAction: false,
    });
  });
});
