/**
 * RoutineEngine.runRoutine — unit tests.
 */
import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { RoutineEngine } from "../routine-engine.js";

function makeLoop(opts: { text?: string; throws?: boolean } = {}) {
  return {
    getSessionId: vi.fn(() => "test-session-id"),
    startRoutineConversation: vi.fn(async () => "test-session-id"),
    runTurn: vi.fn(async () => {
      if (opts.throws) throw new Error("loop crashed");
      return { text: opts.text ?? "루틴 완료 메시지", toolCalls: [], route: "llm" };
    }),
    cleanupSession: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("RoutineEngine.runRoutine", () => {
  it("returns RoutineResult with correct routineId, trigger, and generatedAt", async () => {
    const loop = makeLoop({ text: "완료" });
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({
      id: "schedule-daily",
      trigger: "schedule",
      prePrompt: "오늘 하루 알려줘.",
    });

    expect(result.routineId).toBe("schedule-daily");
    expect(result.trigger).toBe("schedule");
    expect(typeof result.generatedAt).toBe("string");
    expect(result.sessionId).toBe("test-session-id");
    expect(loop.startRoutineConversation).toHaveBeenCalledWith(
      "schedule-daily",
      "schedule-daily",
      expect.any(String),
    );
    expect(loop.runTurn).toHaveBeenCalledWith(
      "오늘 하루 알려줘.",
      undefined,
      undefined,
      { inputOrigin: "routine" },
    );
  });

  it("uses <summary> tag content as summary", async () => {
    const loop = makeLoop({ text: "본문\n<summary>오늘 할 일 요약 텍스트</summary>" });
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({
      id: "shutdown",
      trigger: "shutdown",
      prePrompt: "정리해줘",
    });

    expect(result.summary).toBe("오늘 할 일 요약 텍스트");
  });

  it("returns missing-tag marker when runTurn returns no <summary> tag", async () => {
    const loop = {
      getSessionId: vi.fn(() => "test-session-id"),
      startRoutineConversation: vi.fn(async () => "test-session-id"),
      runTurn: vi.fn(async () => ({ text: "", toolCalls: [], route: "llm" })),
      cleanupSession: vi.fn(),
      dispose: vi.fn(),
    };
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({ id: "schedule", trigger: "schedule", prePrompt: "" });

    expect(result.summary).toBe("[요약 형식 누락]");
  });

  it("captures error message as summary when runTurn throws", async () => {
    const loop = makeLoop({ throws: true });
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });

    const result = await engine.runRoutine({ id: "shutdown-daily", trigger: "shutdown", prePrompt: "" });

    expect(result.summary).toContain("loop crashed");
  });
});

describe("RoutineEngine workspace lifecycle", () => {
  it("filters a revoked root and its children from future fires until an allow", async () => {
    const inputs: Array<{ scope?: { directories: string[] } }> = [];
    const engine = new RoutineEngine({
      createConversationLoop: (input) => {
        inputs.push(input);
        return makeLoop({ text: "<summary>done</summary>" }) as any;
      },
    });
    const removedRoot = resolve("routine-removed-root");
    const child = resolve(removedRoot, "child");
    const otherChild = resolve(removedRoot, "other-child");
    const segmentSibling = `${removedRoot}-sibling`;
    engine.revokeWorkspaceRoot(removedRoot);

    await engine.runRoutine({
      id: "filtered",
      trigger: "schedule",
      prePrompt: "run",
      scope: {
        pluginIds: { mode: "deny-all" },
        forcedPluginIds: [],
        directories: [removedRoot, child, segmentSibling],
      },
    });
    expect(inputs[0]?.scope?.directories).toEqual([segmentSibling]);

    engine.allowWorkspaceRoot(child);
    await engine.runRoutine({
      id: "child-readded",
      trigger: "schedule",
      prePrompt: "run",
      scope: {
        pluginIds: { mode: "deny-all" },
        forcedPluginIds: [],
        directories: [child, otherChild],
      },
    });
    expect(inputs[1]?.scope?.directories).toEqual([child]);
  });

  it("keeps a separately registered child authorized after its parent is revoked", async () => {
    const inputs: Array<{ scope?: { directories: string[] } }> = [];
    const engine = new RoutineEngine({
      createConversationLoop: (input) => {
        inputs.push(input);
        return makeLoop({ text: "<summary>done</summary>" }) as any;
      },
    });
    const parentRoot = resolve("routine-parent-root");
    const preservedChild = resolve(parentRoot, "child");
    const childDeep = resolve(preservedChild, "src");
    const parentOnly = resolve(parentRoot, "parent-only");
    const childPrefixSibling = resolve(parentRoot, "child-old");
    engine.revokeWorkspaceRoot(parentRoot, {
      preserveRoots: [preservedChild, resolve("unrelated-root")],
    });

    await engine.runRoutine({
      id: "nested-preserved",
      trigger: "schedule",
      prePrompt: "run",
      scope: {
        pluginIds: { mode: "deny-all" },
        forcedPluginIds: [],
        directories: [
          parentRoot,
          parentOnly,
          preservedChild,
          childDeep,
          childPrefixSibling,
        ],
      },
    });
    expect(inputs[0]?.scope?.directories).toEqual([
      preservedChild,
      childDeep,
    ]);

    engine.revokeWorkspaceRoot(preservedChild);
    await engine.runRoutine({
      id: "nested-later-removed",
      trigger: "schedule",
      prePrompt: "run",
      scope: {
        pluginIds: { mode: "deny-all" },
        forcedPluginIds: [],
        directories: [preservedChild, childDeep],
      },
    });
    expect(inputs[1]?.scope?.directories).toEqual([]);
  });

  it("revokes an active loop and stops visiting it after completion", async () => {
    let releaseTurn: ((value: { text: string; toolCalls: never[]; route: string }) => void) | undefined;
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 1,
      turnDirectoriesRemoved: 2,
      projectRebound: true,
    }));
    const loop = {
      ...makeLoop(),
      revokeWorkspaceRoot,
      runTurn: vi.fn(() => new Promise<{
        text: string;
        toolCalls: never[];
        route: string;
      }>((resolveTurn) => {
        releaseTurn = resolveTurn;
      })),
    };
    const engine = new RoutineEngine({ createConversationLoop: () => loop as any });
    const pending = engine.runRoutine({
      id: "active",
      trigger: "schedule",
      prePrompt: "run",
    });
    await vi.waitFor(() => expect(loop.runTurn).toHaveBeenCalledTimes(1));

    expect(engine.revokeWorkspaceRoot(resolve("routine-active-root"), {
      preserveRoots: [resolve("routine-active-root", "child")],
      globalScopeWasAuthorized: true,
    })).toEqual({
      activeLoopsVisited: 1,
      liveScopesRevoked: 3,
    });
    expect(revokeWorkspaceRoot).toHaveBeenCalledTimes(1);
    expect(revokeWorkspaceRoot).toHaveBeenCalledWith(expect.any(String), {
      preserveRoots: [expect.any(String)],
      globalScopeWasAuthorized: true,
    });

    releaseTurn?.({ text: "<summary>done</summary>", toolCalls: [], route: "llm" });
    await pending;
    expect(engine.revokeWorkspaceRoot(resolve("routine-active-root"))).toEqual({
      activeLoopsVisited: 0,
      liveScopesRevoked: 0,
    });
    expect(revokeWorkspaceRoot).toHaveBeenCalledTimes(1);
  });

  it("attempts every active loop before surfacing aggregate revoke failures", () => {
    const first = vi.fn(() => ({
      sessionDirectoriesRemoved: 1,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const failing = vi.fn(() => {
      throw new Error("routine child revoke failed");
    });
    const last = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 1,
      projectRebound: false,
    }));
    const engine = new RoutineEngine({} as never);
    const activeLoops = (engine as unknown as {
      activeLoops: Set<{ revokeWorkspaceRoot: ReturnType<typeof vi.fn> }>;
    }).activeLoops;
    activeLoops.add({ revokeWorkspaceRoot: first });
    activeLoops.add({ revokeWorkspaceRoot: failing });
    activeLoops.add({ revokeWorkspaceRoot: last });

    let thrown: unknown;
    try {
      engine.revokeWorkspaceRoot(resolve("routine-failing-root"));
    } catch (error: unknown) {
      thrown = error;
    }

    expect(first).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown).toMatchObject({ code: "ROUTINE_WORKSPACE_ROOT_REVOKE_FAILED" });
    expect((thrown as AggregateError).errors).toHaveLength(1);
  });
});
