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
});
