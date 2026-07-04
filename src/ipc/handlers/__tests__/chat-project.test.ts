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
