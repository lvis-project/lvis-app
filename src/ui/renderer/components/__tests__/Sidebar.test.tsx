// @vitest-environment jsdom
import { triggerIntersection } from "../../../../../test/renderer/setup.js";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
  // EVERY listener, not the last one: the preload's own registration is
  // `ipcRenderer.on`, and the sidebar now has two subscribers of its own — the
  // session/project rows and the view rows. Keeping one would deliver the
  // action to whichever mounted last and silently drop the other's menus.
  const nativeContextActionHandlers = new Set<(action: NativeContextMenuAction) => void>();
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
        nativeContextActionHandlers.add(handler);
        return () => {
          nativeContextActionHandlers.delete(handler);
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
      // The request id is what routes it: only the hook that opened this menu
      // holds a pending entry for that id, so the others ignore it.
      for (const handler of nativeContextActionHandlers) {
        handler({ requestId: payload.requestId, command });
      }
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

  it("keeps another conversation reachable while this one is streaming", async () => {
    const onToggleSessionStar = vi.fn();
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({
      streaming: true,
      onToggleSessionStar,
      isSessionStarred: () => null,
    });
    try {
      const inactiveRow = await waitFor(() => getByTestId("sidebar-session-sess-2"));
      // One conversation's turn is not a reason to lock the others away. Where
      // the incoming conversation goes is the window's call — it gives it a
      // group of its own rather than taking the running one's place — so the
      // sidebar's job is simply to stay openable.
      expect(inactiveRow).not.toBeDisabled();
      fireEvent.contextMenu(inactiveRow);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "conversation",
        commands: expect.arrayContaining(["conversation.open"]),
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
    responding: new Set<string>(),
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
    isResponding: (id: string) => state.responding.has(id),
    onRename: state.onRename,
    onSetArchived: state.onSetArchived,
    onSetUnread: state.onSetUnread,
    onShare: state.onShare,
    onCopy: state.onCopy,
    onDelete: state.onDelete,
  });

  it("shows a responding dot on a row whose conversation has a turn running, in place of the kind glyph", () => {
    const state = rowState();
    state.responding.add("sess-2");
    const { getByTestId, queryByTestId, restore } = renderSidebar({ conversationActions: asActions(state) });
    try {
      const dot = getByTestId("sidebar-session-responding-sess-2");
      expect(dot.getAttribute("aria-label")).toBeTruthy();
      expect(getByTestId("sidebar-session-sess-2").closest("[data-responding='true']")).toBeTruthy();
      expect(queryByTestId("sidebar-session-responding-sess-1")).toBeNull();
      expect(getByTestId("sidebar-session-sess-1").closest("[data-responding='true']")).toBeNull();
    } finally {
      restore();
    }
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

  it("offers import on the LIST, and only row commands on a row", () => {
    const state = rowState();
    const onImport = vi.fn();
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({
      conversationActions: { ...asActions(state), onImport },
    });
    // The list's own blank area answers with import and nothing row-scoped:
    // import creates a NEW conversation, so it cannot act on a row.
    fireEvent.contextMenu(getByTestId("sidebar-unassigned-sessions"));
    const listMenu = showNativeContextMenu.mock.calls.at(-1)?.[0];
    expect(listMenu?.commands).toEqual(["conversation.import"]);

    // A row answers first and does NOT offer import.
    fireEvent.click(getByTestId("sidebar-session-menu-sess-1"));
    const rowMenu = showNativeContextMenu.mock.calls.at(-1)?.[0];
    expect(rowMenu?.commands).not.toContain("conversation.import");
    expect(rowMenu?.commands).toContain("conversation.delete");
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

  it("shows icons only — no nav label is left to overflow the rail", () => {
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      collapsed: true,
      failedPluginCards: [FAILED_PLUGIN_CARD],
    });
    const buttons = getByTestId("primary-sidebar").querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.textContent?.trim()).toBe("");
    }
    // The groups are single icons; their rows wait in the flyout.
    expect(getByTestId("sidebar-group-features")).toBeTruthy();
    expect(getByTestId("sidebar-group-plugins")).toBeTruthy();
    expect(queryByTestId("toolbar-work-board")).toBeNull();
    restore();
  });

  it("opens the group's flyout from the rail icon without expanding the sidebar", async () => {
    const onToggleCollapse = vi.fn();
    const onSelect = vi.fn();
    const { getByTestId, findByTestId, queryByTestId, restore } = renderSidebar({
      collapsed: true,
      onToggleCollapse,
      onSelect,
    });

    fireEvent.click(getByTestId("sidebar-group-features"));
    const menu = await findByTestId("sidebar-group-features-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(onToggleCollapse).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("sidebar-routines"));
    expect(onSelect).toHaveBeenCalledWith("routines");
    await waitFor(() => expect(queryByTestId("sidebar-group-features-menu")).toBeNull());
    expect(onToggleCollapse).not.toHaveBeenCalled();
    restore();
  });

  it("expands the sidebar onto the Projects tab when the rail's folder is clicked", () => {
    const onToggleCollapse = vi.fn();
    const onActiveSidebarTabChange = vi.fn();
    const { getByTestId, restore } = renderSidebar({
      collapsed: true,
      onToggleCollapse,
      onActiveSidebarTabChange,
    });

    fireEvent.click(getByTestId("sidebar-projects-collapsed"));

    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    expect(onActiveSidebarTabChange).toHaveBeenCalledWith("projects");
    restore();
  });
});

const FAILED_PLUGIN_CARD: NonNullable<Parameters<typeof Sidebar>[0]["failedPluginCards"]>[number] = {
  id: "notes",
  name: "Notes",
  description: "Notes fixture",
  publisher: "Test fixture",
  sampleTools: [],
  capabilities: [],
  tools: [],
  loadStatus: "failed",
};

describe("Sidebar nav groups", () => {
  it("has no home row and no marketplace row", () => {
    const { queryByTestId, queryByText, restore } = renderSidebar();
    expect(queryByTestId("sidebar-home")).toBeNull();
    expect(queryByTestId("sidebar-marketplace")).toBeNull();
    expect(queryByText("홈")).toBeNull();
    expect(queryByText("Home")).toBeNull();
    expect(queryByText("마켓플레이스")).toBeNull();
    expect(queryByText("Marketplace")).toBeNull();
    restore();
  });

  it("opens the Features flyout from its row with menu semantics; a pick navigates and closes it", async () => {
    const onSelect = vi.fn();
    const { getByTestId, findByTestId, queryByTestId, restore } = renderSidebar({
      onSelect,
      activeView: "routines",
    });
    const trigger = getByTestId("sidebar-group-features");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The trigger says one of its rows is the page, since the rows are hidden.
    expect(trigger.getAttribute("data-active")).toBe("true");
    expect(queryByTestId("toolbar-work-board")).toBeNull();

    fireEvent.click(trigger);
    const menu = await findByTestId("sidebar-group-features-menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe("sidebar-group-features-menu");
    const rows = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((row) => row.getAttribute("data-testid"));
    expect(rows).toEqual(["toolbar-work-board", "sidebar-routines", "sidebar-starred"]);
    expect(getByTestId("sidebar-routines").getAttribute("aria-current")).toBe("page");

    fireEvent.click(getByTestId("toolbar-work-board"));
    expect(onSelect).toHaveBeenCalledWith("work-board");
    await waitFor(() => expect(queryByTestId("sidebar-group-features-menu")).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    restore();
  });

  it("walks the rows with the arrow keys, wrapping, and closes on Escape", async () => {
    const { getByTestId, findByTestId, queryByTestId, restore } = renderSidebar();
    fireEvent.click(getByTestId("sidebar-group-features"));
    const menu = await findByTestId("sidebar-group-features-menu");
    await waitFor(() => expect(document.activeElement).toBe(getByTestId("toolbar-work-board")));

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getByTestId("sidebar-routines"));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(getByTestId("sidebar-starred"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getByTestId("toolbar-work-board"));
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(getByTestId("sidebar-starred"));

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(queryByTestId("sidebar-group-features-menu")).toBeNull());
    restore();
  });

  it("renders the Plugins group only when there is a plugin row, and lists it in the flyout", async () => {
    const empty = renderSidebar();
    expect(empty.queryByTestId("sidebar-group-plugins")).toBeNull();
    empty.restore();
    cleanup();

    const onSelect = vi.fn();
    const { getByTestId, findByTestId, queryByTestId, restore } = renderSidebar({
      failedPluginCards: [FAILED_PLUGIN_CARD],
      onSelect,
    });
    fireEvent.click(getByTestId("sidebar-group-plugins"));
    const menu = await findByTestId("sidebar-group-plugins-menu");
    const row = menu.querySelector<HTMLElement>('[role="menuitem"]');
    expect(row?.textContent).toContain("Notes");
    expect(row?.textContent).toContain("Doctor");

    fireEvent.click(row!);
    expect(onSelect).toHaveBeenCalledWith("plugin-doctor:notes");
    await waitFor(() => expect(queryByTestId("sidebar-group-plugins-menu")).toBeNull());
    restore();
  });
});

describe("Sidebar settings alert (no chat model configured)", () => {
  // The composer status row used to carry this fact as a green dot; it now
  // shows only when it is bad, on the entry that fixes it — in both layouts,
  // since the collapsed rail is where a user spends most of the day.
  it.each([
    ["expanded", false],
    ["collapsed rail", true],
  ] as const)("marks the Settings entry red when no model is configured (%s)", (_layout, collapsed) => {
    const { getByTestId, restore } = renderSidebar({ collapsed, modelConfigured: false });
    const badge = getByTestId("sidebar-settings-alert");
    expect(getByTestId("sidebar-settings").contains(badge)).toBe(true);
    expect(badge.className).toContain("bg-destructive");
    expect(badge.getAttribute("aria-label")).toBe("채팅 모델 미설정");
    restore();
  });

  it.each([
    ["configured", true],
    ["not yet known", null],
  ] as const)("shows no badge while the model is %s", (_state, modelConfigured) => {
    for (const collapsed of [false, true]) {
      const { queryByTestId, restore } = renderSidebar({ collapsed, modelConfigured });
      expect(queryByTestId("sidebar-settings-alert")).toBeNull();
      restore();
      cleanup();
    }
  });
});

describe("Sidebar current-row scoping", () => {
  it("marks the loaded conversation as the current page only while a conversation is showing", () => {
    const onChat = renderSidebar({ activeView: "home" });
    expect(
      onChat.getByTestId("sidebar-session-sess-1").getAttribute("aria-current"),
    ).toBe("page");
    onChat.restore();
    cleanup();

    // A session stays LOADED while the user reads a plugin view, but the page
    // they are on is the plugin. Both rows claiming `aria-current="page"` told
    // a screen reader the window was in two places at once, and drew the chat
    // row selected underneath the selected plugin row.
    const onPlugin = renderSidebar({ activeView: "plugin:notes:panel" });
    expect(
      onPlugin.getByTestId("sidebar-session-sess-1").getAttribute("aria-current"),
    ).toBeNull();
    onPlugin.restore();
  });
});

describe("Sidebar conversation reveal on scroll", () => {
  const OTHER_ROOT = "C:\\Users\\example\\workspace\\lvis-project\\other-app";

  /** How many of `conversations` currently have a row in the sidebar. */
  function countRenderedRows(
    conversations: SessionSummary[],
    queryByTestId: (id: string) => HTMLElement | null,
  ): number {
    return conversations.filter((session) => queryByTestId(`sidebar-session-${session.id}`)).length;
  }

  function manyConversations(
    count: number,
    prefix: string,
    project?: { projectRoot: string; projectName: string },
  ): SessionSummary[] {
    return Array.from({ length: count }, (_unused, index) => ({
      id: `${prefix}-${index}`,
      title: `${prefix} 대화 ${index}`,
      modifiedAt: new Date(Date.now() - index * 60_000).toISOString(),
      sessionKind: "main" as const,
      ...(project ?? {}),
    }));
  }

  const SENTINEL = "sidebar-unassigned-sessions-sentinel";

  it("reveals one page per intersection, rebuilding its observer each time", async () => {
    const conversations = manyConversations(15, "일반");
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      sessions: conversations,
      currentSessionId: "일반-0",
    });
    try {
      const renderedRows = () => countRenderedRows(conversations, queryByTestId);

      // One page up front — the rest is not rendered yet, and nothing claims
      // otherwise: the old capped list ended in an inert "N more" label.
      expect(renderedRows()).toBe(6);

      // The sentinel is what asks for the next page, and it must actually be
      // observed — an unobserved sentinel would silently reveal nothing.
      // It is then parked back out of view, because this test is about ONE page
      // per intersection; a sentinel left in view keeps asking, which is the
      // next test's subject.
      await act(async () => {
        expect(triggerIntersection(getByTestId(SENTINEL))).toBe(1);
        triggerIntersection(getByTestId(SENTINEL), false);
      });
      expect(renderedRows()).toBe(12);

      // Still exactly ONE observer: the reveal built a new one and disconnected
      // the old, rather than leaving both watching the same sentinel.
      await act(async () => {
        expect(triggerIntersection(getByTestId(SENTINEL))).toBe(1);
        triggerIntersection(getByTestId(SENTINEL), false);
      });
      expect(renderedRows()).toBe(15);

      // Everything is on screen, so there is nothing left to ask for.
      expect(queryByTestId(SENTINEL)).toBeNull();
    } finally {
      restore();
    }
  });

  it("keeps revealing from one intersection while the sentinel stays in view", async () => {
    const conversations = manyConversations(15, "이어서");
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      sessions: conversations,
      currentSessionId: "이어서-0",
    });
    try {
      const renderedRows = () => countRenderedRows(conversations, queryByTestId);
      expect(renderedRows()).toBe(6);

      // A sentinel that is still on screen after a reveal has to produce the
      // NEXT reveal without being poked again — a page shorter than the
      // scroller would otherwise leave the list stalled with the sentinel
      // sitting in plain view and nothing to scroll toward.
      await act(async () => {
        expect(triggerIntersection(getByTestId(SENTINEL))).toBe(1);
      });
      await waitFor(() => expect(renderedRows()).toBe(15));
      expect(queryByTestId(SENTINEL)).toBeNull();
    } finally {
      restore();
    }
  });

  it("renders a short list whole, with no sentinel to scroll toward", () => {
    const conversations = manyConversations(4, "짧은");
    const { queryByTestId, restore } = renderSidebar({
      sessions: conversations,
      currentSessionId: "짧은-0",
    });
    try {
      for (const session of conversations) {
        expect(queryByTestId(`sidebar-session-${session.id}`)).toBeTruthy();
      }
      expect(queryByTestId(SENTINEL)).toBeNull();
    } finally {
      restore();
    }
  });

  it("pages the list that survives the archive filter, and follows it back down when it shrinks", async () => {
    const conversations = manyConversations(15, "보관");
    const archived = new Set(["보관-1", "보관-3", "보관-5"]);
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      sessions: conversations,
      currentSessionId: "보관-0",
      conversationActions: {
        isArchived: (id: string) => archived.has(id),
        isUnread: () => false,
        isResponding: () => false,
        onRename: vi.fn(),
        onSetArchived: vi.fn(),
        onSetUnread: vi.fn(),
        onShare: vi.fn(),
        onCopy: vi.fn(),
        onDelete: vi.fn(),
      },
    });
    try {
      const renderedRows = () => countRenderedRows(conversations, queryByTestId);

      // A page is a page of rows the reader can SEE: the archived rows leave
      // the list before it is paged, so the first page is six visible rows and
      // not six minus whatever was archived among them.
      expect(renderedRows()).toBe(6);
      expect(queryByTestId("sidebar-session-보관-1")).toBeNull();
      expect(queryByTestId("sidebar-session-보관-6")).not.toBeNull();

      fireEvent.click(getByTestId("sidebar-toggle-archived"));
      await act(async () => {
        triggerIntersection(getByTestId(SENTINEL));
      });
      await waitFor(() => expect(renderedRows()).toBe(15));

      // Hiding them again shortens the list under the window. What is rendered
      // follows the list that exists now — the count from the longer one is not
      // carried over, and nothing is left asking for rows that are gone.
      fireEvent.click(getByTestId("sidebar-toggle-archived"));
      await waitFor(() => expect(renderedRows()).toBe(12));
      expect(queryByTestId(SENTINEL)).toBeNull();
    } finally {
      restore();
    }
  });

  it("gives each project group its own page and a control that opens the rest", async () => {
    const THIRD_ROOT = "C:\\Users\\example\\workspace\\lvis-project\\third-app";
    const conversations = [
      ...manyConversations(9, "프로젝트", { projectRoot: OTHER_ROOT, projectName: "other-app" }),
      ...manyConversations(9, "이웃", { projectRoot: THIRD_ROOT, projectName: "third-app" }),
    ];
    const otherRows = conversations.filter((session) => session.projectRoot === OTHER_ROOT);
    const thirdRows = conversations.filter((session) => session.projectRoot === THIRD_ROOT);
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      sessions: conversations,
      currentSessionId: "프로젝트-0",
      projects: [
        {
          projectRoot: "C:\\Users\\example\\workspace\\lvis-project\\lvis-app",
          projectName: "lvis-app",
          isDefault: true,
        },
        { projectRoot: OTHER_ROOT, projectName: "other-app" },
        { projectRoot: THIRD_ROOT, projectName: "third-app" },
      ],
    });
    const moreId = "sidebar-project-sessions-more-C-Users-example-workspace-lvis-project-other-app";
    try {
      activateTab(getByTestId("sidebar-tab-projects"));

      // Every group shows its first page, so the tab stays an OVERVIEW of the
      // projects instead of one group running long enough to push its siblings
      // below the fold.
      await waitFor(() => expect(countRenderedRows(otherRows, queryByTestId)).toBe(6));
      expect(countRenderedRows(thirdRows, queryByTestId)).toBe(6);

      // The rest is behind a real control this time, not the inert label the
      // capped list used to end with.
      const more = getByTestId(moreId);
      expect(more.tagName).toBe("BUTTON");
      expect(more).toHaveAttribute("aria-expanded", "false");
      expect(more.textContent).toContain("3");

      fireEvent.click(more);
      expect(countRenderedRows(otherRows, queryByTestId)).toBe(9);
      expect(getByTestId(moreId)).toHaveAttribute("aria-expanded", "true");
      // One group opening says nothing about its neighbours.
      expect(countRenderedRows(thirdRows, queryByTestId)).toBe(6);

      fireEvent.click(getByTestId(moreId));
      expect(countRenderedRows(otherRows, queryByTestId)).toBe(6);
      expect(getByTestId(moreId)).toHaveAttribute("aria-expanded", "false");
    } finally {
      restore();
    }
  });
});

describe("Sidebar view rows", () => {
  /** Open the Features flyout and hand back a row from it (it is portaled). */
  async function featuresRow(getByTestId: (id: string) => HTMLElement, rowTestId: string) {
    fireEvent.click(getByTestId("sidebar-group-features"));
    return await waitFor(() => {
      const row = document.querySelector<HTMLButtonElement>(`[data-testid="${rowTestId}"]`);
      expect(row).not.toBeNull();
      return row!;
    });
  }

  it("names both destinations in the row's own menu", async () => {
    const onSelect = vi.fn();
    const onSelectInNewPane = vi.fn();
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, restore } =
      renderSidebar({ onSelect, onSelectInNewPane });
    try {
      const row = await featuresRow(getByTestId, "sidebar-routines");
      fireEvent.contextMenu(row);

      // Both commands are offered, so the second destination is discoverable
      // without anyone having been told about a modifier chord.
      const payload = showNativeContextMenu.mock.calls.at(-1)?.[0];
      expect(payload?.kind).toBe("view-row");
      expect(payload?.commands).toEqual(["view.open", "view.open-in-new-pane"]);

      act(() => emitNativeContextCommand("view.open-in-new-pane"));
      expect(onSelectInNewPane).toHaveBeenCalledWith("routines");
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("offers only the one destination where there is no second pane to open into", async () => {
    // Chat mode withholds the callback entirely, and the row has to follow:
    // a menu row that cannot go anywhere is worse than no menu row.
    const onSelect = vi.fn();
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, restore } =
      renderSidebar({ onSelect });
    try {
      const row = await featuresRow(getByTestId, "sidebar-routines");
      fireEvent.contextMenu(row);
      expect(showNativeContextMenu.mock.calls.at(-1)?.[0]?.commands).toEqual(["view.open"]);

      act(() => emitNativeContextCommand("view.open"));
      expect(onSelect).toHaveBeenCalledWith("routines");
    } finally {
      restore();
    }
  });

  it("routes a modifier-click to the new pane and a plain click to the focused one", async () => {
    const onSelect = vi.fn();
    const onSelectInNewPane = vi.fn();
    const { getByTestId, restore } = renderSidebar({ onSelect, onSelectInNewPane });
    try {
      const row = await featuresRow(getByTestId, "sidebar-routines");
      fireEvent.click(row, { metaKey: true });
      expect(onSelectInNewPane).toHaveBeenCalledWith("routines");
      expect(onSelect).not.toHaveBeenCalled();

      const again = await featuresRow(getByTestId, "sidebar-routines");
      fireEvent.click(again);
      expect(onSelect).toHaveBeenCalledWith("routines");
      expect(onSelectInNewPane).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});

describe("Sidebar — work-board run rows", () => {
  const workBoardRow: SessionSummary = {
    id: "sub-wb-1",
    title: "월간 보고서 초안",
    modifiedAt: new Date().toISOString(),
    sessionKind: "subagent",
    workBoardItemId: 7,
  };
  const mainRow: SessionSummary = {
    id: "sess-1",
    title: "전체 동기화로 상태 파악",
    modifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    sessionKind: "main",
  };

  it("draws the Work icon and opens the board item instead of loading a chat", async () => {
    const onOpenWorkBoardItem = vi.fn();
    const { getByTestId, onLoadSession, restore } = renderSidebar({
      sessions: [workBoardRow, mainRow],
      onOpenWorkBoardItem,
    });
    try {
      await waitFor(() => {
        expect(getByTestId("sidebar-unassigned-sessions").contains(getByTestId("sidebar-session-sub-wb-1"))).toBe(true);
      });
      const glyph = getByTestId("sidebar-session-work-board-sub-wb-1");
      expect(glyph.getAttribute("aria-label")).toBe("워크보드 작업");
      const button = getByTestId("sidebar-session-sub-wb-1");
      expect(button.getAttribute("data-work-board-item")).toBe("7");
      expect(button.getAttribute("draggable")).toBe("false");
      expect(button.getAttribute("aria-current")).toBeNull();
      expect(getByTestId("sidebar-session-sess-1").getAttribute("draggable")).toBe("true");

      fireEvent.click(button);
      expect(onOpenWorkBoardItem).toHaveBeenCalledWith(7);
      expect(onLoadSession).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("offers only 'open' in the context menu, because the row is not a main-store session", async () => {
    const onOpenWorkBoardItem = vi.fn();
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, onLoadSession, restore } = renderSidebar({
      sessions: [workBoardRow, mainRow],
      onOpenWorkBoardItem,
    });
    try {
      await waitFor(() => getByTestId("sidebar-session-sub-wb-1"));
      fireEvent.contextMenu(getByTestId("sidebar-session-sub-wb-1"));
      await waitFor(() => {
        expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
          kind: "conversation",
          commands: ["conversation.open"],
        }));
      });
      act(() => emitNativeContextCommand("conversation.open"));
      expect(onOpenWorkBoardItem).toHaveBeenCalledWith(7);
      expect(onLoadSession).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
