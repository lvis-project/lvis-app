import "../../../../test/renderer/setup.ts";
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../../../test/renderer/render-app.js";

describe("App plugin auth routing", () => {
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
          window: { defaultMode: "detached" as const },
        },
        entryUrl: "file:///token-plugin/dist/ui.js",
      },
    ],
  };

  it("renders a preparing plugin grid cell from plugin-card UI metadata before the view loads", async () => {
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

    fireEvent.click(screen.getByTestId("plugin-grid-button"));

    const cell = await screen.findByTestId("plugin-cell-plugin-local-indexer-local-indexer-control");
    expect(cell).toHaveAttribute("aria-busy", "true");
    expect(cell).toBeDisabled();
    expect(screen.getByTestId("plugin-cell-plugin-local-indexer-local-indexer-control-phase")).toHaveTextContent("준비");
    expect(screen.getByTestId("plugin-cell-plugin-local-indexer-local-indexer-control-preparation")).toHaveTextContent("Python 10%");
    expect(cell).toHaveAttribute("title", expect.stringContaining("Python 10%"));
  });

  it("opens an unauthenticated detached plugin view without invoking loginTool", async () => {
    const { api } = await renderApp(detachedPluginFixture);
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: false } : { ok: true },
    );

    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    const cell = await screen.findByTestId("plugin-cell-plugin-token-plugin-main");
    fireEvent.click(cell);

    await waitFor(() => {
      expect(api.window.openDetached).toHaveBeenCalledWith("plugin:token-plugin:main");
    });
    expect(api.callPluginMethod).not.toHaveBeenCalledWith("token_login");
  });

  it("routes command-palette plugin actions through detached-window handling", async () => {
    const user = userEvent.setup();
    const { api } = await renderApp(detachedPluginFixture);
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: false } : { ok: true },
    );

    await waitFor(() => {
      expect(api.listPluginUiExtensions).toHaveBeenCalled();
    });
    await user.click(screen.getByTestId("command-popover-trigger"));
    await user.click(await screen.findByText("Token Plugin 열기"));

    await waitFor(() => {
      expect(api.window.openDetached).toHaveBeenCalledWith("plugin:token-plugin:main");
    });
    expect(api.callPluginMethod).not.toHaveBeenCalledWith("token_login");
  });

  it("surfaces detached-window open failures instead of dropping them", async () => {
    const { api } = await renderApp(detachedPluginFixture);
    api.window.openDetached.mockResolvedValueOnce({ ok: false, error: "window denied" });
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "token_status" ? { authenticated: false } : { ok: true },
    );

    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    const cell = await screen.findByTestId("plugin-cell-plugin-token-plugin-main");
    fireEvent.click(cell);

    await waitFor(() => {
      expect(screen.getByText(/플러그인 창을 열 수 없습니다/)).toBeInTheDocument();
    });
    expect(screen.getByText(/window denied/)).toBeInTheDocument();
  });

  it("keeps loginTool flow for unauthenticated embedded plugin views", async () => {
    const { api } = await renderApp({
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
    api.callPluginMethod.mockImplementation(async (tool: string) =>
      tool === "oauth_status" ? { authenticated: false } : { authenticated: true },
    );

    fireEvent.click(screen.getByTestId("plugin-grid-button"));
    const cell = await screen.findByTestId("plugin-cell-plugin-oauth-plugin-main");
    fireEvent.click(cell);

    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("oauth_login");
    });
    expect(api.window.openDetached).not.toHaveBeenCalled();
  });
});
