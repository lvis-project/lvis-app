/**
 * Pin / unpin flow on chat messages.
 *
 * Covers: addStarred fires with correct payload, toggle-off calls
 * starredRemove, and the starred view lists saved entries.
 *
 * Per-message pinning lives on the completed turn's action bar. The user's own
 * message card deliberately has no pin — a question is pinned by pinning the
 * conversation, not the utterance.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { submitChatMessage } from "./helpers.js";


/** A finished turn, so the transcript renders the turn action bar that owns the pin. */
const answeredTurn = (question: string, answer: string) => ({
  sessionId: "sess-star",
  messages: [
    { role: "user" as const, content: question },
    { role: "assistant" as const, content: answer },
  ],
});

const pinButton = (container: HTMLElement) =>
  waitFor(() => {
    const btn = container.querySelector('[data-testid="turn-pin-button"]');
    if (!btn) throw new Error("pin button not found");
    return btn as HTMLButtonElement;
  });

describe("Pin flow", () => {
  it("clicking pin on a completed turn calls starredAdd with sessionId + messageIndex", async () => {
    const { container, api } = await renderApp({
      currentSession: "sess-star",
      history: answeredTurn("pin me", "pinned answer"),
    });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(await pinButton(container));
    });
    await waitFor(() => expect(api.addStarred).toHaveBeenCalled());
    const arg = api.addStarred.mock.calls[0]?.[0] as {
      sessionId?: string;
      messageIndex?: number;
      role?: string;
      text?: string;
    };
    expect(arg?.role).toBe("assistant");
    expect(arg?.text).toBe("pinned answer");
    expect(arg?.sessionId).toBe("sess-star");
    expect(arg?.messageIndex).toBe(1);
  });

  it("offers no pin on the user's own message card", async () => {
    const { container, api } = await renderApp({ currentSession: "sess-star" });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await submitChatMessage(container, "a question of mine");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    const actionsRow = await waitFor(() => {
      const row = container.querySelector('[data-testid="user-message-actions"]');
      if (!row) throw new Error("user message actions not rendered");
      return row as HTMLElement;
    });
    expect(actionsRow.querySelector('button[title="핀 고정"]')).toBeNull();
  });

  it("pinning then unpinning calls starredRemove", async () => {
    const { container, api } = await renderApp({
      currentSession: "sess-star",
      history: answeredTurn("toggle me", "toggled answer"),
    });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    // After the first click fires starredAdd, subsequent list reads should
    // include the entry so isEntryStarred() flips true and the next click
    // removes instead of re-adding.
    const addedEntry = {
      id: "s-new",
      sessionId: "sess-star",
      messageIndex: 1,
      role: "assistant",
      text: "toggled answer",
      starredAt: new Date().toISOString(),
    };
    api.addStarred.mockImplementationOnce(async (entry: unknown) => {
      api.starredList.mockResolvedValue([addedEntry]);
      return { ok: true, entry };
    });
    api.removeStarred.mockImplementationOnce(async (opts: unknown) => {
      expect(opts).toEqual({ id: "s-new" });
      api.starredList.mockResolvedValue([]);
      return { ok: true };
    });

    await act(async () => {
      fireEvent.click(await pinButton(container));
    });
    await waitFor(() => expect(api.addStarred).toHaveBeenCalled());
    // refreshStarred runs after add; wait for the second starredList call.
    await waitFor(() => expect(api.starredList.mock.calls.length).toBeGreaterThan(1));

    // Click again — now the entry is recognized as pinned and this removes.
    await act(async () => {
      fireEvent.click(await pinButton(container));
    });
    await waitFor(() => expect(api.removeStarred).toHaveBeenCalledWith({ id: "s-new" }));
    await waitFor(() => expect(api.starredList.mock.calls.length).toBeGreaterThan(2));

    await act(async () => {
      fireEvent.click(await pinButton(container));
    });
    await waitFor(() => expect(api.addStarred).toHaveBeenCalledTimes(2));
  });

  it("starred view from hamburger menu exposes the saved entries", async () => {
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
    // Navigation moved from the hamburger menu to the persistent sidebar.
    await user.click(await waitFor(() => {
      const el = container.querySelector('[data-testid="sidebar-starred"]');
      if (!el) throw new Error("sidebar starred nav item not found");
      return el as HTMLElement;
    }));
    await waitFor(() => {
      expect(container.textContent).toContain("remembered answer");
    });
  });

  it("clicking a starred item from the current session returns home without reloading history", async () => {
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
    // Put another page behind Insights. Opening a result must activate Chat,
    // not replay history back to this intermediate page.
    await user.click(await waitFor(() => {
      const el = container.querySelector('[data-testid="toolbar-work-board"]');
      if (!el) throw new Error("work board nav item not found");
      return el as HTMLElement;
    }));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="view-path-current-work-board"]')).not.toBeNull();
    });

    await user.click(await waitFor(() => {
      const el = container.querySelector('[data-testid="sidebar-starred"]');
      if (!el) throw new Error("sidebar starred nav item not found");
      return el as HTMLElement;
    }));

    const entryButton = await waitFor(() => {
      const el = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("remembered answer"),
      );
      if (!el) throw new Error("starred item button not found");
      return el as HTMLButtonElement;
    });
    await user.click(entryButton);

    expect(api.chatSessionResume).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(container.textContent).toContain("LVIS 에이전트가 준비되었습니다.");
      expect(container.textContent).not.toContain("remembered answer");
      expect(container.querySelector('[data-testid="view-path-current-home"]')).not.toBeNull();
    });
  });

});

afterEach(() => {
  vi.unstubAllGlobals();
});
