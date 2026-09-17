import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import { useSearch } from "../use-search.js";

describe("useSearch processing visibility", () => {
  const entries: ChatEntry[] = [
    { kind: "user", text: "visibility needle user" },
    { kind: "assistant", text: "visibility needle intermediate" },
    { kind: "reasoning", text: "visibility needle reasoning" },
    {
      kind: "tool_group",
      groupId: "search-tool",
      groupIds: ["search-tool"],
      status: "done",
      tools: [{ toolUseId: "search-tool", name: "inspect", displayOrder: 0, status: "done" }],
    },
    { kind: "assistant", text: "visibility needle final" },
  ];

  it("indexes only the processing rows visible at each detail level without changing their indices", () => {
    const originalEntries = structuredClone(entries);
    for (const entry of entries) Object.freeze(entry);
    Object.freeze(entries);

    const { result, rerender } = renderHook(
      ({ level }: { level: "tools" | "reasoning" | "full" }) => useSearch(entries, {
        processingDisplayLevel: level,
        streaming: false,
      }),
      { initialProps: { level: "tools" } as { level: "tools" | "reasoning" | "full" } },
    );

    act(() => result.current.changeQuery("visibility needle"));
    expect(result.current.matches).toEqual([0, 4]);

    rerender({ level: "reasoning" });
    expect(result.current.matches).toEqual([0, 2, 4]);

    rerender({ level: "full" });
    expect(result.current.matches).toEqual([0, 1, 2, 4]);
    expect(entries).toEqual(originalEntries);
  });

  it.each(["tools", "reasoning", "full"] as const)(
    "keeps status, system, interrupted, and final assistant rows searchable at %s detail",
    (processingDisplayLevel) => {
      const retainedEntries: ChatEntry[] = [
        { kind: "user", text: "question" },
        { kind: "assistant", text: "retry status", phase: "status" },
        { kind: "assistant", text: "stream error", phase: "work", systemNotice: "stream-error" },
        { kind: "assistant", text: "interrupted response", phase: "work", interrupted: true },
        { kind: "assistant", text: "final answer", phase: "final" },
      ];
      for (const entry of retainedEntries) Object.freeze(entry);
      Object.freeze(retainedEntries);

      const { result } = renderHook(() => useSearch(retainedEntries, {
        processingDisplayLevel,
        streaming: false,
      }));

      for (const [query, index] of [
        ["retry status", 1],
        ["stream error", 2],
        ["interrupted response", 3],
        ["final answer", 4],
      ] as const) {
        act(() => result.current.changeQuery(query));
        expect(result.current.matches).toEqual([index]);
      }
    },
  );

  it("does not index active reasoning or the header-only provider status", () => {
    const activeEntries: ChatEntry[] = [
      { kind: "user", text: "question" },
      { kind: "assistant", text: "retry status", phase: "status", streaming: true },
      { kind: "reasoning", text: "hidden active thought", streaming: true },
    ];
    const { result } = renderHook(() => useSearch(activeEntries, {
      processingDisplayLevel: "full",
      streaming: true,
    }));

    act(() => result.current.changeQuery("status"));
    expect(result.current.matches).toEqual([]);
    act(() => result.current.changeQuery("thought"));
    expect(result.current.matches).toEqual([]);
  });
});
