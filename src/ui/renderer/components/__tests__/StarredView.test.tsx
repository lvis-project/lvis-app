// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { StarredView } from "../StarredView.js";

describe("StarredView", () => {
  it("removes a starred item and refreshes the list", async () => {
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];
    const refreshStarred = vi.fn(async () => {});

    const { getByTitle } = render(
      <StarredView
        api={api}
        starred={[{
          id: "s-42",
          sessionId: "sess-star",
          messageIndex: 0,
          role: "assistant",
          text: "remembered answer",
          starredAt: new Date().toISOString(),
        }]}
        currentSessionId="sess-star"
        refreshStarred={refreshStarred}
        onJumpToSession={vi.fn()}
        onActivateHome={vi.fn()}
      />,
    );

    fireEvent.click(getByTitle("해제"));

    await waitFor(() => expect((api as { starredRemove: ReturnType<typeof vi.fn> }).starredRemove).toHaveBeenCalledWith({ id: "s-42" }));
    await waitFor(() => expect(refreshStarred).toHaveBeenCalled());
  });
});
