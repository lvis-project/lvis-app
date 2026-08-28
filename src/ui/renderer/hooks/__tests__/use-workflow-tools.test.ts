import "../../../../../test/renderer/setup.js";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkflowTools } from "../use-workflow-tools.js";
import type { LvisApi } from "../../types.js";

describe("useWorkflowTools", () => {
  it("preserves suspension metadata when a done event transitions a spawn to waiting", () => {
    let onSpawn: Parameters<LvisApi["onAgentSpawnEvent"]>[0] | undefined;
    const api = {
      onAskUserQuestion: vi.fn(() => () => undefined),
      onAgentSpawnEvent: vi.fn((handler: Parameters<LvisApi["onAgentSpawnEvent"]>[0]) => {
        onSpawn = handler;
        return () => undefined;
      }),
      onSkillLoaded: vi.fn(() => () => undefined),
      onAskUserQuestionTimeout: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    const { result } = renderHook(() => useWorkflowTools(api));

    act(() => {
      onSpawn?.({
        spawnId: "spawn-waiting",
        type: "start",
        taskState: "TASK_STATE_SUBMITTED",
        title: "Budgeted agent",
      });
      onSpawn?.({
        spawnId: "spawn-waiting",
        type: "done",
        taskState: "TASK_STATE_INPUT_REQUIRED",
        status: "waiting",
        summary: "partial work",
        suspension: { reason: "budget", resumeId: "child-waiting" },
      });
    });

    expect(result.current.subAgentSpawns).toEqual([
      expect.objectContaining({
        spawnId: "spawn-waiting",
        status: "waiting",
        suspension: { reason: "budget", resumeId: "child-waiting" },
      }),
    ]);
  });

  it("a tile keeps only the sub-agent frames of the conversation it is showing", () => {
    let onSpawn: Parameters<LvisApi["onAgentSpawnEvent"]>[0] | undefined;
    const api = {
      onAskUserQuestion: vi.fn(() => () => undefined),
      onAgentSpawnEvent: vi.fn((handler: Parameters<LvisApi["onAgentSpawnEvent"]>[0]) => {
        onSpawn = handler;
        return () => undefined;
      }),
      onSkillLoaded: vi.fn(() => () => undefined),
      onAskUserQuestionTimeout: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    const ownsSession = (sessionId: string) => sessionId === "session-mine";
    const { result } = renderHook(() => useWorkflowTools(api, { ownsSession }));

    act(() => {
      onSpawn?.({ spawnId: "mine", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Mine", parentSessionId: "session-mine" });
      onSpawn?.({ spawnId: "theirs", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Theirs", parentSessionId: "session-other-tile" });
      // A frame that names no conversation is not another tile's — it is kept.
      onSpawn?.({ spawnId: "unaddressed", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Unaddressed" });
      // Later phases of another tile's agent are dropped too, not synthesized.
      onSpawn?.({ spawnId: "theirs", type: "done", taskState: "TASK_STATE_COMPLETED", status: "done", summary: "x", parentSessionId: "session-other-tile" });
    });

    expect(result.current.subAgentSpawns.map((s) => s.spawnId)).toEqual(["mine", "unaddressed"]);
  });

  it("a tile draws only the question cards of the conversations it owns", () => {
    let onAsk: Parameters<LvisApi["onAskUserQuestion"]>[0] | undefined;
    const api = {
      onAskUserQuestion: vi.fn((handler: Parameters<LvisApi["onAskUserQuestion"]>[0]) => {
        onAsk = handler;
        return () => undefined;
      }),
      onAgentSpawnEvent: vi.fn(() => () => undefined),
      onSkillLoaded: vi.fn(() => () => undefined),
      onAskUserQuestionTimeout: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    // A tile owns its own conversation AND the child sessions of the agents it
    // spawned — a question a sub-agent asks belongs to the tile that started it.
    const ownsSession = (sessionId: string) =>
      sessionId === "session-mine" || sessionId === "child-of-mine";
    const { result } = renderHook(() => useWorkflowTools(api, { ownsSession }));

    const ask = (id: string, sessionId: string) => ({
      id,
      sessionId,
      questions: [{ question: `${id}?`, choices: ["yes", "no"] }],
      createdAt: 0,
    });

    act(() => {
      onAsk?.(ask("mine", "session-mine"));
      onAsk?.(ask("child", "child-of-mine"));
      onAsk?.(ask("theirs", "session-other-tile"));
    });

    expect(result.current.askQuestions.map((q) => q.id)).toEqual(["mine", "child"]);
  });

  it("a tile wears only the skill badges of its own conversation", () => {
    let onSkill: Parameters<LvisApi["onSkillLoaded"]>[0] | undefined;
    const api = {
      onAskUserQuestion: vi.fn(() => () => undefined),
      onAgentSpawnEvent: vi.fn(() => () => undefined),
      onSkillLoaded: vi.fn((handler: Parameters<LvisApi["onSkillLoaded"]>[0]) => {
        onSkill = handler;
        return () => undefined;
      }),
      onAskUserQuestionTimeout: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    const ownsSession = (sessionId: string) => sessionId === "session-mine";
    const { result } = renderHook(() => useWorkflowTools(api, { ownsSession }));

    act(() => {
      onSkill?.({ name: "mine", description: "loaded here", sessionId: "session-mine" });
      onSkill?.({ name: "theirs", description: "loaded elsewhere", sessionId: "session-other-tile" });
    });

    expect(result.current.loadedSkills.map((s) => s.name)).toEqual(["mine"]);
  });
});
