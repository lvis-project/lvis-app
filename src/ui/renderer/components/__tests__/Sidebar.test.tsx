// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { Sidebar } from "../Sidebar.js";
import type { SessionSummary } from "../../hooks/use-sessions.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import type { SidebarTab } from "../../hooks/use-sidebar-tab.js";
import type {
  NativeContextMenuAction,
  NativeContextMenuPayload,
} from "../../../../shared/native-context-menu.js";

/**
 * Wraps <Sidebar> with local tab state so a click on a TabsTrigger actually
 * flips the (controlled) active tab, mirroring how App.tsx wires
 * activeSidebarTab/onActiveSidebarTabChange through useSidebarTab. Tests that
 * only care about the initial tab can pass `activeSidebarTab` in overrides;
 * tests that click a tab trigger get real switching without needing App.tsx.
 */
/**
 * Radix's TabsTrigger switches the active tab on `mousedown` (not `click` —
 * see @radix-ui/react-tabs's TabsTrigger, which calls `onValueChange` from
 * its onMouseDown handler so keyboard/roving-focus activation and pointer
 * activation share one code path). `fireEvent.click` alone never fires a
 * mousedown in jsdom, so tab-switch tests must dispatch mousedown instead.
 */
function activateTab(trigger: HTMLElement) {
  fireEvent.mouseDown(trigger, { button: 0 });
}

function Harness(props: Parameters<typeof Sidebar>[0]) {
  const [tab, setTab] = useState<SidebarTab>(props.activeSidebarTab ?? "chats");
  return (
    <Sidebar
      {...props}
      activeSidebarTab={tab}
      onActiveSidebarTabChange={(next) => {
        setTab(next);
        props.onActiveSidebarTabChange?.(next);
      }}
    />
  );
}

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const onLoadSession = vi.fn();
  const onNewChatForProject = vi.fn();
  let nativeContextActionHandler: ((action: NativeContextMenuAction) => void) | null = null;
  const showNativeContextMenu = vi.fn(async (_payload: NativeContextMenuPayload) => ({
    ok: true as const,
  }));
  const removeRoot = vi.fn(async (root: string) => ({
    ok: true as const, removed: root, roots: [],
  }));
  const ADDED_ROOT = "C:\\Users\\example\\workspace\\lvis-project\\gamma";
  const pickRoot = vi.fn(async (_options?: { ackToken?: string }) => ({
    ok: true as const,
    roots: [{ path: ADDED_ROOT, isDefault: false }],
    added: ADDED_ROOT,
  } as {
    ok: true;
    roots?: { path: string; isDefault: boolean }[];
    added?: string;
    requiresAcknowledgement?: boolean;
    pendingPath?: string;
    ackToken?: string;
    warnings?: string[];
  }));
  const listRoots = vi.fn(async () => ({
    ok: true as const,
    defaultRoot: "C:\\Users\\example\\workspace\\lvis-project\\lvis-app",
    roots: [
      { path: "C:\\Users\\example\\workspace\\lvis-project\\lvis-app", isDefault: true },
      { path: "C:\\Users\\example\\workspace\\lvis-project\\other-app", isDefault: false },
    ],
  }));
  const sessions: SessionSummary[] = overrides.sessions ?? [
    {
      id: "sess-1",
      title: "전체 동기화로 상태 파악",
      modifiedAt: new Date().toISOString(),
      sessionKind: "main",
    },
    {
      id: "sess-2",
      title: "사이드 패널 개선",
      modifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      sessionKind: "main",
    },
    {
      id: "sess-other",
      title: "다른 프로젝트 대화",
      modifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      sessionKind: "main",
      projectRoot: "C:\\Users\\example\\workspace\\lvis-project\\other-app",
      projectName: "other-app",
    },
  ];

  const props: Parameters<typeof Sidebar>[0] = {
    activeView: "home",
    onSelect: vi.fn(),
    pluginViews: [],
    hasApiKey: true,
    onOpenSettings: vi.fn(),
    onNewChat: vi.fn(),
    streaming: false,
    onOpenMarketplace: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    onOpenUnifiedSearch: vi.fn(),
    viewNav: {
      segments: [],
      canGoBack: false,
      canGoForward: false,
      onBack: vi.fn(),
      onForward: vi.fn(),
      onSelectSegment: vi.fn(),
    },
    sessions,
    projects: overrides.projects ?? [
      {
        projectRoot: "C:\\Users\\example\\workspace\\lvis-project\\lvis-app",
        projectName: "lvis-app",
        isDefault: true,
      },
      {
        projectRoot: "C:\\Users\\example\\workspace\\lvis-project\\other-app",
        projectName: "other-app",
      },
    ],
    currentSessionId: "sess-1",
    onLoadSession,
    onNewChatForProject,
    ...overrides,
  };

  const previous = (window as unknown as { lvis?: unknown }).lvis;
  (window as unknown as { lvis?: unknown }).lvis = {
    ...(previous && typeof previous === "object" ? previous : {}),
    ui: {
      showNativeContextMenu,
      onNativeContextMenuAction: (handler: (action: NativeContextMenuAction) => void) => {
        nativeContextActionHandler = handler;
        return () => {
          if (nativeContextActionHandler === handler) nativeContextActionHandler = null;
        };
      },
    },
    workspace: {
      removeRoot,
      listRoots,
      pickRoot,
    },
  };

  const result = render(
    <TooltipProvider>
      <Harness {...props} />
    </TooltipProvider>,
  );

  return {
    ...result,
    onLoadSession,
    onNewChatForProject,
    showNativeContextMenu,
    removeRoot,
    listRoots,
    pickRoot,
    addedRoot: ADDED_ROOT,
    emitNativeContextCommand: (command: NativeContextMenuAction["command"]) => {
      const payload = showNativeContextMenu.mock.calls.at(-1)?.[0];
      if (!payload) throw new Error("native context menu was not requested");
      nativeContextActionHandler?.({ requestId: payload.requestId, command });
    },
    restore: () => {
      if (previous === undefined) {
        delete (window as unknown as { lvis?: unknown }).lvis;
      } else {
        (window as unknown as { lvis?: unknown }).lvis = previous;
      }
    },
  };
}

describe("Sidebar project sessions", () => {
  it("does not fetch workspace roots when the parent supplies projects", async () => {
    const { listRoots, restore } = renderSidebar();
    try {
      await Promise.resolve();
      expect(listRoots).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("renders no-project conversations as a plain ungrouped list on the Chats tab, and real projects as groups on the Projects tab", async () => {
    const { getByTestId, getByText, queryByTestId, restore } = renderSidebar();
    try {
      // Chats tab is the default active tab — the ungrouped list is visible
      // immediately, never wrapped in a fake default-project group.
      expect(queryByTestId("sidebar-current-project")).toBeNull();
      const unassigned = getByTestId("sidebar-unassigned-sessions");
      expect(unassigned.textContent).toContain("전체 동기화로 상태 파악");
      expect(unassigned.textContent).toContain("사이드 패널 개선");
      expect(getByText("전체 동기화로 상태 파악")).toBeTruthy();
      expect(getByText("사이드 패널 개선")).toBeTruthy();
      expect(getByTestId("sidebar-session-sess-1").getAttribute("aria-current")).toBe("page");

      // Switching to the Projects tab reveals "other-app" as its own named
      // group.
      activateTab(getByTestId("sidebar-tab-projects"));
      await waitFor(() => {
        expect(getByTestId("sidebar-project-C-Users-example-workspace-lvis-project-other-app").textContent).toContain("other-app");
      });
      expect(getByText("다른 프로젝트 대화")).toBeTruthy();
    } finally {
      restore();
    }
  });


  it("keeps a stale project conversation as a general chat without resurrecting its project", async () => {
    const staleRoot = "C:\\Users\\example\\workspace\\deleted-project";
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      projects: [{
        projectRoot: "C:\\Users\\example\\workspace\\default",
        projectName: "default",
        isDefault: true,
      }],
      sessions: [{
        id: "stale-session",
        title: "보존된 일반 대화",
        modifiedAt: new Date().toISOString(),
        sessionKind: "main",
        projectRoot: staleRoot,
        projectName: "deleted-project",
      }],
    });
    try {
      expect(getByTestId("sidebar-unassigned-sessions").textContent).toContain("보존된 일반 대화");

      activateTab(getByTestId("sidebar-tab-projects"));
      await waitFor(() => {
        expect(queryByTestId("sidebar-project-C-Users-example-workspace-deleted-project")).toBeNull();
      });
    } finally {
      restore();
    }
  });
  it("loads a selected project conversation through the existing session loader", async () => {
    const { getByTestId, onLoadSession, restore } = renderSidebar();
    try {
      fireEvent.click(getByTestId("sidebar-session-sess-2"));
      expect(onLoadSession).toHaveBeenCalledWith("sess-2");
    } finally {
      restore();
    }
  });

  it("starts a new conversation scoped to the selected project", async () => {
    const { getByTestId, onNewChatForProject, restore } = renderSidebar();
    try {
      activateTab(getByTestId("sidebar-tab-projects"));
      await waitFor(() => {
        expect(getByTestId("sidebar-project-C-Users-example-workspace-lvis-project-other-app").textContent).toContain("other-app");
      });
      fireEvent.click(getByTestId("sidebar-project-C-Users-example-workspace-lvis-project-other-app"));
      expect(onNewChatForProject).toHaveBeenCalledWith({
        projectRoot: "C:\\Users\\example\\workspace\\lvis-project\\other-app",
        projectName: "other-app",
      });
    } finally {
      restore();
    }
  });
});

describe("Sidebar legacy default-root session handling", () => {
  // Pre-PR, markMainActiveAfterTurn persisted projectRoot (= the default
  // workspace root)/projectName ("workspace") for EVERY session with no
  // isDefault guard. namedProjects' "unknown project" fallback only excludes
  // a session's projectRoot when it matches a KNOWN (non-default) project —
  // the default root itself was never checked, so a legacy session's
  // default-tagged metadata fell into that fallback and rendered as its own
  // phantom "workspace" project group (sidebar AND Insights, since both read
  // the same session list). The primary fix scrubs this at the read
  // chokepoint (handleChatSessions, src/ipc/handlers/chat.ts — see
  // chat-project.test.ts's "legacy default-root metadata scrub" coverage),
  // so production sessions never reach this component with that metadata at
  // all. This test locks in a second, cheap defense-in-depth guard directly
  // in namedProjects (this file) against the RAW pre-scrub shape, so the
  // grouping algorithm itself stays correct independent of any given caller
  // having already sanitized its `sessions` prop.
  it("renders a session tagged with the default project root as ungrouped, not as a phantom 'workspace' project group", async () => {
    // Matches the default root renderSidebar's workspace.listRoots stub
    // reports below (isDefault: true) — the exact "legacy default-tagged"
    // shape pre-PR persistence produced (projectRoot=defaultRoot,
    // projectName="workspace").
    const DEFAULT_ROOT = "C:\\Users\\example\\workspace\\lvis-project\\lvis-app";
    const legacySession: SessionSummary = {
      id: "legacy-session",
      title: "레거시 기본 프로젝트 대화",
      modifiedAt: new Date().toISOString(),
      sessionKind: "main",
      projectRoot: DEFAULT_ROOT,
      projectName: "workspace",
    };
    const { getByTestId, getByText, queryByTestId, restore } = renderSidebar({
      sessions: [legacySession],
      currentSessionId: "legacy-session",
    });
    try {
      // The default project entry comes from the async workspace.listRoots
      // stub (like the "other-app" project in the tests above) — wait for
      // it to settle so the assertion reflects steady state, not the
      // pre-fetch render where workspaceProjects is still [].
      await waitFor(() => {
        expect(getByTestId("sidebar-unassigned-sessions").textContent).toContain("레거시 기본 프로젝트 대화");
      });
      expect(getByText("레거시 기본 프로젝트 대화")).toBeTruthy();
      // No ghost project group synthesized from the default root anywhere in
      // the Projects tab — only the unrelated "other-app" real project from
      // renderSidebar's stub. (Can't grep broadly for "workspace" in the
      // testid: the default root's OWN path legitimately contains that
      // substring — "C:\Users\example\workspace\..." — so the precise
      // ghost-group testid is asserted directly instead.)
      activateTab(getByTestId("sidebar-tab-projects"));
      await waitFor(() => expect(getByTestId("sidebar-project-C-Users-example-workspace-lvis-project-other-app")).toBeTruthy());
      expect(queryByTestId("sidebar-project-C-Users-example-workspace-lvis-project-lvis-app")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("Sidebar Chats/Projects tabs", () => {
  it("defaults to the Chats tab and reports switches through onActiveSidebarTabChange", () => {
    const onActiveSidebarTabChange = vi.fn();
    const { getByTestId, restore } = renderSidebar({ onActiveSidebarTabChange });
    try {
      expect(getByTestId("sidebar-tab-chats").getAttribute("data-state")).toBe("active");
      expect(getByTestId("sidebar-tab-projects").getAttribute("data-state")).toBe("inactive");

      activateTab(getByTestId("sidebar-tab-projects"));
      expect(onActiveSidebarTabChange).toHaveBeenCalledWith("projects");
      expect(getByTestId("sidebar-tab-projects").getAttribute("data-state")).toBe("active");
      expect(getByTestId("sidebar-tab-chats").getAttribute("data-state")).toBe("inactive");
    } finally {
      restore();
    }
  });

  it("honors an externally-controlled initial activeSidebarTab", () => {
    const { getByTestId, restore } = renderSidebar({ activeSidebarTab: "projects" });
    try {
      expect(getByTestId("sidebar-tab-projects").getAttribute("data-state")).toBe("active");
      expect(getByTestId("sidebar-tab-chats").getAttribute("data-state")).toBe("inactive");
      expect(getByTestId("sidebar-projects").getAttribute("data-state")).toBe("active");
    } finally {
      restore();
    }
  });
});

describe("Sidebar conversation pinning", () => {
  it("shows a pin toggle per conversation row and calls onToggleSessionStar with the session id and title", () => {
    const onToggleSessionStar = vi.fn();
    const { getByTestId, restore } = renderSidebar({
      isSessionStarred: () => null,
      onToggleSessionStar,
    });
    try {
      const pinButton = getByTestId("sidebar-session-pin-sess-1");
      expect(pinButton.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(pinButton);
      expect(onToggleSessionStar).toHaveBeenCalledWith("sess-1", "전체 동기화로 상태 파악");
    } finally {
      restore();
    }
  });

  it("sorts a pinned conversation to the top of the ungrouped list, ahead of a more recent unpinned one", () => {
    const { getByTestId, restore } = renderSidebar({
      isSessionStarred: (sessionId: string) => (sessionId === "sess-2" ? "starred-id" : null),
      onToggleSessionStar: vi.fn(),
    });
    try {
      const unassigned = getByTestId("sidebar-unassigned-sessions");
      const rows = Array.from(unassigned.querySelectorAll('[data-testid^="sidebar-session-"]'))
        .filter((el) => {
          // Keep only the row's own load button. Each row also carries a pin
          // and a menu button under the same `sidebar-session` prefix.
          const id = el.getAttribute("data-testid") ?? "";
          return !id.includes("-pin-") && !id.includes("-menu-");
        });
      expect(rows.map((el) => el.getAttribute("data-testid"))).toEqual([
        "sidebar-session-sess-2",
        "sidebar-session-sess-1",
      ]);
      expect(getByTestId("sidebar-session-pin-sess-2").getAttribute("aria-pressed")).toBe("true");
    } finally {
      restore();
    }
  });

  it("reverts to recency order once a pinned conversation is unpinned", () => {
    let pinned = new Set(["sess-2"]);
    const { getByTestId, rerender, restore } = renderSidebar({
      isSessionStarred: (sessionId: string) => (pinned.has(sessionId) ? "starred-id" : null),
      onToggleSessionStar: vi.fn(),
    });
    try {
      let unassigned = getByTestId("sidebar-unassigned-sessions");
      let rows = Array.from(unassigned.querySelectorAll('[data-testid^="sidebar-session-"]'))
        .filter((el) => {
          // Keep only the row's own load button. Each row also carries a pin
          // and a menu button under the same `sidebar-session` prefix.
          const id = el.getAttribute("data-testid") ?? "";
          return !id.includes("-pin-") && !id.includes("-menu-");
        });
      expect(rows[0].getAttribute("data-testid")).toBe("sidebar-session-sess-2");

      pinned = new Set();
      rerender(
        <TooltipProvider>
          <Harness
            activeView="home"
            onSelect={vi.fn()}
            pluginViews={[]}
            hasApiKey
            onOpenSettings={vi.fn()}
            onNewChat={vi.fn()}
            streaming={false}
            onOpenMarketplace={vi.fn()}
            collapsed={false}
            onToggleCollapse={vi.fn()}
            onOpenUnifiedSearch={vi.fn()}
            viewNav={{
              segments: [],
              canGoBack: false,
              canGoForward: false,
              onBack: vi.fn(),
              onForward: vi.fn(),
              onSelectSegment: vi.fn(),
            }}
            sessions={[
              {
                id: "sess-1",
                title: "전체 동기화로 상태 파악",
                modifiedAt: new Date().toISOString(),
                sessionKind: "main",
              },
              {
                id: "sess-2",
                title: "사이드 패널 개선",
                modifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                sessionKind: "main",
              },
            ]}
            currentSessionId="sess-1"
            onLoadSession={vi.fn()}
            onNewChatForProject={vi.fn()}
            isSessionStarred={(sessionId: string) => (pinned.has(sessionId) ? "starred-id" : null)}
            onToggleSessionStar={vi.fn()}
          />
        </TooltipProvider>,
      );
      unassigned = getByTestId("sidebar-unassigned-sessions");
      rows = Array.from(unassigned.querySelectorAll('[data-testid^="sidebar-session-"]'))
        .filter((el) => {
          // Keep only the row's own load button. Each row also carries a pin
          // and a menu button under the same `sidebar-session` prefix.
          const id = el.getAttribute("data-testid") ?? "";
          return !id.includes("-pin-") && !id.includes("-menu-");
        });
      expect(rows.map((el) => el.getAttribute("data-testid"))).toEqual([
        "sidebar-session-sess-1",
        "sidebar-session-sess-2",
      ]);
    } finally {
      restore();
    }
  });
});

describe("Sidebar project pinning", () => {
  const projects: ProjectIdentity[] = [
    { projectRoot: "C:\\Users\\example\\workspace\\lvis-project\\alpha", projectName: "alpha", isDefault: false },
    { projectRoot: "C:\\Users\\example\\workspace\\lvis-project\\beta", projectName: "beta", isDefault: false },
  ];

  it("shows a pin/unpin context menu item and calls onToggleProjectPin with the project root", async () => {
    const onToggleProjectPin = vi.fn();
    const {
      getByTestId,
      showNativeContextMenu,
      emitNativeContextCommand,
      restore,
    } = renderSidebar({
      sessions: [],
      projects,
      activeSidebarTab: "projects",
      isProjectPinned: () => false,
      onToggleProjectPin,
    });
    try {
      const projectRow = await waitFor(() => getByTestId("sidebar-project-C-Users-example-workspace-lvis-project-alpha"));
      fireEvent.contextMenu(projectRow);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "project",
        commands: expect.arrayContaining([
          "project.pin",
          "project.new-chat",
          "project.reveal",
          "project.remove",
        ]),
      }));
      emitNativeContextCommand("project.pin");
      expect(onToggleProjectPin).toHaveBeenCalledWith("C:\\Users\\example\\workspace\\lvis-project\\alpha");
    } finally {
      restore();
    }
  });


  it("refreshes projects only after the native remove action succeeds", async () => {
    const onRefreshProjects = vi.fn();
    const {
      getByTestId,
      removeRoot,
      emitNativeContextCommand,
      restore,
    } = renderSidebar({
      sessions: [],
      projects,
      activeSidebarTab: "projects",
      onRefreshProjects,
    });
    try {
      const projectRow = await waitFor(() =>
        getByTestId("sidebar-project-C-Users-example-workspace-lvis-project-alpha"));
      fireEvent.contextMenu(projectRow);
      emitNativeContextCommand("project.remove");

      await waitFor(() => {
        expect(removeRoot).toHaveBeenCalledWith(
          "C:\\Users\\example\\workspace\\lvis-project\\alpha",
        );
        expect(onRefreshProjects).toHaveBeenCalledTimes(1);
      });
    } finally {
      restore();
    }
  });

  it("keeps the project and surfaces the IPC error when native remove fails", async () => {
    const onRefreshProjects = vi.fn();
    const onProjectError = vi.fn();
    const {
      getByTestId,
      removeRoot,
      emitNativeContextCommand,
      restore,
    } = renderSidebar({
      sessions: [],
      projects,
      activeSidebarTab: "projects",
      onRefreshProjects,
      onProjectError,
    });
    removeRoot.mockResolvedValueOnce({
      ok: false,
      error: "not-an-additional-root",
      message: "not registered",
    } as never);
    try {
      const projectRow = await waitFor(() =>
        getByTestId("sidebar-project-C-Users-example-workspace-lvis-project-alpha"));
      fireEvent.contextMenu(projectRow);
      emitNativeContextCommand("project.remove");

      await waitFor(() => {
        expect(onProjectError).toHaveBeenCalledWith(
          "remove",
          "not-an-additional-root",
          "not registered",
        );
      });
      expect(onRefreshProjects).not.toHaveBeenCalled();
      expect(getByTestId("sidebar-project-C-Users-example-workspace-lvis-project-alpha")).toBeTruthy();
    } finally {
      restore();
    }
  });
  it("sorts a pinned project to the top of the Projects tab", async () => {
    const { getByTestId, restore } = renderSidebar({
      sessions: [],
      projects,
      activeSidebarTab: "projects",
      isProjectPinned: (root) => root === "C:\\Users\\example\\workspace\\lvis-project\\beta",
      onToggleProjectPin: vi.fn(),
    });
    try {
      await waitFor(() => expect(getByTestId("sidebar-projects")).toBeTruthy());
      const projectsPanel = getByTestId("sidebar-projects");
      // Scoped to the actual project-root buttons only — the context menu's
      // own items/content also carry a "sidebar-project-" prefixed testid
      // (e.g. "sidebar-project-menu-pin"), so match on the root-path suffix.
      const rows = Array.from(projectsPanel.querySelectorAll('[data-testid^="sidebar-project-C-Users"]'));
      expect(rows.map((el) => el.getAttribute("data-testid"))).toEqual([
        "sidebar-project-C-Users-example-workspace-lvis-project-beta",
        "sidebar-project-C-Users-example-workspace-lvis-project-alpha",
      ]);
    } finally {
      restore();
    }
  });
});

describe("Sidebar projects tab add-project context menu", () => {
  const projects: ProjectIdentity[] = [
    { projectRoot: "C:\\Users\\example\\workspace\\lvis-project\\alpha", projectName: "alpha", isDefault: false },
  ];

  it("offers add-project when the Projects tab's empty area is right-clicked, and adds through workspace.pickRoot", async () => {
    const onRefreshProjects = vi.fn();
    const {
      getByTestId,
      showNativeContextMenu,
      emitNativeContextCommand,
      pickRoot,
      restore,
    } = renderSidebar({
      sessions: [],
      projects,
      activeSidebarTab: "projects",
      onRefreshProjects,
    });
    try {
      const tabBody = await waitFor(() => getByTestId("sidebar-projects"));
      fireEvent.contextMenu(tabBody);
      expect(showNativeContextMenu).toHaveBeenCalledTimes(1);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "project",
        commands: ["project.add"],
      }));

      emitNativeContextCommand("project.add");
      await waitFor(() => {
        expect(pickRoot).toHaveBeenCalledTimes(1);
        expect(onRefreshProjects).toHaveBeenCalledTimes(1);
      });
    } finally {
      restore();
    }
  });

  it("surfaces a refused add instead of leaving the right-click a no-op", async () => {
    const onRefreshProjects = vi.fn();
    const onProjectError = vi.fn();
    const { getByTestId, emitNativeContextCommand, pickRoot, restore } = renderSidebar({
      sessions: [],
      projects,
      activeSidebarTab: "projects",
      onRefreshProjects,
      onProjectError,
    });
    pickRoot.mockResolvedValueOnce({ ok: false, error: "persist-failed" } as never);
    try {
      const tabBody = await waitFor(() => getByTestId("sidebar-projects"));
      fireEvent.contextMenu(tabBody);
      emitNativeContextCommand("project.add");

      await waitFor(() => expect(onProjectError).toHaveBeenCalledWith("add", "persist-failed"));
      expect(onRefreshProjects).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("offers add-project from the Projects tab trigger", async () => {
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, pickRoot, restore } =
      renderSidebar({ sessions: [], projects, activeSidebarTab: "chats" });
    try {
      fireEvent.contextMenu(getByTestId("sidebar-tab-projects"));
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "project",
        commands: ["project.add"],
      }));

      emitNativeContextCommand("project.add");
      await waitFor(() => expect(pickRoot).toHaveBeenCalledTimes(1));
    } finally {
      restore();
    }
  });

  it("keeps the per-row menu authoritative — a right-click on a project row requests exactly one menu, the row's", async () => {
    const onRefreshProjects = vi.fn();
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, onNewChatForProject, restore } =
      renderSidebar({ sessions: [], projects, activeSidebarTab: "projects", onRefreshProjects });
    try {
      const row = await waitFor(() =>
        getByTestId("sidebar-project-C-Users-example-workspace-lvis-project-alpha"));
      fireEvent.contextMenu(row);

      // The tab body's own handler must NOT also fire and replace the row's
      // pending menu — one right-click, one menu request.
      expect(showNativeContextMenu).toHaveBeenCalledTimes(1);
      const payload = showNativeContextMenu.mock.calls[0]?.[0];
      expect(payload?.commands).toEqual(expect.arrayContaining([
        "project.new-chat",
        "project.add",
        "project.remove",
      ]));

      // The row's own primary action still resolves against the row's handlers.
      emitNativeContextCommand("project.new-chat");
      expect(onNewChatForProject).toHaveBeenCalledWith({
        projectRoot: "C:\\Users\\example\\workspace\\lvis-project\\alpha",
        projectName: "alpha",
      });
    } finally {
      restore();
    }
  });

  it("holds the add behind the adjacency warning and completes it with the ack token", async () => {
    const onRefreshProjects = vi.fn();
    const {
      getByTestId,
      queryByTestId,
      emitNativeContextCommand,
      pickRoot,
      addedRoot,
      restore,
    } = renderSidebar({ sessions: [], projects, activeSidebarTab: "projects", onRefreshProjects });
    try {
      pickRoot.mockResolvedValueOnce({
        ok: true,
        requiresAcknowledgement: true,
        pendingPath: addedRoot,
        ackToken: "ack-1",
        warnings: ["close to a sensitive location"],
      });

      fireEvent.contextMenu(await waitFor(() => getByTestId("sidebar-projects")));
      emitNativeContextCommand("project.add");

      const warning = await waitFor(() => getByTestId("sidebar-project-root-warning"));
      expect(warning.textContent).toContain("close to a sensitive location");
      expect(onRefreshProjects).not.toHaveBeenCalled();

      fireEvent.click(getByTestId("sidebar-project-root-warning-confirm"));
      await waitFor(() => {
        expect(pickRoot).toHaveBeenLastCalledWith({ ackToken: "ack-1" });
        expect(onRefreshProjects).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => expect(queryByTestId("sidebar-project-root-warning")).toBeNull());
    } finally {
      restore();
    }
  });

  it("dismisses the adjacency warning without adding", async () => {
    const onRefreshProjects = vi.fn();
    const { getByTestId, queryByTestId, emitNativeContextCommand, pickRoot, addedRoot, restore } =
      renderSidebar({ sessions: [], projects, activeSidebarTab: "projects", onRefreshProjects });
    try {
      pickRoot.mockResolvedValueOnce({
        ok: true,
        requiresAcknowledgement: true,
        pendingPath: addedRoot,
        ackToken: "ack-1",
        warnings: ["close to a sensitive location"],
      });

      fireEvent.contextMenu(await waitFor(() => getByTestId("sidebar-projects")));
      emitNativeContextCommand("project.add");

      fireEvent.click(await waitFor(() => getByTestId("sidebar-project-root-warning-cancel")));
      await waitFor(() => expect(queryByTestId("sidebar-project-root-warning")).toBeNull());
      expect(pickRoot).toHaveBeenCalledTimes(1);
      expect(onRefreshProjects).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("Sidebar conversation context menu", () => {
  it("opens and pins an unpinned conversation through the native menu", async () => {
    const onToggleSessionStar = vi.fn();
    const { getByTestId, onLoadSession, showNativeContextMenu, emitNativeContextCommand, restore } = renderSidebar({
      onToggleSessionStar,
      isSessionStarred: () => null,
    });
    try {
      const row = await waitFor(() => getByTestId("sidebar-session-sess-1"));
      fireEvent.contextMenu(row);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "conversation",
        commands: ["conversation.open", "conversation.pin"],
      }));

      emitNativeContextCommand("conversation.open");
      expect(onLoadSession).toHaveBeenCalledWith("sess-1");

      fireEvent.contextMenu(row);
      emitNativeContextCommand("conversation.pin");
      expect(onToggleSessionStar).toHaveBeenCalledWith("sess-1", "전체 동기화로 상태 파악");
    } finally {
      restore();
    }
  });

  it("offers unpin for a pinned conversation", async () => {
    const onToggleSessionStar = vi.fn();
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, restore } = renderSidebar({
      onToggleSessionStar,
      isSessionStarred: (sessionId) => sessionId === "sess-1" ? "star-1" : null,
    });
    try {
      const row = await waitFor(() => getByTestId("sidebar-session-sess-1"));
      fireEvent.contextMenu(row);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "conversation",
        commands: ["conversation.open", "conversation.unpin"],
      }));

      emitNativeContextCommand("conversation.unpin");
      expect(onToggleSessionStar).toHaveBeenCalledWith("sess-1", "전체 동기화로 상태 파악");
    } finally {
      restore();
    }
  });

  it("does not expose session switching for an inactive conversation while streaming", async () => {
    const onToggleSessionStar = vi.fn();
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({
      streaming: true,
      onToggleSessionStar,
      isSessionStarred: () => null,
    });
    try {
      const inactiveRow = await waitFor(() => getByTestId("sidebar-session-sess-2"));
      expect(inactiveRow).toBeDisabled();
      fireEvent.contextMenu(inactiveRow);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "conversation",
        commands: ["conversation.pin"],
      }));
    } finally {
      restore();
    }
  });
});

describe("Sidebar conversation row actions", () => {
  const rowState = () => ({
    archived: new Set<string>(),
    unread: new Set<string>(),
    onRename: vi.fn(),
    onSetArchived: vi.fn(),
    onSetUnread: vi.fn(),
    onShare: vi.fn(),
    onCopy: vi.fn(),
    onDelete: vi.fn(),
  });

  const asActions = (state: ReturnType<typeof rowState>) => ({
    isArchived: (id: string) => state.archived.has(id),
    isUnread: (id: string) => state.unread.has(id),
    onRename: state.onRename,
    onSetArchived: state.onSetArchived,
    onSetUnread: state.onSetUnread,
    onShare: state.onShare,
    onCopy: state.onCopy,
    onDelete: state.onDelete,
  });

  it("opens the same menu from the trailing button as from a right-click", () => {
    const state = rowState();
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({
      conversationActions: asActions(state),
    });
    fireEvent.click(getByTestId("sidebar-session-menu-sess-1"));
    const call = showNativeContextMenu.mock.calls.at(-1)?.[0];
    expect(call?.kind).toBe("conversation");
    // Every command the row offers must be one the main-side allow-list knows.
    expect(call?.commands).toEqual(
      expect.arrayContaining([
        "conversation.rename",
        "conversation.mark-unread",
        "conversation.share",
        "conversation.copy",
        "conversation.archive",
        "conversation.delete",
      ]),
    );
    restore();
  });

  it("offers unarchive and mark-read once the row is in those states", () => {
    const state = rowState();
    state.archived.add("sess-1");
    state.unread.add("sess-1");
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({
      conversationActions: asActions(state),
    });
    fireEvent.click(getByTestId("sidebar-toggle-archived"));
    fireEvent.click(getByTestId("sidebar-session-menu-sess-1"));
    const call = showNativeContextMenu.mock.calls.at(-1)?.[0];
    expect(call?.commands).toContain("conversation.unarchive");
    expect(call?.commands).toContain("conversation.mark-read");
    expect(call?.commands).not.toContain("conversation.archive");
    expect(call?.commands).not.toContain("conversation.mark-unread");
    restore();
  });

  it("hides archived conversations until the archive toggle is used", () => {
    const state = rowState();
    state.archived.add("sess-1");
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      conversationActions: asActions(state),
    });
    expect(queryByTestId("sidebar-session-sess-1")).toBeNull();
    fireEvent.click(getByTestId("sidebar-toggle-archived"));
    expect(queryByTestId("sidebar-session-sess-1")).not.toBeNull();
    restore();
  });

  it("commits a rename on Enter and abandons it on Escape", () => {
    const state = rowState();
    const { getByTestId, emitNativeContextCommand, restore } = renderSidebar({
      conversationActions: asActions(state),
    });
    fireEvent.click(getByTestId("sidebar-session-menu-sess-1"));
    act(() => emitNativeContextCommand("conversation.rename"));
    const field = getByTestId("sidebar-session-rename-sess-1");
    fireEvent.change(field, { target: { value: "새 이름" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(state.onRename).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("sidebar-session-menu-sess-1"));
    act(() => emitNativeContextCommand("conversation.rename"));
    const again = getByTestId("sidebar-session-rename-sess-1");
    fireEvent.change(again, { target: { value: "새 이름" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(state.onRename).toHaveBeenCalledWith("sess-1", "새 이름");
    restore();
  });
});

describe("Sidebar collapsed rail", () => {
  it("renders collapsed as well as expanded", () => {
    // The collapsed rail returns EARLY from the conversation list, so any hook
    // added below that branch renders in one state and not the other. React
    // reports that as "rendered fewer hooks than expected" and the whole app
    // falls into the error boundary — which is what this asserts against.
    const { getByTestId, restore } = renderSidebar({ collapsed: true });
    expect(getByTestId("sidebar-cluster")).toBeTruthy();
    restore();
  });
});
