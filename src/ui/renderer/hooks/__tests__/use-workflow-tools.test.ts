import "../../../../../test/renderer/setup.js";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkflowTools } from "../use-workflow-tools.js";
import type { LvisApi } from "../../types.js";
import type { AgentSpawnEvent } from "../../../../tools/agent-spawn.js";

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
        parentSessionId: "session-solo",
      });
      onSpawn?.({
        spawnId: "spawn-waiting",
        type: "done",
        taskState: "TASK_STATE_INPUT_REQUIRED",
        status: "waiting",
        summary: "partial work",
        suspension: { reason: "budget", resumeId: "child-waiting" },
        parentSessionId: "session-solo",
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
      // A frame that names no conversation is one EVERY tile would keep, which
      // is N cards for one sub-agent and an act-on button in a tile that did
      // not spawn it. `parentSessionId` is required on the wire for that
      // reason; this is the runtime half of the same rule, since the type does
      // not cross the IPC boundary.
      onSpawn?.({
        spawnId: "unaddressed", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Unaddressed",
      } as unknown as AgentSpawnEvent);
      // Later phases of another tile's agent are dropped too, not synthesized.
      onSpawn?.({ spawnId: "theirs", type: "done", taskState: "TASK_STATE_COMPLETED", status: "done", summary: "x", parentSessionId: "session-other-tile" });
    });

    expect(result.current.subAgentSpawns.map((s) => s.spawnId)).toEqual(["mine"]);
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

  it("draws an adopted card while sub-agent frames stay bound to the owned session", () => {
    let onAsk: Parameters<LvisApi["onAskUserQuestion"]>[0] | undefined;
    let onSkill: Parameters<LvisApi["onSkillLoaded"]>[0] | undefined;
    let onSpawn: Parameters<LvisApi["onAgentSpawnEvent"]>[0] | undefined;
    const api = {
      onAskUserQuestion: vi.fn((handler: Parameters<LvisApi["onAskUserQuestion"]>[0]) => {
        onAsk = handler;
        return () => undefined;
      }),
      onAgentSpawnEvent: vi.fn((handler: Parameters<LvisApi["onAgentSpawnEvent"]>[0]) => {
        onSpawn = handler;
        return () => undefined;
      }),
      onSkillLoaded: vi.fn((handler: Parameters<LvisApi["onSkillLoaded"]>[0]) => {
        onSkill = handler;
        return () => undefined;
      }),
      onAskUserQuestionTimeout: vi.fn(() => () => undefined),
    } as unknown as LvisApi;
    // What a focused tile passes: it owns one conversation, and adopts cards
    // from any session no tile is showing (a routine here).
    const ownsSession = (sessionId: string) => sessionId === "session-mine";
    const drawsSession = (sessionId: string) =>
      ownsSession(sessionId) || sessionId === "session-routine";
    const { result } = renderHook(() => useWorkflowTools(api, { ownsSession, drawsSession }));

    act(() => {
      onAsk?.({
        id: "routine-card",
        sessionId: "session-routine",
        questions: [{ question: "?", choices: ["yes", "no"] }],
        createdAt: 0,
      });
      onSkill?.({ name: "routine-skill", description: "loaded headless", sessionId: "session-routine" });
      // Frames keep the narrower rule: an adopted card is a prompt this tile
      // must answer, but another session's agent list is not this tile's panel.
      onSpawn?.({ spawnId: "routine-spawn", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Routine", parentSessionId: "session-routine" });
    });

    expect(result.current.askQuestions.map((q) => q.id)).toEqual(["routine-card"]);
    expect(result.current.loadedSkills.map((s) => s.name)).toEqual(["routine-skill"]);
    expect(result.current.subAgentSpawns).toEqual([]);
  });
});
