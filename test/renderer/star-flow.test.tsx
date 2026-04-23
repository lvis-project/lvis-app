/**
 * Phase 3 safety net — star / unstar flow on chat messages.
 *
 * Covers: addStarred fires with correct payload, toggle-off calls
 * starredRemove, and the starred sidebar tab lists saved entries.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";

async function submit(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
  });
}

describe("Star flow (Phase 3 regression net)", { timeout: 15000 }, () => {
  it("clicking star on a user message calls starredAdd with sessionId + messageIndex", async () => {
    const { container, api } = await renderApp({ currentSession: "sess-star" });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submit(container, "star me");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    const starBtn = await waitFor(() => {
      const btn = container.querySelector('button[title="즐겨찾기"]');
      if (!btn) throw new Error("star button not found");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(starBtn);
    });
    await waitFor(() => expect(api.addStarred).toHaveBeenCalled());
    const arg = api.addStarred.mock.calls[0]?.[0] as {
      sessionId?: string;
      messageIndex?: number;
      role?: string;
      text?: string;
    };
    expect(arg?.role).toBe("user");
    expect(arg?.text).toBe("star me");
    expect(typeof arg?.messageIndex).toBe("number");
  });

  it("starring then unstarring calls starredRemove", async () => {
    const { container, api } = await renderApp({ currentSession: "sess-star" });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submit(container, "toggle me");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    const starBtn = await waitFor(() => {
      const btn = container.querySelector('button[title="즐겨찾기"]');
      if (!btn) throw new Error("star button not found");
      return btn as HTMLButtonElement;
    });

    // After the first click fires starredAdd, subsequent list reads should
    // include the entry so isEntryStarred() flips true and the next click
    // removes instead of re-adding.
    const addedEntry = {
      id: "s-new",
      sessionId: "sess-star",
      messageIndex: 0,
      role: "user",
      text: "toggle me",
      starredAt: new Date().toISOString(),
    };
    api.addStarred.mockImplementationOnce(async (entry: unknown) => {
      api.starredList.mockResolvedValue([addedEntry]);
      return { ok: true, entry };
    });

    await act(async () => {
      fireEvent.click(starBtn);
    });
    await waitFor(() => expect(api.addStarred).toHaveBeenCalled());
    // refreshStarred runs after add; wait for the second starredList call.
    await waitFor(() => expect(api.starredList.mock.calls.length).toBeGreaterThan(1));

    // Click again — now the entry is recognized as starred and this removes.
    const starBtn2 = await waitFor(() => {
      const btn = container.querySelector('button[title="즐겨찾기"]');
      if (!btn) throw new Error("star button not found");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(starBtn2);
    });
    await waitFor(() => expect(api.removeStarred).toHaveBeenCalled());
  });

  it("starred tab in sidebar exposes the saved entries", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    const user = userEvent.setup();
    const starred = [
      {
        id: "s-42",
        sessionId: "sess-star",
        messageIndex: 0,
        role: "assistant",
        text: "remembered answer",
        starredAt: new Date().toISOString(),
      },
    ];
    const { container, api } = await renderApp({
      currentSession: "sess-star",
      starred,
    });
    await waitFor(() => expect(api.starredList).toHaveBeenCalled());
    const starredButton = await waitFor(() => {
      const el = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("즐겨찾기"),
      );
      if (!el) throw new Error("starred sidebar button not found");
      return el as HTMLButtonElement;
    });
    await user.click(starredButton);
    await waitFor(() => {
      expect(container.textContent).toContain("remembered answer");
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
