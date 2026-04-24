import { describe, it, expect, vi } from "vitest";
import { createRoutineEngine } from "../routine.js";

describe("createRoutineEngine memory split wiring", () => {
  it("reads recent memory entries and voice hints from memory entries", () => {
    const listMemoryEntries = vi.fn(() => [
      { title: "사용자 톤 메모", filename: "memory.md", content: "# 사용자 톤 메모" },
    ]);
    const engine = createRoutineEngine({
      taskService: { getPendingByPriority: () => [] } as never,
      memoryManager: {
        listMemoryEntries,
        listSessions: () => [],
      } as never,
      pluginRuntime: {
        listPluginManifests: () => [],
        findPluginIdByCapability: () => undefined,
        getPluginManifest: () => undefined,
      } as never,
    });

    const items = engine.collectBriefingItems(new Date("2026-04-20T09:00:00Z"));
    const prompt = engine.getBriefingPromptData(items, new Date("2026-04-20T09:00:00Z"));

    expect(listMemoryEntries).toHaveBeenCalled();
    expect(prompt).toContain("사용자 톤 메모");
  });
});
