/**
 * What belongs to a TILE and what belongs to the WINDOW, with two tiles open.
 *
 * Main pushes several surfaces at the renderer that predate tiled chat groups.
 * Each one has to answer the same question — is this news about one
 * conversation or about the window? — and the answer decides whether it is
 * subscribed per tile or once, and which tile gets to show it.
 */
import "./setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { focusTile, splitIntoTwoTiles } from "./helpers.js";
import type { MockLvisApi } from "./mock-lvis-api.js";

/** The permission namespace's subscriptions, as the mock records them. */
function permissionSubscription(api: MockLvisApi, name: string): ReturnType<typeof vi.fn> {
  return (api.permission as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]!;
}

describe("permission disclosure toasts with two tiles", () => {
  it("subscribes and renders once for the window, not once per tile", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    const onHit = permissionSubscription(api, "onUserApprovalHit");
    await waitFor(() => expect(onHit).toHaveBeenCalled());

    await splitIntoTwoTiles(container);

    // The setting these report on is the window's, so a second conversation
    // must not bring a second subscription with it.
    expect(onHit).toHaveBeenCalledTimes(1);

    const fire = onHit.mock.calls[0]?.[0] as (payload: {
      toolName: string;
      scope: "session" | "persistent";
      verdictAtApproval: "low" | "medium" | "high";
    }) => void;
    await act(async () => {
      fire({ toolName: "fs_write", scope: "persistent", verdictAtApproval: "low" });
    });

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="user-approval-hit-toast"]'),
      ).toHaveLength(1);
    });
  });

  it("raises the review suggestion once however many conversations are open", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    const onSuggestion = permissionSubscription(api, "onReviewSuggestion");
    await waitFor(() => expect(onSuggestion).toHaveBeenCalled());

    await splitIntoTwoTiles(container);
    expect(onSuggestion).toHaveBeenCalledTimes(1);

    const fire = onSuggestion.mock.calls[0]?.[0] as (payload: {
      reason: "allow-always" | "repeat-allow";
      allowCount: number;
      allowAlwaysCount: number;
      threshold: number;
      windowMs: number;
    }) => void;
    await act(async () => {
      fire({
        reason: "repeat-allow",
        allowCount: 3,
        allowAlwaysCount: 0,
        threshold: 3,
        windowMs: 300000,
      });
    });

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="permission-review-suggestion-toast"]'),
      ).toHaveLength(1);
    });
  });
});

describe("overlay cards with two tiles", () => {
  const overlayRegions = (tile: { element: HTMLElement }) =>
    tile.element.querySelectorAll('[data-testid="overlay-card-region"]');

  it("shows an app card in the tile holding the conversation it came from", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    // Focus follows the split, so the primary tile is NOT focused here — the
    // card must still land on the tile holding its origin conversation.
    await focusTile(primary!);

    await act(async () => {
      emitOverlayShow({
        id: "app:invoices:e1",
        source: { kind: "app", serverId: "invoices", eventId: "e1" },
        originSessionId: `session-${second!.chatGroupId}`,
        title: "invoices",
        summary: "open the invoice",
        running: false,
        pendingPrompt: '<app-message source="app:invoices">\nopen the invoice\n</app-message>',
        createdAt: new Date().toISOString(),
      });
    });

    await waitFor(() => expect(overlayRegions(second!)).toHaveLength(1));
    expect(overlayRegions(primary!)).toHaveLength(0);
  });

  it("confirming an app card starts the turn in the tile that showed it", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    await focusTile(primary!);

    await act(async () => {
      emitOverlayShow({
        id: "app:invoices:e2",
        source: { kind: "app", serverId: "invoices", eventId: "e2" },
        originSessionId: `session-${second!.chatGroupId}`,
        title: "invoices",
        summary: "settle the invoice",
        running: false,
        pendingPrompt: '<app-message source="app:invoices">\nsettle the invoice\n</app-message>',
        createdAt: new Date().toISOString(),
      });
    });

    const confirm = await waitFor(() => {
      const button = second!.element.querySelector<HTMLButtonElement>(
        '[data-testid="overlay-card-primary-action"]',
      );
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(confirm);
    });

    // The staged prompt lands in the conversation the card came from, not in
    // the focused one.
    await waitFor(() => {
      expect(second!.element.textContent).toContain("settle the invoice");
    });
    expect(primary!.element.textContent).not.toContain("settle the invoice");
  });

  it("shows a routine card on the focused tile, and moves it when focus moves", async () => {
    const { container, emitRoutineFired } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    // A routine has no conversation behind it, so it belongs to whichever tile
    // the user is looking at. The split left the second tile focused.
    await act(async () => {
      emitRoutineFired({
        id: "schedule-daily",
        trigger: "schedule",
        firedAt: new Date().toISOString(),
        title: "Daily schedule",
        summary: "daily summary",
      });
    });

    await waitFor(() => expect(overlayRegions(second!)).toHaveLength(1));
    expect(overlayRegions(primary!)).toHaveLength(0);

    await focusTile(primary!);

    await waitFor(() => expect(overlayRegions(primary!)).toHaveLength(1));
    expect(overlayRegions(second!)).toHaveLength(0);
  });

  it("dismisses a routine card once, acknowledging it a single time", async () => {
    const { container, api, emitRoutineFired } = await renderApp({ hasApiKey: true });
    const [, second] = await splitIntoTwoTiles(container);
    const firedAt = new Date().toISOString();

    await act(async () => {
      emitRoutineFired({
        id: "schedule-daily",
        trigger: "schedule",
        firedAt,
        title: "Daily schedule",
        summary: "daily summary",
      });
    });

    const dismiss = await waitFor(() => {
      const button = second!.element.querySelector<HTMLButtonElement>(
        '[data-testid="routine-card-dismiss"]',
      );
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(dismiss);
    });

    await waitFor(() => {
      expect(api.acknowledgeRoutineResult).toHaveBeenCalledTimes(1);
    });
    expect(api.acknowledgeRoutineResult).toHaveBeenCalledWith("schedule-daily", firedAt);
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(0);
  });
});
