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
import { MOCK_DEFAULT_SESSION_ID } from "./mock-lvis-api.js";
import { TEST_IDS, testIdSelector } from "../../src/shared/test-ids.js";

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

  it("OverlayCard appears when onRoutineFired fires", async () => {
    const { container, emitRoutineFired } = await renderApp();
    await act(async () => {
      emitRoutineFired({
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

    // The prompt is a chip in the composer strip now, not a transcript card, so
    // "설정 열기" lives one click deep inside its popover (rendered in a portal).
    const chip = container.querySelector<HTMLElement>('[data-testid="composer-api-key-chip"]');
    expect(chip).toBeTruthy();
    await act(async () => {
      fireEvent.click(chip!);
    });

    const settingsButton = await waitFor(() => {
      const button = document.querySelector<HTMLElement>('[data-testid="composer-api-key-chip:settings"]');
      expect(button).toBeTruthy();
      return button!;
    });
    expect(settingsButton.textContent).toContain("설정 열기");

    await act(async () => {
      fireEvent.click(settingsButton);
    });

    // Default appMode is "work" — Settings renders inline in the main area
    // through the same setActiveView + main-content-region path as the other views.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
    );
    expect(container.querySelector('[data-testid="settings-close"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-mobile-close"]')).toBeNull();
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

  it("hangs tool activity off the chat group's header, closed until asked for", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    // The control is IN the group header (not floating over the transcript, and
    // not in the window band), and the panel itself is closed on a fresh launch.
    const trigger = container.querySelector('[data-testid="action-panel-open"]');
    expect(trigger).toBeTruthy();
    expect(container.querySelector('[data-testid="chat-group-header-slot"]')?.contains(trigger!)).toBe(true);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    // It opens DOWNWARD as a popover, so its content is portaled — absent from
    // the page entirely while closed.
    expect(document.querySelector('[data-testid="action-panel"]')).toBeFalsy();
    expect(document.body.textContent).not.toContain("아직 읽은 파일이 없습니다.");

    await act(async () => {
      fireEvent.click(trigger!);
    });

    const actionPanel = await waitFor(() => {
      const panel = document.querySelector('[data-testid="action-panel"]');
      expect(panel).toBeTruthy();
      return panel!;
    });
    expect(actionPanel.textContent).toContain("도구 활동");
    expect(actionPanel.textContent).toContain("카테고리별 최신 5개");
    // Scoped to the action panel itself — the sidebar's own Chats/Projects
    // tablist is unrelated and (correctly) present elsewhere on the page.
    expect(actionPanel.querySelector('[role="tablist"]')).toBeFalsy();

    // Escape dismisses it, the way every other popover on this surface does.
    await act(async () => {
      fireEvent.keyDown(actionPanel, { key: "Escape", code: "Escape" });
    });
    await waitFor(() => expect(document.querySelector('[data-testid="action-panel"]')).toBeFalsy());
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
    expect(container.querySelector('[data-testid="action-panel-open"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="app-mode-chat"]')!);
    });
    await waitFor(() => expect(windowApi.resizeForSidePanel).toHaveBeenCalledWith(false));
    expect(container.querySelector('[data-testid="action-panel-open"]')).toBeFalsy();
    expect(document.querySelector('[data-testid="action-panel"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="chat-preview-open"]')).toBeFalsy();

    await act(async () => {
      fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.chatGroupPanelToggle))!);
    });
    await waitFor(() => expect(windowApi.resizeForSidePanel).toHaveBeenLastCalledWith(true));
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="chat-side-panel-motion"]')?.getAttribute("aria-hidden"),
      ).toBe("false"),
    );
    expect(container.querySelector(testIdSelector(TEST_IDS.chatSidePanel))).toBeTruthy();

    await act(async () => {
      fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.chatGroupPanelToggle))!);
    });
    const closingMotion = container.querySelector('[data-testid="chat-side-panel-motion"]');
    expect(closingMotion).toBeTruthy();
    expect(closingMotion?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(testIdSelector(TEST_IDS.chatSidePanel))).toBeTruthy();
    await waitFor(() => expect(windowApi.resizeForSidePanel).toHaveBeenLastCalledWith(false));
    await waitFor(
      () => expect(container.querySelector('[data-testid="chat-side-panel-motion"]')).toBeFalsy(),
      { timeout: 1_000 },
    );
  });

  it("takes the work panel away with its conversation, rather than latching invisible state", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    // Open it on the chat surface, where the conversation that owns it is.
    await act(async () => {
      fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.chatGroupPanelToggle))!);
    });
    await waitFor(() => expect(container.querySelector(testIdSelector(TEST_IDS.chatSidePanel))).toBeTruthy());

    // Leaving for a view with no conversation takes the panel AND its toggle
    // with it — the panel reports on a conversation, and Settings is not one.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="sidebar-settings"]')!);
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
    );
    // Hidden with its conversation, not unmounted: a tile subscribes to its
    // group's stream when it mounts, so tearing the surface down for Settings
    // would drop the frames of a turn still running. The panel and its toggle
    // go away with the surface that owns them.
    expect(
      container.querySelector('[data-testid="chat-surface"]')?.getAttribute("data-visible"),
    ).toBe("false");
    expect(
      container.querySelector(testIdSelector(TEST_IDS.chatSidePanel))?.closest('[data-testid="chat-surface"]'),
    ).toBeTruthy();

    // Coming back restores it — the state rode with the group, not with the
    // window, so it did not have to be re-opened.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="sidebar-new-chat"]')!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeFalsy();
      expect(
        container.querySelector('[data-testid="chat-surface"]')?.getAttribute("data-visible"),
      ).toBe("true");
      expect(container.querySelector(testIdSelector(TEST_IDS.chatSidePanel))).toBeTruthy();
    });
    expect(container.querySelector(testIdSelector(TEST_IDS.chatGroupPanelToggle))?.getAttribute("aria-pressed")).toBe("true");
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

    // Closed until asked for; open it to inspect the counters.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="action-panel-open"]')!);
    });

    const panel = await waitFor(() => {
      const found = document.querySelector('[data-testid="action-panel"]');
      expect(found).toBeTruthy();
      return found!;
    });
    expect(panel.textContent).toContain("읽은 파일");
    expect(panel.textContent).toContain("쓴 파일");
    expect(panel.textContent).toContain("MCP 호출");
    expect(panel.textContent).toContain("플러그인 호출");
    expect(panel.textContent).toContain("도구 호출");
    expect(panel.textContent).toContain("웹 출처");
    expect(panel.textContent).not.toContain("아직 읽은 파일이 없습니다.");
    expect(panel.querySelector('[data-testid^="action-panel-activity-"]')).toBeFalsy();
  });

  it("surfaces populated action panel activity and routes rows in-app", () => {
    const readFiles = Array.from({ length: 6 }, (_, index) => ({
      id: `read-${index}`,
      label: `latest-read-${index}`,
      target: `C:\\tmp\\latest-read-${index}.md`,
    }));
    const openItem = vi.fn();
    const openInSystemApp = vi.fn();
    // Rendered open. The content is a popover, so it lands in a portal on the
    // document rather than inside the render container.
    render(
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

    expect(document.body.textContent).toContain("읽은 파일");
    expect(document.body.textContent).toContain("쓴 파일");
    expect(document.body.textContent).toContain("MCP 호출");
    expect(document.body.textContent).toContain("플러그인 호출");
    expect(document.body.textContent).toContain("도구 호출");
    expect(document.body.textContent).toContain("웹 출처");
    expect(document.body.textContent).toContain("latest-read-0");
    expect(document.body.textContent).toContain("latest-read-4");
    expect(document.body.textContent).not.toContain("latest-read-5");
    expect(document.body.textContent).toContain("https://example.com");
    expect(document.body.textContent).not.toContain("/full/path");

    // Read-file rows now carry a target → they are clickable buttons that route
    // the file in-app (web=false); no local path ever reaches a system opener.
    const readRow = document.querySelector('[data-testid="action-panel-activity-read-0"]')!;
    expect(readRow.tagName).toBe("BUTTON");
    fireEvent.click(readRow);
    expect(openItem).toHaveBeenLastCalledWith("C:\\tmp\\latest-read-0.md", false);
    expect(openInSystemApp).not.toHaveBeenCalled();
    // Web rows route in-app with web=true.
    fireEvent.click(document.querySelector('[data-testid="action-panel-activity-web-1"]')!);
    expect(openItem).toHaveBeenLastCalledWith("https://example.com/full/path?q=1", true);
  });
});

describe("Settings inline (all modes)", () => {
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

    // Inline render via setActiveView + the main content region.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
    );
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

    // The app-level navbar returns to the prior/home view.
    await act(async () => {
      fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.viewPathBack))!);
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeFalsy(),
    );
  });

  it("renders Settings inline in chat mode too", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="app-mode-chat"]')!);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="sidebar-settings"]')!);
    });

    // Settings is an always-inline panel in every app mode.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sub-agent frames per tile", () => {
  it("a tile keeps the frames of the conversation it shows and drops the others", async () => {
    const { container, emitAgentSpawnEvent } = await renderApp({
      history: { sessionId: MOCK_DEFAULT_SESSION_ID, messages: [{ role: "user", content: "kept" }] },
    });
    await waitFor(() => expect(container.querySelector(testIdSelector(TEST_IDS.composerTextarea))).toBeTruthy());

    await act(async () => {
      emitAgentSpawnEvent({ spawnId: "theirs", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Theirs", parentSessionId: "another-tile" });
    });
    expect(container.querySelector('[data-testid="chat-side-panel-subagent-row"]')).toBeNull();

    await act(async () => {
      emitAgentSpawnEvent({ spawnId: "mine", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Mine", parentSessionId: MOCK_DEFAULT_SESSION_ID });
    });
    await waitFor(() =>
      expect(container.querySelectorAll('[data-testid="chat-side-panel-subagent-row"]')).toHaveLength(1),
    );
    expect(container.querySelector('[data-testid="chat-side-panel-subagent-row"]')?.textContent).toContain("Mine");
  });
});
