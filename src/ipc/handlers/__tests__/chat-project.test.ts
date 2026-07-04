import { describe, expect, it, vi } from "vitest";
import type { IpcDeps } from "../../types.js";
import {
  defaultWorkspaceProjectPayload,
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

  it("defaults unscoped new chats to the workspace project", () => {
    expect(resolveChatNewProjectPayload(undefined, "C:\\Users\\ikcha\\workspace")).toEqual({
      projectRoot: "C:\\Users\\ikcha\\workspace",
      projectName: "workspace",
    });
    expect(resolveChatNewProjectPayload({ projectRoot: "  " }, "C:\\Users\\ikcha\\workspace")).toEqual({
      projectRoot: "C:\\Users\\ikcha\\workspace",
      projectName: "workspace",
    });
    expect(resolveChatNewProjectPayload({ projectName: "loose-name" }, "C:\\Users\\ikcha\\workspace")).toEqual({
      projectRoot: "C:\\Users\\ikcha\\workspace",
      projectName: "workspace",
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

  it("derives a stable fallback project name when cwd has no basename", () => {
    expect(defaultWorkspaceProjectPayload("")).toEqual({
      projectName: "workspace",
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
