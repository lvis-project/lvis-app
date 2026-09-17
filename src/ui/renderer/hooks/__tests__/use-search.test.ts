import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import { useSearch } from "../use-search.js";

describe("useSearch processing visibility", () => {
  const entries: ChatEntry[] = [
    { kind: "user", text: "question" },
    { kind: "assistant", text: "hidden intermediate" },
    {
      kind: "tool_group",
      groupId: "search-tool",
      groupIds: ["search-tool"],
      status: "done",
      tools: [{ toolUseId: "search-tool", name: "inspect", displayOrder: 0, status: "done" }],
    },
    { kind: "assistant", text: "visible final" },
  ];

  it("does not navigate to assistant rows hidden by the processing detail level", () => {
    const { result, rerender } = renderHook(
      ({ level }: { level: "tools" | "full" }) => useSearch(entries, {
        processingDisplayLevel: level,
        streaming: false,
      }),
      { initialProps: { level: "tools" } as { level: "tools" | "full" } },
    );

    act(() => result.current.changeQuery("hidden intermediate"));
    expect(result.current.matches).toEqual([]);

    act(() => result.current.changeQuery("visible final"));
    expect(result.current.matches).toEqual([3]);

    rerender({ level: "full" });
    act(() => result.current.changeQuery("hidden intermediate"));
    expect(result.current.matches).toEqual([1]);
  });
});
