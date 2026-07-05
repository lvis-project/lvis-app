// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { Sidebar } from "../Sidebar.js";
import type { SessionSummary } from "../../hooks/use-sessions.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import type { SidebarTab } from "../../hooks/use-sidebar-tab.js";

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
      projectRoot: "C:\\Users\\ikcha\\workspace\\lvis-project\\other-app",
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
    isCurrentSessionStarred: false,
    onToggleCurrentSessionStar: vi.fn(),
    onExport: vi.fn(),
    sessions,
    currentSessionId: "sess-1",
    onLoadSession,
    onNewChatForProject,
    ...overrides,
  };

  const previous = (window as unknown as { lvis?: unknown }).lvis;
  (window as unknown as { lvis?: unknown }).lvis = {
    ...(previous && typeof previous === "object" ? previous : {}),
    workspace: {
      listRoots: vi.fn(async () => ({
        ok: true,
        defaultRoot: "C:\\Users\\ikcha\\workspace\\lvis-project\\lvis-app",
        roots: [
          { path: "C:\\Users\\ikcha\\workspace\\lvis-project\\lvis-app", isDefault: true },
          { path: "C:\\Users\\ikcha\\workspace\\lvis-project\\other-app", isDefault: false },
        ],
      })),
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
        expect(getByTestId("sidebar-project-C-Users-ikcha-workspace-lvis-project-other-app").textContent).toContain("other-app");
      });
      expect(getByText("다른 프로젝트 대화")).toBeTruthy();
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
        expect(getByTestId("sidebar-project-C-Users-ikcha-workspace-lvis-project-other-app").textContent).toContain("other-app");
      });
      fireEvent.click(getByTestId("sidebar-project-C-Users-ikcha-workspace-lvis-project-other-app"));
      expect(onNewChatForProject).toHaveBeenCalledWith({
        projectRoot: "C:\\Users\\ikcha\\workspace\\lvis-project\\other-app",
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
    const DEFAULT_ROOT = "C:\\Users\\ikcha\\workspace\\lvis-project\\lvis-app";
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
      // substring — "C:\Users\ikcha\workspace\..." — so the precise
      // ghost-group testid is asserted directly instead.)
      activateTab(getByTestId("sidebar-tab-projects"));
      await waitFor(() => expect(getByTestId("sidebar-project-C-Users-ikcha-workspace-lvis-project-other-app")).toBeTruthy());
      expect(queryByTestId("sidebar-project-C-Users-ikcha-workspace-lvis-project-lvis-app")).toBeNull();
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
        .filter((el) => !el.getAttribute("data-testid")?.includes("-pin-"));
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
        .filter((el) => !el.getAttribute("data-testid")?.includes("-pin-"));
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
            isCurrentSessionStarred={false}
            onToggleCurrentSessionStar={vi.fn()}
            onExport={vi.fn()}
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
        .filter((el) => !el.getAttribute("data-testid")?.includes("-pin-"));
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
    { projectRoot: "C:\\Users\\ikcha\\workspace\\lvis-project\\alpha", projectName: "alpha", isDefault: false },
    { projectRoot: "C:\\Users\\ikcha\\workspace\\lvis-project\\beta", projectName: "beta", isDefault: false },
  ];

  it("shows a pin/unpin context menu item and calls onToggleProjectPin with the project root", async () => {
    const onToggleProjectPin = vi.fn();
    const { getByTestId, restore } = renderSidebar({
      sessions: [],
      projects,
      activeSidebarTab: "projects",
      isProjectPinned: () => false,
      onToggleProjectPin,
    });
    try {
      const projectRow = await waitFor(() => getByTestId("sidebar-project-C-Users-ikcha-workspace-lvis-project-alpha"));
      fireEvent.contextMenu(projectRow);
      const pinItem = await screen.findByTestId("sidebar-project-menu-pin");
      fireEvent.click(pinItem);
      expect(onToggleProjectPin).toHaveBeenCalledWith("C:\\Users\\ikcha\\workspace\\lvis-project\\alpha");
    } finally {
      restore();
    }
  });

  it("sorts a pinned project to the top of the Projects tab", async () => {
    const { getByTestId, restore } = renderSidebar({
      sessions: [],
      projects,
      activeSidebarTab: "projects",
      isProjectPinned: (root) => root === "C:\\Users\\ikcha\\workspace\\lvis-project\\beta",
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
        "sidebar-project-C-Users-ikcha-workspace-lvis-project-beta",
        "sidebar-project-C-Users-ikcha-workspace-lvis-project-alpha",
      ]);
    } finally {
      restore();
    }
  });
});
