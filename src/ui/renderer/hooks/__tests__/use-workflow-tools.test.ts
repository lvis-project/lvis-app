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
        title: "Budgeted agent",
      });
      onSpawn?.({
        spawnId: "spawn-waiting",
        type: "done",
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
});