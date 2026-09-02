/**
 * Phase 1 renderer split — App smoke tests.
 *
 * These prove the test infrastructure (jsdom + RTL + mock lvisApi) works
 * end-to-end so Phase 2-4 hook extractions have a safety net.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
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
      expect(container.querySelector("[data-settings-layout]")).toBeTruthy(),
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

  it("reports tool activity in the work panel — compact on the launcher, in full on the activity tab — and never in the header", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

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

    // The header carries the conversation's line and the tile controls only —
    // no activity control hangs off it.
    const header = container.querySelector('[data-testid="pane-header"]');
    expect(header).toBeTruthy();
    expect(header?.textContent).not.toContain("도구 활동");
    expect(container.querySelector('[data-testid="tool-activity-open-tab"]')).toBeFalsy();

    // Open the work panel: its empty launcher carries the compact report.
    await act(async () => {
      fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.panePanelToggle))!);
    });
    const launcherActivity = await waitFor(() => {
      const found = container.querySelector('[data-testid="chat-side-panel-launcher-tool-activity"]');
      expect(found).toBeTruthy();
      return found!;
    });
    expect(launcherActivity.textContent).toContain("읽은 파일");
    expect(launcherActivity.textContent).toContain("변경된 파일");
    expect(launcherActivity.textContent).toContain("호출한 도구");
    expect(launcherActivity.querySelector('[data-testid^="tool-activity-item-read:t1:"]')?.textContent).toContain("readme.md");

    // Its way to the full lists is the activity tab.
    await act(async () => {
      fireEvent.click(launcherActivity.querySelector('[data-testid="tool-activity-open-tab"]')!);
    });
    expect(container.querySelector('[data-testid="chat-side-panel-tab-activity"]')).toBeTruthy();
    const workspace = container.querySelector('[data-testid="chat-side-panel-activity-workspace"]');
    expect(workspace?.textContent).toContain("read_file");
    expect(workspace?.querySelectorAll('[data-testid="chat-side-panel-activity-tool-row"]')).toHaveLength(1);
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
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="app-mode-chat"]')!);
    });
    await waitFor(() => expect(windowApi.resizeForSidePanel).toHaveBeenCalledWith(false));
    expect(container.querySelector('[data-testid="chat-preview-open"]')).toBeFalsy();

    // The toggle points along the panel's axis: the panel opens BESIDE the
    // transcript, so the icon is the right-panel pair, not the bottom one.
    const panelToggle = () => container.querySelector(testIdSelector(TEST_IDS.panePanelToggle))!;
    expect(panelToggle().querySelector("svg.lucide-panel-right-open")).toBeTruthy();

    await act(async () => {
      fireEvent.click(panelToggle());
    });
    expect(panelToggle().querySelector("svg.lucide-panel-right-close")).toBeTruthy();
    await waitFor(() => expect(windowApi.resizeForSidePanel).toHaveBeenLastCalledWith(true));
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="chat-side-panel-motion"]')?.getAttribute("aria-hidden"),
      ).toBe("false"),
    );
    expect(container.querySelector(testIdSelector(TEST_IDS.chatSidePanel))).toBeTruthy();

    await act(async () => {
      fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.panePanelToggle))!);
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
      fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.panePanelToggle))!);
    });
    await waitFor(() => expect(container.querySelector(testIdSelector(TEST_IDS.chatSidePanel))).toBeTruthy());

    // Leaving for a view with no conversation takes the panel AND its toggle
    // with it — the panel reports on a conversation, and Settings is not one.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="sidebar-settings"]')!);
    });
    await waitFor(() =>
      expect(container.querySelector("[data-settings-layout]")).toBeTruthy(),
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
      expect(container.querySelector("[data-settings-layout]")).toBeFalsy();
      expect(
        container.querySelector('[data-testid="chat-surface"]')?.getAttribute("data-visible"),
      ).toBe("true");
      expect(container.querySelector(testIdSelector(TEST_IDS.chatSidePanel))).toBeTruthy();
    });
    expect(container.querySelector(testIdSelector(TEST_IDS.panePanelToggle))?.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not duplicate primary sidebar navigation in the right action panel", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    expect(container.textContent).not.toContain("최근 세션");
    expect(container.textContent).not.toContain("연결된 액션");
    expect(container.textContent).not.toContain("플러그인 뷰");
    expect(container.textContent).not.toContain("워크 보드");
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
      expect(container.querySelector("[data-settings-layout]")).toBeTruthy(),
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
    expect(container.querySelector("[data-settings-layout]")).toBeTruthy();

    // The app-level navbar returns to the prior/home view.
    await act(async () => {
      fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.viewPathBack))!);
    });
    await waitFor(() =>
      expect(container.querySelector("[data-settings-layout]")).toBeFalsy(),
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
      expect(container.querySelector("[data-settings-layout]")).toBeTruthy(),
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
