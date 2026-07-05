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
    expect(resolveChatNewProjectPayload(undefined, "C:\\Users\\ikcha\\workspace")).toEqual({
      projectRoot: "C:\\Users\\ikcha\\workspace",
      projectName: "default",
    });
    expect(resolveChatNewProjectPayload({ projectRoot: "  " }, "C:\\Users\\ikcha\\workspace")).toEqual({
      projectRoot: "C:\\Users\\ikcha\\workspace",
      projectName: "default",
    });
    expect(resolveChatNewProjectPayload({ projectName: "loose-name" }, "C:\\Users\\ikcha\\workspace")).toEqual({
      projectRoot: "C:\\Users\\ikcha\\workspace",
      projectName: "default",
    });
  });

  it("does not override an explicit project selection", () => {
    expect(resolveChatNewProjectPayload({
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
    }, "C:\\Users\\ikcha\\workspace")).toEqual({
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
          projectRoot: "C:\\Users\\ikcha\\.lvis\\workspace",
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

describe("handleChatSessions project filters", () => {
  it("does not add a project filter when the caller requests the project sidebar list", () => {
    const listSessionsPage = vi.fn(() => []);
    const deps = {
      conversationLoop: {
        getSessionId: () => "session-1",
      },
      memoryManager: {
        listSessionsPage,
      },
    } as unknown as IpcDeps;

    expect(handleChatSessions(deps, { kind: "main" })).toEqual({
      current: "session-1",
      sessions: [],
    });
    expect(listSessionsPage.mock.calls[0]?.[0]).not.toHaveProperty("projectRoot");
  });

  it("does not let an arbitrary renderer projectRoot widen the session scope", () => {
    const listSessionsPage = vi.fn(() => []);
    const deps = {
      conversationLoop: {
        getSessionId: () => "session-1",
      },
      memoryManager: {
        listSessionsPage,
      },
    } as unknown as IpcDeps;

    handleChatSessions(deps, { kind: "main", projectRoot: "C:\\unapproved\\project" });

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
  const DEFAULT_ROOT = "C:\\Users\\ikcha\\.lvis\\workspace";

  it("strips projectRoot/projectName from a legacy session tagged with the default workspace root", () => {
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

      const result = handleChatSessions(deps, { kind: "main" });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).not.toHaveProperty("projectRoot");
      expect(result.sessions[0]).not.toHaveProperty("projectName");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("keeps projectRoot/projectName for a session scoped to an explicit (non-default) project", () => {
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

      const result = handleChatSessions(deps, { kind: "main" });

      expect(result.sessions[0]).toMatchObject({
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
