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

  it("jumps to another session before activating home", async () => {
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];
    const onJumpToSession = vi.fn(async () => true);
    const onActivateHome = vi.fn();

    const { getByText } = render(
      <StarredView
        api={api}
        starred={[{
          id: "s-43",
          sessionId: "sess-other",
          messageIndex: 0,
          role: "assistant",
          text: "open another session",
          starredAt: new Date().toISOString(),
        }]}
        currentSessionId="sess-current"
        refreshStarred={vi.fn()}
        onJumpToSession={onJumpToSession}
        onActivateHome={onActivateHome}
      />,
    );

    fireEvent.click(getByText("open another session"));

    await waitFor(() => expect(onJumpToSession).toHaveBeenCalledWith("sess-other"));
    expect(onActivateHome).toHaveBeenCalledOnce();
  });

  it("does not activate home when cross-window jump fails", async () => {
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];
    const onActivateHome = vi.fn();

    const { getByText } = render(
      <StarredView
        api={api}
        starred={[{
          id: "s-44",
          sessionId: "sess-other",
          messageIndex: 0,
          role: "assistant",
          text: "failed jump target",
          starredAt: new Date().toISOString(),
        }]}
        currentSessionId="sess-current"
        refreshStarred={vi.fn()}
        onJumpToSession={vi.fn(async () => false)}
        onActivateHome={onActivateHome}
      />,
    );

    fireEvent.click(getByText("failed jump target"));

    await waitFor(() => expect(onActivateHome).not.toHaveBeenCalled());
  });
});
