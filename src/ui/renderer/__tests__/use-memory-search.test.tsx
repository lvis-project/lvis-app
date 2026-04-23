import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemorySearch } from "../hooks/use-memory-search.js";
import type { LvisApi } from "../types.js";

function Harness({ api }: { api: LvisApi }) {
  const { query, setQuery, noteResults, sessionResults, loading } = useMemorySearch(api);

  return (
    <div>
      <input aria-label="query" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="notes">{noteResults.map((note) => note.title).join(",")}</div>
      <div data-testid="sessions">{sessionResults.map((session) => session.sessionId).join(",")}</div>
    </div>
  );
}

describe("useMemorySearch", () => {
  it("queries memorySearchEntries for note results", async () => {
    const api = {
      memorySearchEntries: vi.fn().mockResolvedValue([
        { title: "사용자 메모", excerpt: "본문", updatedAt: "2026-04-20T00:00:00Z" },
      ]),
      memorySearchSessions: vi.fn().mockResolvedValue([
        { sessionId: "session-1", matchedMessage: "본문", timestamp: "2026-04-20T00:00:00Z" },
      ]),
      memorySearchNotes: vi.fn(),
    } as unknown as LvisApi;

    render(<Harness api={api} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("query"), { target: { value: "메모" } });
    });

    await waitFor(() => {
      expect(api.memorySearchEntries).toHaveBeenCalledWith("메모");
    });
    expect(api.memorySearchNotes).not.toHaveBeenCalled();
    expect(screen.getByTestId("notes").textContent).toContain("사용자 메모");
    expect(screen.getByTestId("sessions").textContent).toContain("session-1");
  });
});
