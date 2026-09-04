import "../../../../test/renderer/setup.ts";
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { TEST_IDS } from "../../../shared/test-ids.js";

describe("App plugin auth routing", () => {
  // The composer's command button now opens a NATIVE menu, which lives outside
  // the page and jsdom cannot render. The inline "/" menu is the surviving DOM
  // affordance over the same data — it lists the same plugin rows and the same
  // shortcut actions — so these helpers type a query and click the row. The
  // auth/detach SECURITY behavior under test is unchanged: selection still
  // routes through the same App handleViewSelect path, only the affordance did.
  // One call site for the harness. `userEvent`'s default export does not
  // typecheck under this repo's NodeNext resolution (`tsconfig.tests.json`
  // covers tests; the root config does not), and the diagnostic used to be
  // repeated once per test — nine copies of one known gap. Naming the helper
  // keeps it to one, and gives the two picker helpers a type to take.
  const makeUser = () => userEvent.setup();
  type PickerUser = ReturnType<typeof makeUser>;

  /**
   * Type "/<query>" in the composer so the inline menu opens, filtered. The
   * query is one token — a space ends the trigger — so pass a single word.
   */
  const openInlineMenu = async (query: string) => {
    const composer = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    const value = `/${query}`;
    fireEvent.change(composer, { target: { value } });
    composer.setSelectionRange(value.length, value.length);
    fireEvent.keyUp(composer, { key: value.slice(-1) });
    return screen.findByTestId("inline-slash-menu");
  };
  const selectPluginView = async (user: PickerUser, label: string) => {
    // Scope the row lookup to the menu — the plugin's own title can also appear
    // elsewhere in the tree (e.g. a loaded inline view).
    const menu = await openInlineMenu(label.split(" ")[0]!);
    await user.click(await within(menu).findByText(label));
  };
  const authPluginFixture = {
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
    // registered plugin cells"). At the App level the contract is: a preparing
    // plugin card that declares a UI extension still appears as a reachable
    // entry in the composer's command surface.
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

    const menu = await openInlineMenu("로컬");
    expect(await within(menu).findByText("로컬 인덱서")).toBeInTheDocument();
  });

  it("opens a preparing plugin's panel on selection instead of dropping the click", async () => {
    // The row above is reachable, and selecting it used to do nothing at all:
    // `handleViewSelect` refused any key with no entry in `pluginViews`, and a
    // preparing plugin has not registered its view yet. The picker closed, the
    // app stayed where it was, and nothing opened the panel when the view
    // landed seconds later — the first-run symptom was "clicking the plugin
    // does nothing". The destination opens now and waits.
    const user = makeUser();
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

    await selectPluginView(user, "로컬 인덱서");

    // The panel surface is on screen, showing the host's loading state rather
    // than "플러그인 뷰를 찾을 수 없습니다." — which is what a missing view means.
    expect(await screen.findByText("로딩 중...")).toBeInTheDocument();
    expect(screen.queryByText("플러그인 뷰를 찾을 수 없습니다.")).toBeNull();
  });

  // Plugin views ALWAYS render inline. The shared top toolbar owns navigation;
  // the plugin page heading proves the inline host rendered.
  it("unauthenticated auth plugin → host fires loginTool and does NOT navigate the panel (login-first)", async () => {
    const user = makeUser();
    const { api } = await renderApp(authPluginFixture);
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: false } : { ok: true },
    );

    await selectPluginView(user, "Token Plugin");

    // Auth is a host-managed lifecycle (architecture.md §9.4a): for an unauthed
    // auth plugin the host fires the loginTool (opens the SSO window ONLY)...
    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("token_login", undefined, {
        userAction: true,
      });
    });
    // ...and does not navigate the inline view until the plugin reports authed
    // (login-first).
    expect(screen.queryByRole("heading", { name: "Token Plugin" })).not.toBeInTheDocument();
  });

  it("authenticated auth plugin → navigates the panel inline without firing loginTool", async () => {
    const user = makeUser();
    const { api } = await renderApp(authPluginFixture);
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: true } : { ok: true },
    );

    await selectPluginView(user, "Token Plugin");

    // Already authed → navigate inline directly, no login round-trip. Assert the
    // plugin view host actually rendered — not merely that the picker closed
    // (it closes on every selection regardless of navigation).
    expect(await screen.findByRole("heading", { name: "Token Plugin" })).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-page-back")).not.toBeInTheDocument();
    expect(api.callPluginMethod.mock.calls.some(([tool]) => tool === "token_login")).toBe(false);
  });

  it("login completes → navigates the deferred inline panel on the unauthed→authed transition", async () => {
    const user = makeUser();
    const { api, emitPluginEvent } = await renderApp(authPluginFixture);
    // Start unauthenticated.
    let authed = false;
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: authed } : { ok: true },
    );

    await selectPluginView(user, "Token Plugin");

    // Unauthed: host fires loginTool (opens SSO window) and DEFERS the view.
    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("token_login", undefined, {
        userAction: true,
      });
    });
    // Deferred: the inline view is NOT navigated yet (still unauthed).
    expect(screen.queryByRole("heading", { name: "Token Plugin" })).not.toBeInTheDocument();

    // Login completes: status flips to authed and the plugin emits
    // `<pluginId>.auth.changed`, which re-fetches status. The host's one-shot
    // drain effect then navigates the DEFERRED inline view (login-window-closes →
    // panel-opens).
    authed = true;
    emitPluginEvent("token-plugin.auth.changed", { authenticated: true });

    // The plugin view host now renders inline — proving the drain effect, not
    // the initial click, performed the navigation.
    expect(await screen.findByRole("heading", { name: "Token Plugin" })).toBeInTheDocument();
  });

  it("login failure keeps the plugin panel closed and surfaces a safe auth error code as a toast", async () => {
    const user = makeUser();
    const { api, emitPluginEvent } = await renderApp(authPluginFixture);
    const nonCorpError = Object.assign(new Error("[non-corp-network] outside corporate network"), {
      code: "non-corp-network",
    });
    api.callPluginMethod.mockImplementation(async (tool: string) => {
      if (tool === "token_status") return { authenticated: false };
      if (tool === "token_login") throw nonCorpError;
      return { ok: true };
    });

    await selectPluginView(user, "Token Plugin");

    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("token_login", undefined, {
        userAction: true,
      });
    });
    await waitFor(() => {
      const statusBar = within(screen.getByTestId("window-notice-strip")).getByTestId("status-bar");
      expect(statusBar).toHaveTextContent(/code: non-corp-network/);
      expect(statusBar).toHaveTextContent(/사내망 또는 VPN 연결이 필요합니다/);
    });
    const statusCallCountBeforeAuthChanged = api.callPluginMethod.mock.calls.filter(
      ([tool]) => tool === "token_status",
    ).length;
    emitPluginEvent("token-plugin.auth.changed", { authenticated: true });
    await waitFor(() => {
      expect(
        api.callPluginMethod.mock.calls.filter(([tool]) => tool === "token_status").length,
      ).toBeGreaterThan(statusCallCountBeforeAuthChanged);
    });
    const assistantBodies = screen.queryAllByTestId("assistant-message-body");
    expect(
      assistantBodies.some((body) => body.textContent?.includes("non-corp-network")),
    ).toBe(false);
  });

  it("command-palette plugin actions navigate inline (authed), never detaching", async () => {
    const user = makeUser();
    const { api } = await renderApp(authPluginFixture);
    // Authed so the command-palette selection navigates the view (an unauthed
    // auth plugin would route to loginTool instead).
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: true } : { ok: true },
    );

    await waitFor(() => {
      expect(api.listPluginUiExtensions).toHaveBeenCalled();
    });
    // The plugin-view QuickAction ("…열기") is a shortcut, not a plugin row —
    // the inline menu lists both, so the same query reaches it.
    const menu = await openInlineMenu("Token");
    await user.click(await within(menu).findByText("Token Plugin 열기"));

    // Navigates the plugin view inline (its host renders); never opens a window.
    expect(await screen.findByRole("heading", { name: "Token Plugin" })).toBeInTheDocument();
    expect(api.callPluginMethod.mock.calls.some(([tool]) => tool === "token_login")).toBe(false);
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

    const user = makeUser();
    await selectPluginView(user, "OAuth Plugin");

    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("oauth_login", undefined, {
        userAction: true,
      });
    });

    authed = true;
    emitPluginEvent("oauth-plugin.auth.changed", { authenticated: true });

    // The deferred inline view is navigated once authed (its host renders).
    expect(await screen.findByRole("heading", { name: "OAuth Plugin" })).toBeInTheDocument();
  });

  it("navigates an unauthenticated plugin view inline in work mode even with no loginTool (no silent abort)", async () => {
    // BUG 3 regression: work mode must render EVERY plugin view inline,
    // including an unauthed plugin whose card has no loginTool (or whose cards
    // have not yet populated). The old code silently `return`ed, stranding the
    // user on their previous view. The fix navigates inline regardless; the
    // plugin surface shows its own auth affordance. No detachment, and the host
    // does not fabricate a loginTool call.
    const user = makeUser();
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

    // Default appMode is work — selection must navigate inline. The picker
    // closing is the observable navigation side-effect (handleViewSelect ran to
    // completion instead of bailing out early).
    await selectPluginView(user, "No-LoginTool Plugin");

    // Navigated inline directly (no loginTool): the plugin view host renders.
    expect(await screen.findByRole("heading", { name: "No-LoginTool Plugin" })).toBeInTheDocument();
    // Inline, not detached; and with no loginTool declared the host must not
    // invoke one (no token_login / fabricated login bypass).
    expect(api.callPluginMethod.mock.calls.some(([tool]) => tool === "nlt_login")).toBe(false);
  });
});
