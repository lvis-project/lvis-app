import { describe, expect, it, vi } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import {
  makeConversationLoopDeps,
  makeConversationLoopMemoryManager,
} from "./conversation-loop-test-helpers.js";
import type { ConversationLoopDeps } from "../conversation-loop.js";

function makeProjectLoop(defaultRoot: string) {
  const setProjectContext = vi.fn();
  const systemPromptBuilder = {
    build: () => "system",
    setProjectContext,
  } as unknown as ConversationLoopDeps["systemPromptBuilder"];
  const loop = new ConversationLoop(makeConversationLoopDeps({
    systemPromptBuilder,
    isDefaultProjectRoot: (projectRoot) => projectRoot === defaultRoot,
  }));
  return { loop, setProjectContext };
}

function makeRevocableProjectLoop(defaultRoot: string, authorizedRoots: Set<string>) {
  const setProjectContext = vi.fn();
  const broadcastPermissionConfigChanged = vi.fn();
  const systemPromptBuilder = {
    build: () => "system",
    setProjectContext,
  } as unknown as ConversationLoopDeps["systemPromptBuilder"];
  const loop = new ConversationLoop(makeConversationLoopDeps({
    systemPromptBuilder,
    broadcastPermissionConfigChanged,
    getDefaultProject: () => ({
      projectRoot: defaultRoot,
      projectName: "workspace",
      isDefault: true,
    }),
    isDefaultProjectRoot: (projectRoot) => projectRoot === defaultRoot,
    authorizeProject: (projectRoot, projectName) => {
      if (projectRoot === defaultRoot) {
        return { projectRoot, projectName: projectName ?? "workspace", isDefault: true };
      }
      return authorizedRoots.has(projectRoot)
        ? { projectRoot, projectName: projectName ?? "project", isDefault: false }
        : null;
    },
  }));
  return { loop, broadcastPermissionConfigChanged };
}

describe("ConversationLoop project identity", () => {
  it("treats the app-managed workspace root as the default project without persisting a scope flag", () => {
    const defaultRoot = "C:\\Users\\ikcha\\.lvis\\workspace";
    const { loop, setProjectContext } = makeProjectLoop(defaultRoot);

    loop.newConversation("main", {
      projectRoot: defaultRoot,
      projectName: "workspace",
    });

    expect(setProjectContext).toHaveBeenLastCalledWith({
      projectRoot: defaultRoot,
      projectName: "workspace",
      isDefault: true,
    });
    expect(loop.getSessionProjectContext()).toEqual({
      projectRoot: defaultRoot,
      projectName: "workspace",
    });
    expect(loop.getSessionMemoryProjectContext()).toEqual({
      projectRoot: defaultRoot,
      projectName: "workspace",
      includeUnscoped: true,
    });
    // getSessionProjectIsDefault() is the UI-facing signal (chat.new domain
    // handler, markMainActiveAfterTurn) that a session's project binding is
    // the ambient default rather than an explicit selection — 2026-07
    // "remove Current Project labeling".
    expect(loop.getSessionProjectIsDefault()).toBe(true);
    expect(loop.getSessionExecutionCwd()).toBe(defaultRoot);
  });

  it("does not include legacy unscoped memory for explicit non-default projects", () => {
    const defaultRoot = "C:\\Users\\ikcha\\.lvis\\workspace";
    const { loop, setProjectContext } = makeProjectLoop(defaultRoot);

    loop.newConversation("main", {
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });

    expect(setProjectContext).toHaveBeenLastCalledWith({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(loop.getSessionMemoryProjectContext()).toEqual({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(loop.getSessionProjectIsDefault()).toBe(false);
    expect(loop.getSessionExecutionCwd()).toBe("C:\\workspace\\alpha");
  });

  it("rebinds a resumed session without project metadata to the default workspace", () => {
    const defaultRoot = "C:\\Users\\ikcha\\.lvis\\workspace";
    const memoryManager = makeConversationLoopMemoryManager([
      { role: "user", content: "hello" },
    ], "unscoped-session");
    vi.mocked(memoryManager.loadSessionMetadata).mockReturnValue({
      sessionKind: "main",
    } as ReturnType<typeof memoryManager.loadSessionMetadata>);
    const loop = new ConversationLoop(makeConversationLoopDeps({
      memoryManager,
      getDefaultProject: () => ({
        projectRoot: defaultRoot,
        projectName: "workspace",
        isDefault: true,
      }),
      isDefaultProjectRoot: (projectRoot) => projectRoot === defaultRoot,
    }));

    expect(loop.loadSession("unscoped-session")).toBe(true);
    expect(loop.getSessionExecutionCwd()).toBe(defaultRoot);
    expect(loop.getTurnAdditionalDirectories()).toContain(defaultRoot);
  });

  it("re-authorizes stored project roots on session resume before granting tool directories", () => {
    const defaultRoot = "C:\\Users\\ikcha\\.lvis\\workspace";
    const deniedRoot = "C:\\private\\denied";
    const setProjectContext = vi.fn();
    const systemPromptBuilder = {
      build: () => "system",
      setProjectContext,
    } as unknown as ConversationLoopDeps["systemPromptBuilder"];
    const memoryManager = makeConversationLoopMemoryManager([
      { role: "user", content: "hello" },
    ], "stored-session");
    vi.mocked(memoryManager.loadSessionMetadata).mockReturnValue({
      sessionKind: "main",
      projectRoot: deniedRoot,
      projectName: "denied",
    } as ReturnType<typeof memoryManager.loadSessionMetadata>);
    const loop = new ConversationLoop(makeConversationLoopDeps({
      memoryManager,
      systemPromptBuilder,
      isDefaultProjectRoot: (projectRoot) => projectRoot === defaultRoot,
      getDefaultProject: () => ({
        projectRoot: defaultRoot,
        projectName: "workspace",
        isDefault: true,
      }),
      authorizeProject: (projectRoot, projectName) =>
        projectRoot === defaultRoot
          ? {
              projectRoot: defaultRoot,
              projectName: projectName ?? "workspace",
              isDefault: true,
            }
          : null,
    }));

    expect(loop.loadSession("stored-session")).toBe(true);
    expect(loop.getSessionProjectContext()).toEqual({
      projectRoot: defaultRoot,
      projectName: "workspace",
    });
    expect(loop.getTurnAdditionalDirectories()).toContain(defaultRoot);
    expect(loop.getTurnAdditionalDirectories()).not.toContain(deniedRoot);
    expect(setProjectContext).toHaveBeenLastCalledWith({
      projectRoot: defaultRoot,
      projectName: "workspace",
      isDefault: true,
    });
  });

  it("revokes removed-root directories and rebinds the active project to default", () => {
    const defaultRoot = "C:\\Users\\ikcha\\.lvis\\workspace";
    const removedRoot = "C:\\workspace\\alpha";
    const authorizedRoots = new Set([removedRoot]);
    const { loop, broadcastPermissionConfigChanged } = makeRevocableProjectLoop(
      defaultRoot,
      authorizedRoots,
    );
    loop.newConversation("main", { projectRoot: removedRoot, projectName: "alpha" });
    loop.addSessionAdditionalDirectory(`${removedRoot}\\docs`);
    loop.addSessionAdditionalDirectory("D:\\shared");
    loop.addTurnAdditionalDirectory(`${removedRoot}\\scratch`);
    loop.addTurnAdditionalDirectory("D:\\turn");
    authorizedRoots.delete(removedRoot);
    broadcastPermissionConfigChanged.mockClear();

    const result = loop.revokeWorkspaceRoot(removedRoot);

    expect(result.projectRebound).toBe(true);
    expect(loop.getSessionExecutionCwd()).toBe(defaultRoot);
    expect(loop.getTurnAdditionalDirectories()).toEqual(
      expect.arrayContaining([defaultRoot, "D:\\shared", "D:\\turn"]),
    );
    expect(loop.getTurnAdditionalDirectories().some((path) => path.startsWith(removedRoot))).toBe(false);
    expect(broadcastPermissionConfigChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps an independently authorized child project when its former parent is removed", () => {
    const defaultRoot = "C:\\Users\\ikcha\\.lvis\\workspace";
    const parentRoot = "C:\\workspace";
    const childRoot = `${parentRoot}\\child`;
    const { loop } = makeRevocableProjectLoop(defaultRoot, new Set([childRoot]));
    loop.newConversation("main", { projectRoot: childRoot, projectName: "child" });
    loop.addSessionAdditionalDirectory(`${childRoot}\\session-scope`);
    loop.addTurnAdditionalDirectory(`${childRoot}\\turn-scope`);
    const controller = new AbortController();
    loop.currentAbortController = controller;

    const result = loop.revokeWorkspaceRoot(parentRoot, { preserveRoots: [childRoot] });

    expect(result.projectRebound).toBe(false);
    expect(loop.getSessionExecutionCwd()).toBe(childRoot);
    expect(loop.getTurnAdditionalDirectories()).toContain(childRoot);
    expect(loop.getTurnAdditionalDirectories()).toContain(`${childRoot}\\session-scope`);
    expect(loop.getTurnAdditionalDirectories()).toContain(`${childRoot}\\turn-scope`);
    expect(controller.signal.aborted).toBe(false);
  });

  it("does not revoke a segment-prefix sibling", () => {
    const defaultRoot = "C:\\Users\\ikcha\\.lvis\\workspace";
    const removedRoot = "C:\\workspace\\app";
    const siblingRoot = "C:\\workspace\\app-old";
    const { loop } = makeRevocableProjectLoop(defaultRoot, new Set([siblingRoot]));
    loop.newConversation("main", { projectRoot: siblingRoot, projectName: "app-old" });

    const result = loop.revokeWorkspaceRoot(removedRoot);

    expect(result).toEqual({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    });
    expect(loop.getSessionExecutionCwd()).toBe(siblingRoot);
  });

  it("aborts an affected active turn with the workspace-removal reason", () => {
    const defaultRoot = "C:\\Users\\ikcha\\.lvis\\workspace";
    const removedRoot = "C:\\workspace\\alpha";
    const authorizedRoots = new Set([removedRoot]);
    const { loop } = makeRevocableProjectLoop(defaultRoot, authorizedRoots);
    loop.newConversation("main", { projectRoot: removedRoot, projectName: "alpha" });
    const controller = new AbortController();
    loop.currentAbortController = controller;
    authorizedRoots.delete(removedRoot);

    loop.revokeWorkspaceRoot(removedRoot);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(Error);
    expect((controller.signal.reason as Error).message).toBe("workspace-removal");
  });

  it("does not abort an unrelated active turn", () => {
    const defaultRoot = "C:\\Users\\ikcha\\.lvis\\workspace";
    const removedRoot = "C:\\workspace\\alpha";
    const unrelatedRoot = "D:\\workspace\\beta";
    const { loop } = makeRevocableProjectLoop(defaultRoot, new Set([unrelatedRoot]));
    loop.newConversation("main", { projectRoot: unrelatedRoot, projectName: "beta" });
    const controller = new AbortController();
    loop.currentAbortController = controller;

    loop.revokeWorkspaceRoot(removedRoot);

    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts an unrelated project turn when the removed root was in global scope", () => {
    const defaultRoot = "C:\\Users\\ikcha\\.lvis\\workspace";
    const removedRoot = "C:\\workspace\\alpha";
    const unrelatedRoot = "D:\\workspace\\beta";
    const { loop } = makeRevocableProjectLoop(defaultRoot, new Set([unrelatedRoot]));
    loop.newConversation("main", { projectRoot: unrelatedRoot, projectName: "beta" });
    const controller = new AbortController();
    loop.currentAbortController = controller;

    // The settings list has already shrunk, so the caller carries the
    // pre-persist global-scope snapshot explicitly.
    loop.revokeWorkspaceRoot(removedRoot, { globalScopeWasAuthorized: true });

    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe("workspace-removal");
  });
});
