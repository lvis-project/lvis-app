/**
 * Phase 1 renderer split — App smoke tests.
 *
 * These prove the test infrastructure (jsdom + RTL + mock lvisApi) works
 * end-to-end so Phase 2-4 hook extractions have a safety net.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ActionPanel } from "../../src/ui/renderer/components/ActionPanel.js";
import { renderApp } from "./render-app.js";

describe("App smoke (Phase 1 infra)", () => {
  it("renders App without crash", async () => {
    const { container, api } = await renderApp();
    expect(container).toBeTruthy();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
  });

  it("subscribes to onChatStream on mount", async () => {
    const { api } = await renderApp();
    await waitFor(() => expect(api.onChatStream).toHaveBeenCalled());
  });

  it("receives stream events via emitChatStream without throwing", async () => {
    const { emitChatStream } = await renderApp();
    await act(async () => {
      emitChatStream({ type: "text", text: "hello" });
    });
    expect(true).toBe(true);
  });

  it("OverlayCard appears when onRoutineFiredV2 fires", async () => {
    const { container, emitRoutineFiredV2 } = await renderApp();
    await act(async () => {
      emitRoutineFiredV2({
        id: "schedule-daily",
        trigger: "schedule",
        firedAt: new Date().toISOString(),
        title: "Daily schedule",
        summary: "smoke summary",
      });
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeTruthy();
    });
  });

  it("Ctrl+F keydown opens unified search with fresh sessions and starred data", async () => {
    const { api } = await renderApp();
    await waitFor(() => expect(api.chatSessions).toHaveBeenCalled());
    api.chatSessions.mockClear();
    api.starredList.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    });
    await waitFor(() => expect(api.chatSessions).toHaveBeenCalledTimes(1));
    expect(api.starredList).toHaveBeenCalledTimes(1);
  });

  it("opens settings inline (work mode) from the API key prompt", async () => {
    const { container, api } = await renderApp({ hasApiKey: false });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toContain("API 키 설정 필요"));
    const settingsButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("설정 열기"),
    );
    expect(settingsButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(settingsButton!);
    });

    // Default appMode is "work" — Settings renders INLINE in the main area
    // (same setActiveView + MainContent path as 업무보드/루틴/메모리/별표), so
    // the detached BrowserWindow IPC must NOT fire and chat must not send.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
    );
    expect(container.querySelector('[data-testid="settings-inline-back"]')).toBeTruthy();
    expect(api.openSettingsWindow).not.toHaveBeenCalled();
    expect(api.chatSend).not.toHaveBeenCalled();
  });

  it("addStarred / listStarred mock surface is spy-able", async () => {
    const { api } = await renderApp();
    const entry = { messageIndex: 3, role: "assistant", text: "hi", sessionId: "s1" };
    await api.addStarred(entry);
    expect(api.addStarred).toHaveBeenCalledWith(entry);
    const list = await api.listStarred();
    expect(Array.isArray(list)).toBe(true);
  });

  it("renders a collapsible right action panel that defaults to the rail", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    // The 도구 활동 panel defaults to its collapsed rail on a fresh launch — the
    // full expanded card is NOT auto-shown.
    expect(container.querySelector('[data-testid="action-panel"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="action-panel-rail"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="action-panel-summary"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="action-panel-summary-list"]')?.className).toContain("flex-col");
    expect(container.querySelector('[data-testid="action-panel-summary"]')?.textContent?.trim()).toBe("");
    expect(container.textContent).not.toContain("아직 읽은 파일이 없습니다.");

    // Open it from the rail → full card appears.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="action-panel-open"]')!);
    });

    const actionPanel = container.querySelector('[data-testid="action-panel"]');
    expect(actionPanel).toBeTruthy();
    expect(container.textContent).toContain("도구 활동");
    expect(container.textContent).toContain("카테고리별 최신 5개");
    // Scoped to the action panel itself — the sidebar's own Chats/Projects
    // tablist is unrelated and (correctly) present elsewhere on the page.
    expect(actionPanel?.querySelector('[role="tablist"]')).toBeFalsy();

    // Close it again → back to the collapsed rail.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="action-panel-close"]')!);
    });

    expect(container.querySelector('[data-testid="action-panel"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="action-panel-rail"]')).toBeTruthy();
  });

  it("hides tool activity in chat mode and opens the side panel from the title bar", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    const windowApi = api.window as unknown as {
      resizeForSidePanel: ReturnType<typeof vi.fn>;
    };

    await act(async () => {
      emitChatStream({
        type: "tool_start",
        name: "read_file",
        groupId: "g1",
        toolUseId: "t1",
        toolCategory: "read",
        input: { path: "C:\\tmp\\readme.md" },
      });
      emitChatStream({
        type: "tool_end",
        name: "read_file",
        groupId: "g1",
        toolUseId: "t1",
        toolCategory: "read",
        result: "ok",
      });
    });
    expect(container.querySelector('[data-testid="action-panel-rail"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="app-mode-chat"]')!);
    });
    await waitFor(() => expect(windowApi.resizeForSidePanel).toHaveBeenCalledWith(false));
    expect(container.querySelector('[data-testid="action-panel-rail"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="action-panel"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="chat-preview-open"]')).toBeFalsy();

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="chat-side-panel-toggle"]')!);
    });
    await waitFor(() => expect(windowApi.resizeForSidePanel).toHaveBeenLastCalledWith(true));
    expect(container.querySelector('[data-testid="chat-side-panel"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="chat-side-panel-toggle"]')!);
    });
    await waitFor(() => expect(windowApi.resizeForSidePanel).toHaveBeenLastCalledWith(false));
    expect(container.querySelector('[data-testid="chat-side-panel"]')).toBeFalsy();
  });

  it("opens the chat side panel from non-home inline views instead of latching invisible state", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="sidebar-settings"]')!);
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
    );
    expect(container.querySelector('[data-testid="chat-side-panel"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="chat-side-panel-toggle"]')?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="chat-side-panel-toggle"]')!);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="chat-side-panel"]')).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="chat-side-panel-toggle"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not duplicate primary sidebar navigation in the right action panel", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    expect(container.textContent).not.toContain("최근 세션");
    expect(container.textContent).not.toContain("연결된 액션");
    expect(container.textContent).not.toContain("플러그인 뷰");
    expect(container.textContent).not.toContain("워크 보드");
  });

  it("keeps expanded action panel counters visible while hiding empty detail rows", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    // The panel defaults to the collapsed rail; open it to inspect the expanded
    // card's counters.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="action-panel-open"]')!);
    });

    expect(container.textContent).toContain("읽은 파일");
    expect(container.textContent).toContain("쓴 파일");
    expect(container.textContent).toContain("MCP 호출");
    expect(container.textContent).toContain("플러그인 호출");
    expect(container.textContent).toContain("도구 호출");
    expect(container.textContent).toContain("웹 출처");
    expect(container.textContent).not.toContain("아직 읽은 파일이 없습니다.");
    expect(container.querySelector('[data-testid^="action-panel-activity-"]')).toBeFalsy();
  });

  it("surfaces populated action panel activity and routes rows in-app", () => {
    const readFiles = Array.from({ length: 6 }, (_, index) => ({
      id: `read-${index}`,
      label: `latest-read-${index}`,
      target: `C:\\tmp\\latest-read-${index}.md`,
    }));
    const openItem = vi.fn();
    const openInSystemApp = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <ActionPanel
          open
          onOpenChange={vi.fn()}
          onOpenItem={openItem}
          onOpenItemInSystemApp={openInSystemApp}
          activity={{
            readFileCount: readFiles.length,
            writtenFileCount: 1,
            mcpCallCount: 1,
            pluginCallCount: 1,
            toolCallCount: 4,
            fetchedPageCount: 1,
            readFiles,
            writtenFiles: [{
              id: "write-1",
              label: "C:\\tmp\\written.md",
              target: "C:\\tmp\\written.md",
            }],
            pluginCalls: [{ id: "plugin-1", label: "plugin_tool", detail: "plugin-a" }],
            mcpCalls: [{ id: "mcp-1", label: "mcp_tool", detail: "server-a" }],
            fetchedPages: [{
              id: "web-1",
              label: "https://example.com",
              detail: "https://example.com/full/path?q=1",
              target: "https://example.com/full/path?q=1",
            }],
          }}
        />
      </TooltipProvider>,
    );

    expect(container.textContent).toContain("읽은 파일");
    expect(container.textContent).toContain("쓴 파일");
    expect(container.textContent).toContain("MCP 호출");
    expect(container.textContent).toContain("플러그인 호출");
    expect(container.textContent).toContain("도구 호출");
    expect(container.textContent).toContain("웹 출처");
    expect(container.textContent).toContain("latest-read-0");
    expect(container.textContent).toContain("latest-read-4");
    expect(container.textContent).not.toContain("latest-read-5");
    expect(container.textContent).toContain("https://example.com");
    expect(container.textContent).not.toContain("/full/path");

    // Read-file rows now carry a target → they are clickable buttons that route
    // the file in-app (web=false); no local path ever reaches a system opener.
    const readRow = container.querySelector('[data-testid="action-panel-activity-read-0"]')!;
    expect(readRow.tagName).toBe("BUTTON");
    fireEvent.click(readRow);
    expect(openItem).toHaveBeenLastCalledWith("C:\\tmp\\latest-read-0.md", false);
    expect(openInSystemApp).not.toHaveBeenCalled();
    // Web rows route in-app with web=true.
    fireEvent.click(container.querySelector('[data-testid="action-panel-activity-web-1"]')!);
    expect(openItem).toHaveBeenLastCalledWith("https://example.com/full/path?q=1", true);
  });
});

describe("Settings inline (work mode) vs detached (chat mode)", () => {
  it("renders Settings inline, marks the sidebar item active, and returns home", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const sidebarSettings = container.querySelector(
      '[data-testid="sidebar-settings"]',
    ) as HTMLElement | null;
    expect(sidebarSettings).toBeTruthy();

    await act(async () => {
      fireEvent.click(sidebarSettings!);
    });

    // Inline render via setActiveView + MainContent — never the detached window.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
    );
    expect(api.openSettingsWindow).not.toHaveBeenCalled();
    // Sidebar item shows ACTIVE state (aria-current=page) while inline.
    expect(
      container
        .querySelector('[data-testid="sidebar-settings"]')
        ?.getAttribute("aria-current"),
    ).toBe("page");

    // Re-clicking while already on settings is a no-op (view stays mounted).
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="sidebar-settings"]')!);
    });
    expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy();

    // Back-to-home affordance returns to the prior/home view.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="settings-inline-back"]')!);
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeFalsy(),
    );
  });

  it("detaches Settings to its own window in chat mode (unchanged path)", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="app-mode-chat"]')!);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="sidebar-settings"]')!);
    });

    // Chat mode keeps the existing detached BrowserWindow path; nothing renders
    // inline.
    await waitFor(() => expect(api.openSettingsWindow).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeFalsy();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
