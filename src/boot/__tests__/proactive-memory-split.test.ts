import { describe, it, expect, vi } from "vitest";
import { createRoutineEngine } from "../routine.js";

describe("createRoutineEngine memory split wiring", () => {
  it("reads recent notes from notes/ and voice hints from memory entries", () => {
    const listNotes = vi.fn(() => [
      { title: "회의 요약", filename: "meeting.md", content: "# 회의 요약" },
    ]);
    const listMemoryEntries = vi.fn(() => [
      { title: "사용자 톤 메모", filename: "memory.md", content: "# 사용자 톤 메모" },
    ]);
    const engine = createRoutineEngine({
      taskService: { getPendingByPriority: () => [] } as never,
      memoryManager: {
        listNotes,
        listMemoryEntries,
        listSessions: () => [],
        readRecentBriefingFeedback: () => [],
      } as never,
      pluginRuntime: {
        listPluginManifests: () => [],
      } as never,
    });

    const items = engine.collectBriefingItems(new Date("2026-04-20T09:00:00Z"));
    const prompt = engine.getBriefingPromptData(items, new Date("2026-04-20T09:00:00Z"));

    expect(listNotes).toHaveBeenCalled();
    expect(listMemoryEntries).toHaveBeenCalled();
    expect(items.some((item) => item.category === "note" && item.detail?.includes("회의 요약"))).toBe(true);
    expect(items.some((item) => item.category === "note" && item.detail?.includes("사용자 톤 메모"))).toBe(false);
    expect(prompt).toContain("사용자 톤 메모");
    expect(prompt).not.toContain("회의 요약. 이 어휘·톤을 자연스럽게 반영해 주세요.");
  });
});
