import "../../../../test/renderer/setup.ts";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../../../test/renderer/render-app.js";

describe("App plugin auth routing", () => {
  // #1311 (input-area relayout) removed the standalone plugin-grid button from
  // the action bar; plugin views are now reached through the unified
  // SlashPicker. These helpers drive a plugin selection through the new entry
  // point: open the picker, drill into the 플러그인(plugin) category, then click
  // the plugin's view row by its label. The auth/detach SECURITY behavior under
  // test is unchanged — selection still routes through the same App
  // handleViewSelect path — only the UI affordance moved.
  const openPluginCategory = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByTestId("command-popover-trigger"));
    await user.click(await screen.findByTestId("slash-picker-cat-plugin"));
  };
  const selectPluginView = async (
    user: ReturnType<typeof userEvent.setup>,
    label: string,
  ) => {
    await openPluginCategory(user);
    // Scope the row lookup to the picker's plugin group — the plugin's own
    // title can also appear elsewhere in the tree (e.g. a loaded inline view).
    const group = await screen.findByTestId("slash-group-plugin");
    await user.click(await within(group).findByText(label));
  };
  const detachedPluginFixture = {
    pluginCards: [
      {
        id: "token-plugin",
        name: "Token Plugin",
        description: "Uses plugin UI auth",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "loaded" as const,
        auth: {
          statusTool: "token_status",
          loginTool: "token_login",
        },
      },
    ],
    pluginUiExtensions: [
      {
        pluginId: "token-plugin",
        extension: {
          id: "main",
          slot: "sidebar",
          kind: "embedded-module",
          title: "Token Plugin",
          entry: "dist/ui.js",
        },
        entryUrl: "file:///token-plugin/dist/ui.js",
      },
    ],
  };

  it("surfaces a preparing plugin's view as a selectable entry in the picker's plugin category", async () => {
    // The preparing-cell visual detail (aria-busy, phase/progress label, title)
    // is asserted directly against the component in
    // PluginGridButton.test.tsx ("shows preparation detail for preparing
    // registered plugin cells"). At the App level after #1311 the contract is:
    // a preparing plugin card that declares a UI extension still appears as a
    // reachable entry inside the SlashPicker's 플러그인 category.
    const user = userEvent.setup();
    const { api } = await renderApp({
      pluginCards: [
        {
          id: "local-indexer",
          name: "LVIS Local Indexer",
          description: "Indexes local documents",
          sampleTools: [],
          capabilities: [],
          tools: [],
          loadStatus: "preparing",
          preparationStatus: {
            phase: "installing-python",
            message: "Python 3.12 설치 중...",
            progressPct: 10,
            updatedAt: "2026-05-21T00:00:00.000Z",
          },
          icon: "Plug",
          uiExtensions: [
            {
              id: "local-indexer-control",
              slot: "sidebar",
              kind: "embedded-module",
              title: "로컬 인덱서",
              entry: "dist/ui/indexer-control.js",
            },
          ],
        },
      ],
      pluginUiExtensions: [],
    });

    await waitFor(() => {
      expect(api.listPluginCards).toHaveBeenCalled();
    });

    await openPluginCategory(user);
    const group = await screen.findByTestId("slash-group-plugin");
    expect(await within(group).findByText("로컬 인덱서")).toBeInTheDocument();
  });

  it("detached unauthenticated auth plugin → host fires loginTool and does NOT open the panel (login-first)", async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(detachedPluginFixture);
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: false } : { ok: true },
    );

    // Detachment is owned by the app's mode, not the plugin: enter chat mode so
    // selecting any plugin view routes through the detached-window path.
    await user.click(screen.getByTestId("app-mode-chat"));

    await selectPluginView(user, "Token Plugin");

    // Auth is a host-managed lifecycle (architecture.md §9.4a): for an unauthed
    // auth plugin the host fires the loginTool (opens the SSO window ONLY)...
    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("token_login");
    });
    // ...and must NOT open the detached panel until the plugin reports authed.
    expect(api.window.openDetached).not.toHaveBeenCalled();
  });

  it("detached authenticated auth plugin → host opens the panel without firing loginTool", async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(detachedPluginFixture);
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: true } : { ok: true },
    );

    await user.click(screen.getByTestId("app-mode-chat"));
    await selectPluginView(user, "Token Plugin");

    // Already authed → open the detached panel directly, no login round-trip.
    await waitFor(() => {
      expect(api.window.openDetached).toHaveBeenCalledWith("plugin:token-plugin:main");
    });
    expect(api.callPluginMethod).not.toHaveBeenCalledWith("token_login");
  });

  it("detached login completes → host opens the deferred panel on the unauthed→authed transition", async () => {
    const user = userEvent.setup();
    const { api, emitPluginEvent } = await renderApp(detachedPluginFixture);
    // Start unauthenticated.
    let authed = false;
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: authed } : { ok: true },
    );

    await user.click(screen.getByTestId("app-mode-chat"));
    await selectPluginView(user, "Token Plugin");

    // Unauthed: host fires loginTool (opens SSO window) and DEFERS the panel.
    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("token_login");
    });
    expect(api.window.openDetached).not.toHaveBeenCalled();

    // Login completes: status flips to authed and the plugin emits
    // `<pluginId>.auth.changed`, which re-fetches status. The host's one-shot
    // effect then opens the DEFERRED panel (login-window-closes → panel-opens).
    authed = true;
    emitPluginEvent("token-plugin.auth.changed", { authenticated: true });

    await waitFor(() => {
      expect(api.window.openDetached).toHaveBeenCalledWith("plugin:token-plugin:main");
    });
  });

  it("detached login failure opens the plugin panel and surfaces a safe auth error code", async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(detachedPluginFixture);
    const nonCorpError = Object.assign(new Error("[non-corp-network] outside corporate network"), {
      code: "non-corp-network",
    });
    api.callPluginMethod.mockImplementation(async (tool: string) => {
      if (tool === "token_status") return { authenticated: false };
      if (tool === "token_login") throw nonCorpError;
      return { ok: true };
    });

    await user.click(screen.getByTestId("app-mode-chat"));
    await selectPluginView(user, "Token Plugin");

    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("token_login");
    });
    await waitFor(() => {
      expect(api.window.openDetached).toHaveBeenCalledWith("plugin:token-plugin:main");
    });
    expect(await screen.findByText(/code: non-corp-network/)).toBeInTheDocument();
    expect(screen.getByText(/사내망 또는 VPN 연결이 필요합니다/)).toBeInTheDocument();
  });

  it("routes command-palette plugin actions through detached-window handling (authed)", async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(detachedPluginFixture);
    // Authed so the command-palette selection reaches the detached-open path
    // (an unauthed auth plugin would route to loginTool instead).
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: true } : { ok: true },
    );

    await waitFor(() => {
      expect(api.listPluginUiExtensions).toHaveBeenCalled();
    });
    // appMode (chat) is the sole authority for detaching, so put the app in
    // chat mode before dispatching the command-palette action.
    await user.click(screen.getByTestId("app-mode-chat"));
    await user.click(screen.getByTestId("command-popover-trigger"));
    // The unified SlashPicker opens on a category drill-down; the plugin-view
    // QuickAction ("…열기") lives under the 바로가기/shortcut group. Drill into
    // it, then select the action.
    await user.click(await screen.findByTestId("slash-picker-cat-shortcut"));
    await user.click(await screen.findByText("Token Plugin 열기"));

    await waitFor(() => {
      expect(api.window.openDetached).toHaveBeenCalledWith("plugin:token-plugin:main");
    });
    expect(api.callPluginMethod).not.toHaveBeenCalledWith("token_login");
  });

  it("surfaces detached-window open failures instead of dropping them", async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(detachedPluginFixture);
    api.window.openDetached.mockResolvedValueOnce({ ok: false, error: "window denied" });
    // Authed so selection reaches openDetached (the failure path under test);
    // an unauthed auth plugin would route to loginTool and never open a window.
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: true } : { ok: true },
    );

    // Chat mode routes the selection through openDetached so the failure path
    // under test is reachable (action mode would render inline, never detaching).
    await user.click(screen.getByTestId("app-mode-chat"));

    await selectPluginView(user, "Token Plugin");

    await waitFor(() => {
      expect(screen.getByText(/플러그인 창을 열 수 없습니다/)).toBeInTheDocument();
    });
    expect(screen.getByText(/window denied/)).toBeInTheDocument();
  });

  it("auto-calls loginTool for an unauthenticated inline embedded view before navigating", async () => {
    const { api, emitPluginEvent } = await renderApp({
      pluginCards: [
        {
          id: "oauth-plugin",
          name: "OAuth Plugin",
          description: "Uses host auth",
          sampleTools: [],
          capabilities: [],
          tools: [],
          loadStatus: "loaded",
          auth: {
            statusTool: "oauth_status",
            loginTool: "oauth_login",
          },
        },
      ],
      pluginUiExtensions: [
        {
          pluginId: "oauth-plugin",
          extension: {
            id: "main",
            slot: "sidebar",
            kind: "embedded-module",
            title: "OAuth Plugin",
            entry: "dist/ui.js",
          },
          entryUrl: "file:///oauth-plugin/dist/ui.js",
        },
      ],
    });
    let authed = false;
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "oauth_status" ? { authenticated: authed } : { authenticated: true },
    );

    const user = userEvent.setup();
    await selectPluginView(user, "OAuth Plugin");

    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("oauth_login");
    });
    expect(api.window.openDetached).not.toHaveBeenCalled();

    authed = true;
    emitPluginEvent("oauth-plugin.auth.changed", { authenticated: true });

    await waitFor(() => {
      expect(screen.queryByTestId("slash-group-plugin")).not.toBeInTheDocument();
    });
  });

  it("navigates an unauthenticated plugin view inline in action mode even with no loginTool (no silent abort)", async () => {
    // BUG 3 regression: action mode must render EVERY plugin view inline,
    // including an unauthed plugin whose card has no loginTool (or whose cards
    // have not yet populated). The old code silently `return`ed, stranding the
    // user on their previous view. The fix navigates inline regardless; the
    // plugin surface shows its own auth affordance. No detachment, and the host
    // does not fabricate a loginTool call.
    const user = userEvent.setup();
    const { api } = await renderApp({
      pluginCards: [
        {
          id: "noauthtool-plugin",
          name: "No-LoginTool Plugin",
          description: "Reports unauthed but declares no loginTool",
          sampleTools: [],
          capabilities: [],
          tools: [],
          loadStatus: "loaded",
          auth: {
            statusTool: "nlt_status",
          },
        },
      ],
      pluginUiExtensions: [
        {
          pluginId: "noauthtool-plugin",
          extension: {
            id: "main",
            slot: "sidebar",
            kind: "embedded-module",
            title: "No-LoginTool Plugin",
            entry: "dist/ui.js",
          },
          entryUrl: "file:///noauthtool-plugin/dist/ui.js",
        },
      ],
    });
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "nlt_status" ? { authenticated: false } : { ok: true },
    );

    // Default appMode is action — selection must navigate inline. The picker
    // closing is the observable navigation side-effect (handleViewSelect ran to
    // completion instead of bailing out early).
    await selectPluginView(user, "No-LoginTool Plugin");

    await waitFor(() => {
      expect(screen.queryByTestId("slash-group-plugin")).not.toBeInTheDocument();
    });
    // Inline, not detached; and with no loginTool declared the host must not
    // invoke one (no token_login / fabricated login bypass).
    expect(api.window.openDetached).not.toHaveBeenCalled();
    expect(api.callPluginMethod).not.toHaveBeenCalledWith("nlt_login");
  });
});
