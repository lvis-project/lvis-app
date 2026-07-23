/**
 * `PluginRuntime.callFromApp` — the MCP App (untrusted `ui://` card) invocation
 * path: what a card may call, and which path it lands on.
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
 *
 * What it is NOT is a ban on app-only tools. `["app"]` is the spec's spelling for a
 * tool that serves the CARD and is hidden from the model, and the loopback now
 * projects such tools into `tools/list`, so they ARE §6.4 registry `Tool`s the
 * governed executor can run. So a card may call one — through the GATE.
 *
 * ONE NAMED EXCEPTION on top of that: the plugin's manifest-declared auth trio
 * (`auth.statusTool` / `auth.loginTool` / `auth.logoutTool`) is denied to a card
 * OUTRIGHT, governed or not. That is not the spec's `["app"]` semantics — it is an
 * LVIS narrowing, because the trio's intended caller has always been the plugin's
 * own trusted panel, and `auth.loginTool` in particular opens a real credentialed
 * auth `BrowserWindow`. Letting an untrusted card summon that window is a privilege
 * escalation even behind the approval gate: approval-gating a phishing-shaped
 * affordance is not the same as not having it. Every other app-only tool is
 * governed-and-callable; the trio is governed-and-*still* card-unreachable.
 *
 * Hand-crafted plugins/methodMap internals (the same seam
 * ui-action-ceiling.test.ts / destructive-ui-actions-guard.test.ts use) so the REAL
 * callFromApp / callFromUi run without a plugin entry file.
 */
import { describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE } from "../index.js";
import { TestPluginRuntime as PluginRuntime } from "../../__tests__/test-helpers.js";
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
 *  - `acme_open`     — DUAL (model + app): the SEP-1865 default surface.
 *  - `acme_ui_rows`  — APP-ONLY, NON-auth: a card-serving tool (e.g. "list the
 *                      rows for my card"). Governed, and card-callable — this is
 *                      what `["app"]` is FOR.
 *  - `acme_status` / `acme_login` / `acme_logout` — the manifest's auth trio
 *    (`auth.statusTool` / `auth.loginTool` / `auth.logoutTool`), all APP-ONLY.
 *    `acme_login` is the exact shape of the verified bypass AND the tool the new
 *    narrowing exists for: it opens a credentialed auth window.
 *  - `acme_secret`   — MODEL-ONLY: not app-visible at all.
 *
 * `manifest.auth` is the SOT the deny reads from — tests below derive the denied
 * names FROM this object rather than repeating string literals, so the assertion
 * covers "whatever a plugin names its auth tools", not just this fixture's choice.
 */
const MANIFEST: PluginManifest = {
  id: "acme-cards",
  name: "acme-cards",
  version: "1.0.0",
  entry: "index.js",
  description: "test fixture",
  tools: [
    tool("acme_open", ["model", "app"]),
    tool("acme_ui_rows", ["app"]),
    tool("acme_status", ["app"]),
    tool("acme_login", ["app"]),
    tool("acme_logout", ["app"]),
    tool("acme_secret", ["model"]),
  ],
  auth: { statusTool: "acme_status", loginTool: "acme_login", logoutTool: "acme_logout" },
};

/** Derived from the manifest, never hardcoded again below. */
const AUTH_TOOL_NAMES = [MANIFEST.auth!.statusTool, MANIFEST.auth!.loginTool, MANIFEST.auth!.logoutTool!];

function runtimeWithPlugin(handlers: Record<string, (p?: unknown) => Promise<unknown>>) {
  const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
  const internals = rt as unknown as {
    plugins: Map<string, { manifest: PluginManifest }>;
    methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
  };
  internals.plugins.set("acme-cards", { manifest: MANIFEST } as unknown as never);
  for (const [name, handler] of Object.entries(handlers)) {
    internals.methodMap.set(name, { pluginId: "acme-cards", handler });
  }
  return rt;
}

function harness() {
  const handler = vi.fn(async (payload?: unknown) => ({ ran: payload }));
  const rt = runtimeWithPlugin({
    acme_open: handler,
    acme_ui_rows: handler,
    acme_status: handler,
    acme_login: handler,
    acme_logout: handler,
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

describe("PluginRuntime.callFromApp — a card's calls are GOVERNED, and only governed", () => {
  it("routes a NON-AUTH app-only tool through the governed executor — not the ungoverned dispatch, not the raw handler", async () => {
    const { rt, executor, handler, appOnlyDispatch } = harness();

    await expect(rt.callFromApp("acme_ui_rows", { chunk: 1 })).resolves.toBe("governed");
    // The gate ran…
    expect(executor).toHaveBeenCalledWith("acme_ui_rows", { chunk: 1 }, {
      origin: "mcp-app",
      ownerPluginId: "acme-cards",
      ownerGenerationId: expect.any(String),
      userAction: false,
    });
    // …and the reviewer-skipping path did not. This is the whole point: `["app"]`
    // now WORKS for a plugin (its card can drive its own tools) *because* the tool
    // is a registry `Tool` the executor can run — not because the gate was relaxed.
    expect(appOnlyDispatch).not.toHaveBeenCalled();
    // The runtime never calls the plugin handler itself; the executor owns that.
    expect(handler).not.toHaveBeenCalled();
  });

  it("routes a DUAL-visibility tool through the governed executor with origin 'mcp-app' and no user gesture", async () => {
    const { rt, executor, appOnlyDispatch } = harness();

    await expect(rt.callFromApp("acme_open", { id: 7 })).resolves.toBe("governed");
    expect(executor).toHaveBeenCalledWith("acme_open", { id: 7 }, {
      origin: "mcp-app",
      ownerPluginId: "acme-cards",
      ownerGenerationId: expect.any(String),
      userAction: false,
    });
    expect(appOnlyDispatch).not.toHaveBeenCalled();
  });

  it("NEVER credits a card with a user gesture — every app call dispatches userAction:false", async () => {
    const { rt, executor } = harness();
    // There is no `userAction` parameter on this method at all; the card's claim is
    // unverifiable (the guest iframe's activation is not the host frame's).
    await rt.callFromApp("acme_open");
    await rt.callFromApp("acme_ui_rows");
    for (const call of executor.mock.calls) {
      expect(call[2]).toMatchObject({ origin: "mcp-app", userAction: false });
    }
  });

  it("keeps the app-visibility allow-list (the spec MUST): a MODEL-ONLY tool is not app-callable", async () => {
    const { rt, executor } = harness();
    await expect(rt.callFromApp("acme_secret")).rejects.toThrow(/not declared as a UI action/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("fails closed when the executor is not wired (never a direct handler call)", async () => {
    const { handler } = harness();
    const rt = runtimeWithPlugin({ acme_open: handler, acme_ui_rows: handler });
    // Both surfaces: with no gate wired there is nowhere safe to run either one.
    await expect(rt.callFromApp("acme_open")).rejects.toThrow(/executor is not wired/);
    await expect(rt.callFromApp("acme_ui_rows")).rejects.toThrow(/executor is not wired/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an unknown method", async () => {
    const { rt } = harness();
    await expect(rt.callFromApp("nope_open")).rejects.toThrow(/Plugin method not found/);
  });

  describe("THE AUTH-TRIO CARVE-OUT — deliberate narrowing below the spec's [\"app\"] semantics", () => {
    it("DENIES every manifest.auth.{statusTool,loginTool,logoutTool} name, fail-closed, without running the handler, the executor, or the ungoverned dispatch", async () => {
      for (const name of AUTH_TOOL_NAMES) {
        const { rt, executor, handler, appOnlyDispatch } = harness();

        await expect(rt.callFromApp(name, { token: "attacker-chosen" })).rejects.toThrow(
          new RegExp(MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE),
        );
        // Nothing ran, nowhere: not the governed executor, not the ungoverned
        // dispatch, not the plugin handler. This is STRICTER than an ordinary
        // app-only tool (which DOES reach the executor) — that gap is the point.
        expect(executor, name).not.toHaveBeenCalled();
        expect(appOnlyDispatch, name).not.toHaveBeenCalled();
        expect(handler, name).not.toHaveBeenCalled();
      }
    });

    it("REGRESSION (the verified bypass): auth.loginTool — the one that opens a credentialed BrowserWindow — is denied, not merely gated", async () => {
      const { rt, executor, handler, appOnlyDispatch } = harness();

      // Pre-fix (the original bug) this succeeded UNGOVERNED via the panel-origin
      // bypass. After the governed-registration fix alone, it would have succeeded
      // GOVERNED — which is still wrong for THIS specific tool: an approval prompt
      // does not make "an untrusted card can pop a real login window" acceptable.
      await expect(rt.callFromApp(MANIFEST.auth!.loginTool, {})).rejects.toThrow(
        new RegExp(MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE),
      );
      expect(executor).not.toHaveBeenCalled();
      expect(appOnlyDispatch).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it("gives the card an ACTIONABLE, English, kebab-case error naming the real constraint", async () => {
      const { rt } = harness();
      await expect(rt.callFromApp(MANIFEST.auth!.statusTool)).rejects.toThrow(
        new RegExp(`\\[${MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE}\\].*acme_status.*trusted panel`, "s"),
      );
    });

    it("denies the auth trio even when the executor delegate is never wired (the deny fires before that check)", async () => {
      const { handler } = harness();
      const rt = runtimeWithPlugin({ acme_status: handler, acme_login: handler, acme_logout: handler });
      for (const name of AUTH_TOOL_NAMES) {
        await expect(rt.callFromApp(name)).rejects.toThrow(new RegExp(MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE));
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it("does NOT touch a non-auth app-only tool — the contrast is the whole point", async () => {
      const { rt, executor } = harness();
      // Same visibility shape (["app"]) as the auth trio, but not named in
      // manifest.auth — so it stays governed-and-callable, unlike the trio.
      await expect(rt.callFromApp("acme_ui_rows", { page: 1 })).resolves.toBe("governed");
      expect(executor).toHaveBeenCalledWith("acme_ui_rows", { page: 1 }, expect.any(Object));
    });
  });
});

describe("PluginRuntime.callFromUi — the trusted panel keeps its existing behavior", () => {
  it("still dispatches origin 'ui' and still forwards a real user gesture", async () => {
    const { rt, executor } = harness();

    await expect(rt.callFromUi("acme_open", { id: 7 }, { userAction: true })).resolves.toBe("governed");
    expect(executor).toHaveBeenCalledWith("acme_open", { id: 7 }, {
      origin: "ui",
      ownerPluginId: "acme-cards",
      ownerGenerationId: expect.any(String),
      userAction: true,
    });
  });

  it("still reaches the auth trio (incl. auth.loginTool) on the panel's own origin — the carve-out is callFromApp-only, NOT regressed here", async () => {
    const { rt, executor } = harness();

    // The panel CAN drive app-only methods, auth trio included; boot's
    // `isAppOnlyRuntimeInvocation` then routes them to the runtime dispatch (see
    // plugin-tool-invocation.test.ts). What matters here: callFromUi never acquired
    // the card arm's auth-trio deny — it keeps dispatching `origin: "ui"`, the ONE
    // origin that can carry a real gesture and the ONE origin the bypass answers to.
    for (const name of AUTH_TOOL_NAMES) {
      await expect(rt.callFromUi(name, {}, { userAction: true })).resolves.toBe("governed");
    }
    expect(executor).toHaveBeenCalledWith(MANIFEST.auth!.loginTool, {}, {
      origin: "ui",
      ownerPluginId: "acme-cards",
      ownerGenerationId: expect.any(String),
      userAction: true,
    });
  });
});
