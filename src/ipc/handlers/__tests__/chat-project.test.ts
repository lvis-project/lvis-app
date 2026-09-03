import { describe, expect, it, vi } from "vitest";
import type { IpcDeps } from "../../types.js";
import {
  defaultWorkspaceProjectPayload,
  handleChatSessions,
  markMainActiveAfterTurn,
  parseChatSessionProjectPayload,
  resolveChatNewProjectPayload,
} from "../chat.js";

describe("chat project payloads", () => {
  it("keeps project identity as projectRoot/projectName only", () => {
    expect(parseChatSessionProjectPayload({
      projectScope: "none",
      projectRoot: "  C:\\workspace\\alpha  ",
      projectName: "  alpha  ",
    })).toEqual({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(parseChatSessionProjectPayload({ projectScope: "none" })).toEqual({});
  });

  it("defaults unscoped new chats to the default project", () => {
    expect(resolveChatNewProjectPayload(undefined, "C:\\Users\\example\\workspace")).toEqual({
      projectRoot: "C:\\Users\\example\\workspace",
      projectName: "default",
    });
    expect(resolveChatNewProjectPayload({ projectRoot: "  " }, "C:\\Users\\example\\workspace")).toEqual({
      projectRoot: "C:\\Users\\example\\workspace",
      projectName: "default",
    });
    expect(resolveChatNewProjectPayload({ projectName: "loose-name" }, "C:\\Users\\example\\workspace")).toEqual({
      projectRoot: "C:\\Users\\example\\workspace",
      projectName: "default",
    });
  });

  it("does not override an explicit project selection", () => {
    expect(resolveChatNewProjectPayload({
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
    }, "C:\\Users\\example\\workspace")).toEqual({
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
    });
  });

  it("labels the default project with the stable 'default' literal", () => {
    expect(defaultWorkspaceProjectPayload("")).toEqual({
      projectName: "default",
    });
  });
});

describe("markMainActiveAfterTurn across chat tiles", () => {
  it("moves the resume target for the primary tile only", async () => {
    const markMainActiveResume = vi.fn(async () => {});
    const base = {
      conversationLoop: {
        getSessionKind: () => "main",
        getHistory: () => [{ role: "user", content: "hello" }],
        getSessionId: () => "session-tile",
        getSessionProjectIsDefault: () => true,
        getSessionProjectContext: () => null,
      },
      memoryManager: {
        loadSessionMetadata: vi.fn(() => ({})),
        saveSessionMetadata: vi.fn(async () => {}),
        markMainActiveResume,
        markMainActiveFresh: vi.fn(async () => {}),
      },
    };
    await markMainActiveAfterTurn({ ...base, chatGroupId: "group-2" } as unknown as IpcDeps, "hello");
    expect(markMainActiveResume).not.toHaveBeenCalled();
    await markMainActiveAfterTurn({ ...base, chatGroupId: "main" } as unknown as IpcDeps, "hello");
    await markMainActiveAfterTurn(base as unknown as IpcDeps, "hello");
    expect(markMainActiveResume).toHaveBeenCalledTimes(2);
  });
});

describe("markMainActiveAfterTurn project metadata", () => {
  it("persists the current main session project identity without a no-project scope", async () => {
    const saveSessionMetadata = vi.fn(async () => {});
    const markMainActiveResume = vi.fn(async () => {});
    const deps = {
      conversationLoop: {
        getSessionKind: () => "main",
        getHistory: () => [{ role: "user", content: "hello" }],
        getSessionId: () => "session-1",
        getSessionProjectIsDefault: () => false,
        getSessionProjectContext: () => ({
          projectRoot: "C:\\workspace\\alpha",
          projectName: "alpha",
        }),
      },
      memoryManager: {
        loadSessionMetadata: vi.fn(() => ({ title: "Existing title" })),
        saveSessionMetadata,
        markMainActiveResume,
        markMainActiveFresh: vi.fn(async () => {}),
      },
    } as unknown as IpcDeps;

    await markMainActiveAfterTurn(deps, "hello");

    expect(saveSessionMetadata).toHaveBeenCalledWith("session-1", {
      title: "Existing title",
      sessionKind: "main",
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(saveSessionMetadata.mock.calls[0]?.[1]).not.toHaveProperty("projectScope");
    expect(markMainActiveResume).toHaveBeenCalledWith("session-1");
  });

  it("does NOT persist project metadata when the session's project is the default binding (no explicit selection)", async () => {
    // 2026-07 "remove Current Project labeling": a "no explicit project"
    // session must keep null project fields in metadata even after a turn
    // completes — getSessionProjectIsDefault() is the signal that
    // distinguishes "just running against the ambient default directory"
    // from "user explicitly picked this project".
    const saveSessionMetadata = vi.fn(async () => {});
    const markMainActiveResume = vi.fn(async () => {});
    const deps = {
      conversationLoop: {
        getSessionKind: () => "main",
        getHistory: () => [{ role: "user", content: "hello" }],
        getSessionId: () => "session-1",
        getSessionProjectIsDefault: () => true,
        getSessionProjectContext: () => ({
          projectRoot: "C:\\Users\\example\\.lvis\\workspace",
          projectName: "default",
        }),
      },
      memoryManager: {
        loadSessionMetadata: vi.fn(() => null),
        saveSessionMetadata,
        markMainActiveResume,
        markMainActiveFresh: vi.fn(async () => {}),
      },
    } as unknown as IpcDeps;

    await markMainActiveAfterTurn(deps, "hello");

    expect(saveSessionMetadata).not.toHaveBeenCalled();
    expect(markMainActiveResume).toHaveBeenCalledWith("session-1");
  });

  it("still persists project metadata for an explicit (non-default) project after a turn", async () => {
    const saveSessionMetadata = vi.fn(async () => {});
    const markMainActiveResume = vi.fn(async () => {});
    const deps = {
      conversationLoop: {
        getSessionKind: () => "main",
        getHistory: () => [{ role: "user", content: "hello" }],
        getSessionId: () => "session-1",
        getSessionProjectIsDefault: () => false,
        getSessionProjectContext: () => ({
          projectRoot: "C:\\workspace\\alpha",
          projectName: "alpha",
        }),
      },
      memoryManager: {
        loadSessionMetadata: vi.fn(() => null),
        saveSessionMetadata,
        markMainActiveResume,
        markMainActiveFresh: vi.fn(async () => {}),
      },
    } as unknown as IpcDeps;

    await markMainActiveAfterTurn(deps, "hello");

    expect(saveSessionMetadata).toHaveBeenCalledWith("session-1", {
      sessionKind: "main",
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(markMainActiveResume).toHaveBeenCalledWith("session-1");
  });
});

describe("handleChatSessions row state", () => {
  it("carries the archived and unread marks the sidebar draws from", async () => {
    const listSessionsPage = vi.fn(() => [{
      id: "session-1",
      modifiedAt: new Date("2026-08-27T00:00:00Z"),
      title: "t",
      sessionKind: "main",
      archivedAt: "2026-08-27T01:00:00Z",
      unreadSince: "2026-08-27T02:00:00Z",
    }, {
      id: "session-2",
      modifiedAt: new Date("2026-08-27T00:00:00Z"),
      title: "u",
      sessionKind: "main",
    }]);
    const deps = {
      conversationLoop: { getSessionId: () => "session-1" },
      memoryManager: { listSessionsPage },
    } as unknown as IpcDeps;

    const { sessions } = await handleChatSessions(deps, { kind: "main" });
    expect(sessions[0]).toMatchObject({ id: "session-1", archivedAt: "2026-08-27T01:00:00Z", unreadSince: "2026-08-27T02:00:00Z" });
    expect(sessions[1]).not.toHaveProperty("archivedAt");
    expect(sessions[1]).not.toHaveProperty("unreadSince");
  });
});

describe("handleChatSessions project filters", () => {
  it("does not add a project filter when the caller requests the project sidebar list", async () => {
    const listSessionsPage = vi.fn(() => []);
    const deps = {
      conversationLoop: {
        getSessionId: () => "session-1",
      },
      memoryManager: {
        listSessionsPage,
      },
    } as unknown as IpcDeps;

    expect(await handleChatSessions(deps, { kind: "main" })).toEqual({
      current: "session-1",
      sessions: [],
    });
    expect(listSessionsPage.mock.calls[0]?.[0]).not.toHaveProperty("projectRoot");
  });

  it("does not let an arbitrary renderer projectRoot widen the session scope", async () => {
    const listSessionsPage = vi.fn(() => []);
    const deps = {
      conversationLoop: {
        getSessionId: () => "session-1",
      },
      memoryManager: {
        listSessionsPage,
      },
    } as unknown as IpcDeps;

    await handleChatSessions(deps, { kind: "main", projectRoot: "C:\\unapproved\\project" });

    expect(listSessionsPage.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: "__lvis_unauthorized_project_root__",
    });
  });
});

describe("handleChatSessions legacy default-root metadata scrub", () => {
  // Pre-PR, markMainActiveAfterTurn persisted projectRoot (= the default
  // workspace root)/projectName ("workspace") for EVERY session with no
  // isDefault guard. Sidebar.tsx's namedProjects excludes the default root
  // from the known-projects list, so a legacy session's default root falls
  // into the "unknown project" fallback and renders as a ghost named group
  // in both the sidebar and Insights (both read through this handler). The
  // fix scrubs at this one read chokepoint rather than patching every
  // reader — heals both consumers from a single source.
  const DEFAULT_ROOT = "C:\\Users\\example\\.lvis\\workspace";

  it("strips projectRoot/projectName from a legacy session tagged with the default workspace root", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(DEFAULT_ROOT);
    try {
      const listSessionsPage = vi.fn(() => [{
        id: "legacy-session",
        modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        title: "Legacy chat",
        sessionKind: "main" as const,
        projectRoot: DEFAULT_ROOT,
        projectName: "workspace",
      }]);
      const deps = {
        conversationLoop: { getSessionId: () => "legacy-session" },
        memoryManager: { listSessionsPage },
      } as unknown as IpcDeps;

      const result = await handleChatSessions(deps, { kind: "main" });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).not.toHaveProperty("projectRoot");
      expect(result.sessions[0]).not.toHaveProperty("projectName");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("keeps projectRoot/projectName for a session scoped to an explicit (non-default) project", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(DEFAULT_ROOT);
    try {
      const listSessionsPage = vi.fn(() => [{
        id: "explicit-session",
        modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        title: "Explicit chat",
        sessionKind: "main" as const,
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
      }]);
      const deps = {
        conversationLoop: { getSessionId: () => "explicit-session" },
        memoryManager: { listSessionsPage },
      } as unknown as IpcDeps;

      const result = await handleChatSessions(deps, { kind: "main" });

      expect(result.sessions[0]).toMatchObject({
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

describe("handleChatSessions work-board runs", () => {
  const main = {
    id: "session-main",
    modifiedAt: new Date("2026-09-03T10:00:00Z"),
    title: "main chat",
    sessionKind: "main",
  };
  const runs = [
    { id: "sub-a1", modifiedAt: new Date("2026-09-03T11:00:00Z"), title: "Execute: 월간 보고서", sessionKind: "subagent", workBoardItemId: 7 },
    { id: "sub-a0", modifiedAt: new Date("2026-09-03T09:00:00Z"), title: "Plan: 월간 보고서", sessionKind: "subagent", workBoardItemId: 7 },
    { id: "sub-gone", modifiedAt: new Date("2026-09-03T08:00:00Z"), title: "Execute: deleted", sessionKind: "subagent", workBoardItemId: 9 },
  ];
  const makeDeps = () => {
    const listWorkBoardRunSessions = vi.fn(() => runs);
    const get = vi.fn(async (id: number) => id === 7
      ? { status: "found" as const, itemId: 7, item: { id: 7, title: "월간 보고서 초안", projectRoot: "C:\\ws\\alpha", projectName: "alpha" } }
      : { status: "not_found" as const, itemId: id });
    const deps = {
      conversationLoop: { getSessionId: () => "session-main" },
      memoryManager: { listSessionsPage: vi.fn(() => [main]) },
      getSubAgentRunner: () => ({ listWorkBoardRunSessions }),
      workBoardStore: { get },
    } as unknown as IpcDeps;
    return { deps, listWorkBoardRunSessions, get };
  };

  it("lists one row per item, titled by the item, merged by time with the main sessions", async () => {
    const { deps, listWorkBoardRunSessions } = makeDeps();
    const { sessions } = await handleChatSessions(deps, { kind: "main", includeWorkBoardRuns: true });
    expect(listWorkBoardRunSessions).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    expect(sessions.map((s) => s.id)).toEqual(["sub-a1", "session-main"]);
    expect(sessions[0]).toMatchObject({
      id: "sub-a1",
      title: "월간 보고서 초안",
      sessionKind: "subagent",
      workBoardItemId: 7,
      projectRoot: "C:\\ws\\alpha",
      projectName: "alpha",
      modifiedAt: "2026-09-03T11:00:00.000Z",
    });
    // The plan child of the same item is folded into the newer row; the run
    // whose item is gone has nothing to open and is not listed.
    expect(sessions.some((s) => s.id === "sub-a0" || s.id === "sub-gone")).toBe(false);
  });

  it("leaves the list untouched, and the runner unasked, without the flag", async () => {
    const { deps, listWorkBoardRunSessions } = makeDeps();
    const { sessions } = await handleChatSessions(deps, { kind: "main" });
    expect(sessions.map((s) => s.id)).toEqual(["session-main"]);
    expect(listWorkBoardRunSessions).not.toHaveBeenCalled();
  });

  it("lists nothing extra when the runner or the board is not wired", async () => {
    const deps = {
      conversationLoop: { getSessionId: () => "session-main" },
      memoryManager: { listSessionsPage: vi.fn(() => [main]) },
    } as unknown as IpcDeps;
    const { sessions } = await handleChatSessions(deps, { kind: "main", includeWorkBoardRuns: true });
    expect(sessions.map((s) => s.id)).toEqual(["session-main"]);
  });
});
