/**
 * What belongs to a TILE and what belongs to the WINDOW, with two or three
 * tiles open.
 *
 * Main pushes several surfaces at the renderer that predate tiled chat groups.
 * Each one has to answer the same question — is this news about one
 * conversation or about the window? — and the answer decides whether it is
 * subscribed per tile or once, and which tile gets to show it.
 */
import "./setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, createEvent, fireEvent, waitFor } from "@testing-library/react";
import { renderApp, startInChatMode } from "./render-app.js";
import {
  approvalRequest,
  clickSidebarNavRow,
  collectTiles,
  focusTile,
  forceOverflowingSummaries,
  splitIntoThreeTiles,
  splitIntoNTiles,
  splitIntoTwoTiles,
  submitChatMessage,
  deferred,
  mountedTileIds,
  toggleTileMaximized,
} from "./helpers.js";
import { MOCK_DEFAULT_SESSION_ID, MOCK_SIDE_CHAT_SESSION_ID, type MockLvisApi } from "./mock-lvis-api.js";
import { MAIN_CHAT_GROUP_ID, MAX_CHAT_GROUPS } from "../../src/contract/app-contract.js";
import { BLOCKING_SURFACE_SELECTOR, TEST_IDS, chatSidePanelLauncherTestId, testIdSelector } from "../../src/shared/test-ids.js";
import { CHAT_SESSION_DRAG_TYPE } from "../../src/ui/renderer/components/pane-drop.js";

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

  it("subscribes the reviewer suggestion once however many conversations are open", async () => {
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

    // The suggestion is the window's, and its surface is an approval card. With
    // no card up in either tile it draws nowhere — a per-tile copy would show
    // the same offer twice for one run of approvals.
    expect(
      container.querySelectorAll('[data-testid="reviewer-suggestion-band"]'),
    ).toHaveLength(0);
  });
});

describe("overlay cards with two tiles", () => {
  const overlayRegions = (tile: { element: HTMLElement }) =>
    tile.element.querySelectorAll('[data-testid="overlay-card-region"]');
  /** The window's own region — where a card no conversation owns is drawn. */
  const windowRegion = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-overlay-surface="window"]');

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

  it("runs an owned card's action in the conversation it came from, even after focus moves away", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    // Painted while its own tile is focused, so nothing about where it landed
    // is ambiguous yet.
    await focusTile(second!);
    await act(async () => {
      emitOverlayShow({
        id: "app:invoices:e9",
        source: { kind: "app", serverId: "invoices", eventId: "e9" },
        originSessionId: `session-${second!.chatGroupId}`,
        title: "invoices",
        summary: "archive the invoice",
        running: false,
        pendingPrompt: '<app-message source="app:invoices">\narchive the invoice\n</app-message>',
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

    // The user walks over to the other tile between the paint and the click.
    // The target is resolved from the card's ORIGIN at click time, so the
    // staged prompt still lands where it was staged for — resolving it from
    // whatever has focus would put one conversation's prompt in another.
    await focusTile(primary!);
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => {
      expect(second!.element.textContent).toContain("archive the invoice");
    });
    expect(primary!.element.textContent).not.toContain("archive the invoice");
  });

  it("draws a routine card once, in the focused tile, and moves it when focus moves", async () => {
    const { container, emitRoutineFired } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    // Focus follows the split, so the second tile is the focused one when the
    // card arrives. A routine turn runs in no tile; the card is drawn where
    // the user is, and confirming it starts a turn there.
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
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
    expect(overlayRegions(primary!)).toHaveLength(0);
    expect(windowRegion(container)).toBeNull();

    await focusTile(primary!);

    // One card, where the user is now. A card left in the unfocused tile is a
    // card nobody is looking at, and with several tiles open it would soon be
    // one card per tile.
    await waitFor(() => expect(overlayRegions(primary!)).toHaveLength(1));
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
    expect(overlayRegions(second!)).toHaveLength(0);
    expect(windowRegion(container)).toBeNull();
  });

  it("replaces the spinner with the result in the focused tile, still one card", async () => {
    const { container, emitRoutineRunningStarted, emitRoutineFired } =
      await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    const firedAt = new Date().toISOString();

    // The spinner arrives over the tile the split focused.
    await act(async () => {
      emitRoutineRunningStarted({ routineId: "schedule-daily", firedAt, title: "Daily schedule" });
    });
    await waitFor(() => expect(overlayRegions(second!)).toHaveLength(1));

    // The user works elsewhere while the routine runs — tens of seconds, in
    // practice — and only then does the result land.
    await focusTile(primary!);
    await act(async () => {
      emitRoutineFired({
        id: "schedule-daily",
        trigger: "schedule",
        firedAt,
        title: "Daily schedule",
        summary: "daily summary",
      });
    });

    // The result REPLACES the spinner in the queue — one card, drawn where the
    // user is now, not a spinner left behind in the other tile.
    await waitFor(() => expect(primary!.element.textContent).toContain("daily summary"));
    expect(overlayRegions(primary!)).toHaveLength(1);
    expect(overlayRegions(second!)).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
  });

  it("starts the confirmed turn in the focused tile — the one showing the card", async () => {
    const { container, api, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitOverlayShow({
        id: "plugin:notes:focused",
        source: { kind: "plugin", pluginId: "notes", eventId: "focused" },
        title: "notes",
        summary: "focused target",
        running: false,
        pendingPrompt: "<untrusted-plugin>notes</untrusted-plugin>",
        createdAt: new Date().toISOString(),
      });
    });
    await waitFor(() => {
      expect(second!.element.querySelector('[data-testid="overlay-card-primary-action"]')).not.toBeNull();
    });

    // Focus moves before the click; the card moves with it, and the confirm
    // the user reaches is the one in the tile they are in.
    await focusTile(primary!);
    const confirm = await waitFor(() => {
      const button = primary!.element.querySelector<HTMLButtonElement>(
        '[data-testid="overlay-card-primary-action"]',
      );
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(confirm);
    });

    // The staged prompt is inserted through the TILE's own handle, so the
    // transcript it lands in is the answer to "which conversation ran it".
    await waitFor(() => expect(primary!.element.textContent).toContain("focused target"));
    expect(second!.element.textContent).not.toContain("focused target");
    expect(api.chatSend).toHaveBeenCalled();
  });

  it("dismisses a routine card once, acknowledging it a single time", async () => {
    const { container, api, emitRoutineFired } = await renderApp({ hasApiKey: true });
    await splitIntoTwoTiles(container);
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
      // Wherever the card is drawn, there is exactly one of it to dismiss.
      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="routine-card-dismiss"]',
      );
      expect(button).toBeDefined();
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

describe("overlay cards whose origin conversation leaves the screen", () => {
  /** A staged card raised inside `originSessionId`. */
  const appCard = (id: string, originSessionId: string, summary: string) => ({
    id,
    source: { kind: "app", serverId: "invoices", eventId: id },
    originSessionId,
    title: "invoices",
    summary,
    running: false,
    pendingPrompt: `<app-message source="app:invoices">\n${summary}\n</app-message>`,
    createdAt: new Date().toISOString(),
  });

  it("keeps the card with its hidden conversation, marks the way back with a dot, and restores the action with the tile", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    await focusTile(primary!);

    await act(async () => {
      emitOverlayShow(appCard("app:invoices:e3", `session-${second!.chatGroupId}`, "reconcile the ledger"));
    });
    await waitFor(() => {
      expect(second!.element.querySelector('[data-testid="overlay-card-region"]')).not.toBeNull();
    });
    expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).toBeNull();

    // Showing only the primary tile hides the tile holding the card's
    // conversation. The card is that conversation's: it is not drawn in a
    // conversation it was never staged for, and it does not vanish — it waits,
    // and the one control that brings its pane back says something is waiting.
    await toggleTileMaximized(primary!);
    await waitFor(() => {
      expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).not.toBeNull();
    });
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(0);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();

    // Restoring the split brings the origin conversation back, and with it the
    // action — which runs in that conversation, not the focused one.
    await toggleTileMaximized(primary!);
    await waitFor(() => {
      expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).toBeNull();
    });
    const tiles = collectTiles(container);
    const origin = tiles.find((tile) => tile.chatGroupId === second!.chatGroupId)!;
    const confirm = await waitFor(() => {
      const button = origin.element.querySelector<HTMLButtonElement>(
        '[data-testid="overlay-card-primary-action"]',
      );
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => {
      expect(origin.element.textContent).toContain("reconcile the ledger");
    });
    const other = tiles.find((tile) => tile.chatGroupId !== second!.chatGroupId)!;
    expect(other.element.textContent).not.toContain("reconcile the ledger");
  });
});

describe("overlay cards in a pane routed off its conversation", () => {
  /** A plugin's staged prompt: no origin conversation, so it is drawn in the focused pane. */
  const pluginCard = (id: string, summary: string) => ({
    id,
    source: { kind: "plugin", pluginId: "mail-assistant", eventId: id },
    title: "mail-action",
    summary,
    running: false,
    pendingPrompt: `<plugin-message source="plugin:mail-assistant">\n${summary}\n</plugin-message>`,
    createdAt: new Date().toISOString(),
  });
  const routedShell = (container: HTMLElement, view: string) =>
    container.querySelector<HTMLElement>(`[data-testid="main-pane-shell"][data-view="${view}"]`);
  const regions = (root: ParentNode) => root.querySelectorAll('[data-testid="overlay-card-region"]');
  /** The lane the region floats in must be the FRAME's body, under its header band. */
  const expectInFrameLane = (frame: HTMLElement, region: HTMLElement) => {
    const lane = region.closest<HTMLElement>('[data-testid="floating-right-lane"]');
    expect(lane).not.toBeNull();
    expect(frame.querySelector("[data-body-inset]")!.contains(lane)).toBe(true);
    expect(frame.querySelector('[data-testid="pane-header"]')!.contains(lane)).toBe(false);
  };

  it("draws a card with no origin in the frame of the pane it arrived over while that pane shows the work board — not in the window band", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    await clickSidebarNavRow("features", "toolbar-work-board");
    const shell = await waitFor(() => {
      const routed = routedShell(container, "work-board");
      expect(routed).not.toBeNull();
      return routed!;
    });
    const cell = container.querySelector<HTMLElement>(`[data-testid="pane-cell:${MAIN_CHAT_GROUP_ID}"]`)!;
    expect(cell.contains(shell)).toBe(true);
    // The pane is drawn; only its conversation is behind the view.
    expect(cell.getAttribute("data-hidden")).toBeNull();

    await act(async () => {
      emitOverlayShow(pluginCard("plugin:mail:e1", "메일에 답장할까요?"));
    });

    const region = await waitFor(() => {
      const drawn = container.querySelector<HTMLElement>('[data-testid="overlay-card-region"]');
      expect(drawn).not.toBeNull();
      return drawn!;
    });
    expect(regions(container)).toHaveLength(1);
    expect(shell.contains(region)).toBe(true);
    expect(region.getAttribute("data-overlay-surface")).toBe(MAIN_CHAT_GROUP_ID);
    expect(region.textContent).toContain("메일에 답장할까요?");
    const frame = shell.querySelector<HTMLElement>('[data-testid="pane"]')!;
    expectInFrameLane(frame, region);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();

    // Closing the view hands the pane back to its conversation, and the card
    // comes with it — still drawn once, in the conversation frame's lane.
    await act(async () => {
      fireEvent.click(frame.querySelector('[data-testid="pane-close"]')!);
    });
    await waitFor(() => expect(routedShell(container, "work-board")).toBeNull());
    const homeRegion = await waitFor(() => {
      const drawn = cell.querySelector<HTMLElement>('[data-testid="overlay-card-region"]');
      expect(drawn).not.toBeNull();
      return drawn!;
    });
    expect(regions(container)).toHaveLength(1);
    expect(homeRegion.getAttribute("data-overlay-surface")).toBe(MAIN_CHAT_GROUP_ID);
    expectInFrameLane(cell.querySelector<HTMLElement>('[data-testid="pane"]')!, homeRegion);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();
  });

  it("with two panes, draws the card in the focused pane — routed or not — and moves it when focus moves", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    // Focus follows the split, so the sidebar routes the SECOND pane.
    await clickSidebarNavRow("features", "toolbar-work-board");
    const shell = await waitFor(() => {
      const routed = routedShell(container, "work-board");
      expect(routed).not.toBeNull();
      return routed!;
    });
    expect(second!.element.contains(shell)).toBe(true);
    expect(primary!.element.contains(shell)).toBe(false);

    await act(async () => {
      emitOverlayShow(pluginCard("plugin:mail:e2", "두 번째 판에 도착한 카드"));
    });
    await waitFor(() => expect(regions(second!.element)).toHaveLength(1));
    expect(shell.contains(second!.element.querySelector('[data-testid="overlay-card-region"]'))).toBe(true);
    expect(regions(primary!.element)).toHaveLength(0);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();

    // Focus moving to the conversation pane carries the card with it: one
    // card, in the pane the user is in, in that frame's lane.
    await focusTile(primary!);
    const moved = await waitFor(() => {
      const region = primary!.element.querySelector<HTMLElement>('[data-testid="overlay-card-region"]');
      expect(region).not.toBeNull();
      return region!;
    });
    expect(regions(second!.element)).toHaveLength(0);
    expect(regions(container)).toHaveLength(1);
    expectInFrameLane(primary!.element.querySelector<HTMLElement>('[data-testid="pane"]')!, moved);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();
  });
});

describe("overlay queue navigation with two tiles", () => {
  it("counts and steps through each surface's own cards", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    await focusTile(primary!);

    const card = (id: string, originSessionId: string | undefined, summary: string) => ({
      id,
      source: { kind: "app", serverId: "invoices", eventId: id },
      ...(originSessionId === undefined ? {} : { originSessionId }),
      title: "invoices",
      summary,
      running: false,
      pendingPrompt: `<app-message source="app:invoices">\n${summary}\n</app-message>`,
      createdAt: new Date().toISOString(),
    });

    // Two with no origin — both drawn in the focused tile — and one for the
    // tile holding its origin conversation.
    await act(async () => {
      emitOverlayShow(card("a1", undefined, "first for the window"));
      emitOverlayShow(card("b1", `session-${second!.chatGroupId}`, "only for the other tile"));
      emitOverlayShow(card("a2", undefined, "second for the window"));
    });

    const indicator = (root: HTMLElement | null | undefined) =>
      root?.querySelector('[data-testid="routine-card-indicator"]')?.textContent;
    // Each surface counts what IT shows. A window-wide counter would say 3/3.
    await waitFor(() => expect(indicator(primary!.element)).toBe("2/2"));
    expect(primary!.element.textContent).toContain("second for the window");
    // One card is not a queue, so the tile that owns one shows no counter.
    expect(indicator(second!.element)).toBeUndefined();
    expect(second!.element.textContent).toContain("only for the other tile");
    // Nothing is left over for the window.
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();

    // Stepping back stays inside this surface's slice — it never lands on the
    // card that renders in the other tile.
    const back = primary!.element.querySelector<HTMLButtonElement>('[data-testid="overlay-card-prev"]')!;
    await act(async () => {
      fireEvent.click(back);
    });
    await waitFor(() => expect(indicator(primary!.element)).toBe("1/2"));
    expect(primary!.element.textContent).toContain("first for the window");
    expect(primary!.element.textContent).not.toContain("only for the other tile");
  });
});

describe("an unowned card follows focus without losing its state", () => {
  it("keeps the expanded summary and the original timestamp across a focus change", async () => {
    const restoreOverflow = forceOverflowingSummaries();
    try {
      const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
      const [primary, second] = await splitIntoTwoTiles(container);
      await focusTile(primary!);

      // No origin, so the card is drawn in the focused tile — the primary
      // here. Moving focus moves it; what the user did to it comes along.
      const createdAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await act(async () => {
        emitOverlayShow({
          id: "plugin:notes:e1",
          source: { kind: "plugin", pluginId: "notes", eventId: "e1" },
          title: "notes",
          summary: "긴 요약 ".repeat(50),
          running: false,
          pendingPrompt: "<untrusted-plugin>notes</untrusted-plugin>",
          createdAt,
        });
      });

      const shownRegion = () =>
        primary!.element.querySelector<HTMLElement>('[data-testid="overlay-card-region"]')!;
      const toggle = await waitFor(() => {
        const button = shownRegion().querySelector<HTMLButtonElement>(
          '[data-testid="overlay-card-expand-toggle"]',
        );
        expect(button).not.toBeNull();
        return button!;
      });
      await act(async () => {
        fireEvent.click(toggle);
      });
      expect(
        shownRegion().querySelector('[data-testid="overlay-card-summary"]')
          ?.getAttribute("data-expanded"),
      ).toBe("true");
      expect(shownRegion().textContent).toContain("10분 전");

      await focusTile(second!);

      // Same card, now in the focused tile. Expansion lives in the window's
      // context and the timestamp came from main, so neither is re-derived by
      // the region that draws it next — a card that re-minted "now" would
      // read 방금 instead.
      const movedRegion = await waitFor(() => {
        const region = second!.element.querySelector<HTMLElement>('[data-testid="overlay-card-region"]');
        expect(region).not.toBeNull();
        return region!;
      });
      expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
      expect(primary!.element.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(0);
      expect(
        movedRegion.querySelector('[data-testid="overlay-card-summary"]')
          ?.getAttribute("data-expanded"),
      ).toBe("true");
      expect(movedRegion.textContent).toContain("10분 전");
      expect(movedRegion.textContent).not.toContain("방금");
    } finally {
      restoreOverflow();
    }
  });
});

describe("a turn parked on an approval, with two tiles", () => {
  const request = (overrides: Record<string, unknown>) =>
    approvalRequest({
      id: "req-parked-turn",
      nonce: "nonce-parked-turn",
      hmac: "hmac-parked-turn",
      ...overrides,
    });
  const band = (tile: { element: HTMLElement }) =>
    tile.element.querySelector('[data-testid="approval-waiting-band"]');
  const dock = (within: HTMLElement) =>
    within.querySelectorAll('[data-testid="approval-dock"]');
  const laneCard = (within: HTMLElement) =>
    within.querySelectorAll('[data-testid="approval-lane-card"]');
  /** A plugin sidebar view, so the sidebar has a Plugins row to mark. */
  const pluginSidebarView = (pluginId: string, viewId: string) => ({
    pluginId,
    extension: { id: viewId, slot: "sidebar", kind: "embedded-module", title: "Inbox", entry: "ui/index.js", exportName: "mount" },
    entryUrl: "file:///plugins/example/dist/ui/index.js",
  });

  it("draws the card and the waiting band in the tile holding the session that asked, and nowhere else, until the card is answered", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ sessionId: `session-${second!.chatGroupId}` }));
    });

    await waitFor(() => expect(dock(second!.element)).toHaveLength(1));
    expect(dock(primary!.element)).toHaveLength(0);
    expect(dock(container)).toHaveLength(1);
    await waitFor(() => expect(band(second!)).not.toBeNull());
    expect(band(second!)!.getAttribute("data-tool-names")).toBe("read_file");
    expect(band(primary!)).toBeNull();

    const deny = second!.element.querySelector<HTMLButtonElement>('[data-testid="deny-button"]');
    expect(deny).not.toBeNull();
    await act(async () => {
      fireEvent.click(deny!);
    });

    await waitFor(() => expect(band(second!)).toBeNull());
    await waitFor(() => expect(dock(container)).toHaveLength(0));
  });

  it("calls the conversation by its title on the card, and keeps the id for the review details", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ sessionId: `session-${second!.chatGroupId}` }));
    });

    await waitFor(() => expect(dock(second!.element)).toHaveLength(1));
    const label = second!.element.querySelector('[data-testid="approval-conversation"]');
    expect(label?.textContent).not.toContain(`session-${second!.chatGroupId}`);
    expect(label?.textContent?.trim().length).toBeGreaterThan(0);
    expect(
      second!.element.querySelector('[data-testid="approval-conversation-id"]')?.textContent,
    ).toContain(`session-${second!.chatGroupId}`);
  });

  it("tells the waiting tile that its queued messages are held by the approval", async () => {
    const { container, api, emitApproval } = await renderApp({
      hasApiKey: true,
      lvisEnv: { isDev: true, isE2E: true },
    });
    const [primary, second] = await splitIntoTwoTiles(container);

    // A turn that never ends keeps the second tile streaming; the next Enter
    // there goes to the queue, not to the model.
    api.chatSend.mockImplementationOnce(() => new Promise(() => {}));
    await submitChatMessage(second!.element, "첫 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await submitChatMessage(second!.element, "이어서 부탁");
    await waitFor(() =>
      expect(second!.element.querySelector('[data-testid="message-queue-panel"]')).not.toBeNull(),
    );
    expect(second!.element.querySelector('[data-testid="message-queue-held-by-approval"]')).toBeNull();

    await act(async () => {
      emitApproval(request({ sessionId: `session-${second!.chatGroupId}` }));
    });

    await waitFor(() =>
      expect(second!.element.querySelector('[data-testid="message-queue-held-by-approval"]')).not.toBeNull(),
    );
    expect(primary!.element.querySelector('[data-testid="message-queue-panel"]')).toBeNull();
  });

  it("names what was blocked in that tile's transcript when the turn ends unanswered, and lets the dead card go", async () => {
    const { container, emitApproval, emitChatStream } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ sessionId: `session-${second!.chatGroupId}` }));
    });
    await waitFor(() => expect(band(second!)).not.toBeNull());

    // The host settled the ask (timeout) and the turn ended on a failed call.
    await act(async () => {
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      const notices = Array.from(second!.element.querySelectorAll('[data-testid="system-entry"]'));
      expect(notices.some((el) => el.textContent?.includes("read_file"))).toBe(true);
    });
    expect(
      Array.from(primary!.element.querySelectorAll('[data-testid="system-entry"]'))
        .some((el) => el.textContent?.includes("read_file")),
    ).toBe(false);
    expect(band(second!)).toBeNull();
    await waitFor(() => expect(dock(container)).toHaveLength(0));
  });

  it("brings a request the host was already parked on back after a reload, in the tile holding its session", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      pendingApprovals: [request({ sessionId: MOCK_DEFAULT_SESSION_ID })],
    });

    const [primary] = collectTiles(container);
    await waitFor(() => expect(band(primary!)).not.toBeNull());
    expect(band(primary!)!.getAttribute("data-tool-names")).toBe("read_file");
    await waitFor(() => expect(dock(primary!.element)).toHaveLength(1));
  });

  it("draws a request parked before this tile knew its session once: in the tile, never beside it in the lane", async () => {
    // A reload: the request comes back from the host before the primary tile
    // has loaded the session it names. Until then no surface holds that
    // session and no row lists it, so the focused pane's lane draws it as a
    // request without a conversation; once the tile knows its session it
    // claims the request, and the lane must let go of it.
    let resolveHistory!: (history: { sessionId: string; messages: never[] }) => void;
    const history = new Promise<{ sessionId: string; messages: never[] }>((resolve) => {
      resolveHistory = resolve;
    });
    const { container } = await renderApp({
      hasApiKey: true,
      history,
      pendingApprovals: [request({ sessionId: MOCK_DEFAULT_SESSION_ID })],
    });
    await waitFor(() => expect(laneCard(container)).toHaveLength(1));
    expect(dock(container)).toHaveLength(0);

    await act(async () => {
      resolveHistory({ sessionId: MOCK_DEFAULT_SESSION_ID, messages: [] });
    });
    const [primary] = collectTiles(container);
    await waitFor(() => expect(dock(primary!.element)).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(laneCard(container)).toHaveLength(0);
    expect(band(primary!)!.getAttribute("data-tool-names")).toBe("read_file");
  });

  it("draws a request that names no conversation as a lane card in the focused pane, covering no composer", async () => {
    const { container, emitApproval } = await renderApp({
      hasApiKey: true,
      pluginUiExtensions: [pluginSidebarView("mail-assistant", "inbox")],
    });
    const [primary, second] = await splitIntoTwoTiles(container);
    // Focus follows the split: the second pane is where the user is.
    await act(async () => {
      emitApproval(request({ id: "req-host" }));
    });

    await waitFor(() => expect(laneCard(second!.element)).toHaveLength(1));
    expect(laneCard(container)).toHaveLength(1);
    expect(laneCard(primary!.element)).toHaveLength(0);
    // Not a dock: nobody's turn is parked, so no composer is covered.
    expect(dock(container)).toHaveLength(0);
    expect(band(primary!)).toBeNull();
    expect(band(second!)).toBeNull();
    expect(second!.element.querySelector('[data-testid="approval-lane-card"]')!.textContent).toContain("호스트 요청");
    // The Plugins row says a request outside every conversation is waiting.
    expect(container.querySelector('[data-testid="sidebar-group-plugins-pending-answer"]')).not.toBeNull();
    for (const tile of [primary!, second!]) {
      const composer = tile.element.querySelector<HTMLElement>("[data-composer-placement]")!;
      expect(composer).not.toHaveAttribute("inert");
      const input = tile.element.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        input.focus();
      });
      expect(document.activeElement).toBe(input);
    }
  });

  it("moves the lane card with focus, and names the plugin that asked", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ id: "req-plugin", sourcePluginId: "mail-assistant" }));
    });
    await waitFor(() => expect(laneCard(second!.element)).toHaveLength(1));
    expect(second!.element.querySelector('[data-testid="approval-lane-card"]')!.textContent)
      .toContain("플러그인 요청 · mail-assistant");
    // In the frame's lane — the same place an unowned overlay card is drawn.
    expect(laneCard(container)[0]!.closest('[data-testid="floating-right-lane"]')).not.toBeNull();

    // One reader, the user, who is at the focused pane: focus moving moves it.
    await focusTile(primary!);
    await waitFor(() => expect(laneCard(primary!.element)).toHaveLength(1));
    expect(laneCard(second!.element)).toHaveLength(0);
    expect(laneCard(container)).toHaveLength(1);
    // No window band exists to fall back to.
    expect(container.querySelector('[data-testid="window-approval-scope"]')).toBeNull();
  });

  it("keeps a maximized-away pane's approval in that pane, undrawn, and marks the way back", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    await focusTile(primary!);

    await act(async () => {
      emitApproval(request({ sessionId: `session-${second!.chatGroupId}` }));
    });
    await waitFor(() => expect(dock(second!.element)).toHaveLength(1));
    expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).toBeNull();

    // The primary pane takes the canvas: the second is in the tree but drawn
    // nowhere. Its card is its own — not moved to the pane the user is in,
    // not drawn into a box nobody sees. The maximize control, the one way
    // back to the hidden pane, says something is waiting there.
    await toggleTileMaximized(primary!);
    await waitFor(() => {
      expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).not.toBeNull();
    });
    expect(dock(container)).toHaveLength(0);
    expect(laneCard(container)).toHaveLength(0);
    expect(container.querySelector('[data-testid="window-approval-scope"]')).toBeNull();

    // Restoring the split draws the pane, and the card with it, where it was.
    await toggleTileMaximized(primary!);
    const restored = collectTiles(container).find((tile) => tile.chatGroupId === second!.chatGroupId)!;
    await waitFor(() => expect(dock(restored.element)).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).toBeNull();
  });

  it("draws a side chat's approval over the side composer, and marks the panel toggle and the tab while it is out of sight", async () => {
    const { container, api, emitApproval } = await renderApp({ hasApiKey: true, sideChat: true });
    const toggle = () => container.querySelector<HTMLButtonElement>(testIdSelector(TEST_IDS.panePanelToggle))!;
    await act(async () => { fireEvent.click(toggle()); });
    await act(async () => {
      fireEvent.click(container.querySelector(`[data-testid="${chatSidePanelLauncherTestId("side-chat")}"]`)!);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="side-chat-new"]')!);
    });
    await waitFor(() => expect(api.sideChat!.new).toHaveBeenCalled());

    // The side loop's turn parks: the card is the side chat's, over its composer.
    await act(async () => {
      emitApproval(request({ id: "req-side", sessionId: MOCK_SIDE_CHAT_SESSION_ID }));
    });
    const sideView = () => container.querySelector<HTMLElement>('[data-testid="side-chat-view"]')!;
    await waitFor(() => expect(dock(sideView())).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(container.querySelector('[data-testid="pane-panel-toggle-pending-answer"]')).toBeNull();

    // Another tab in front of it: the card stays with the side chat; the tab
    // says so.
    const add = container.querySelector<HTMLElement>('[data-testid="chat-side-panel-add-tab"]')!;
    await act(async () => {
      fireEvent.pointerDown(add, { button: 0 });
      fireEvent.click(add);
    });
    await act(async () => {
      fireEvent.click(await waitFor(() => {
        const item = container.querySelector<HTMLElement>(`[data-testid="${chatSidePanelLauncherTestId("menu-browser")}"]`)
          ?? document.querySelector<HTMLElement>(`[data-testid="${chatSidePanelLauncherTestId("menu-browser")}"]`);
        expect(item).not.toBeNull();
        return item!;
      }));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="chat-side-panel-tab-side-chat-pending-answer"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="pane-panel-toggle-pending-answer"]')).not.toBeNull();

    // The panel closed: the toggle is the way back, and it says so too.
    await act(async () => { fireEvent.click(toggle()); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="pane-panel-toggle-pending-answer"]')).not.toBeNull();
    });
    // No composer in the tile is covered by a card that is not its own.
    const tileComposer = container.querySelector<HTMLElement>('[data-testid="chat-main-column"] [data-composer-placement]')!;
    expect(tileComposer).not.toHaveAttribute("inert");

    // Open again, back on the side-chat tab: the card is on screen, no dot.
    await act(async () => { fireEvent.click(toggle()); });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="chat-side-panel-tab-side-chat"]')!);
    });
    await waitFor(() => expect(dock(sideView())).toHaveLength(1));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="pane-panel-toggle-pending-answer"]')).toBeNull();
    });
    expect(container.querySelector('[data-testid="chat-side-panel-tab-side-chat-pending-answer"]')).toBeNull();
  });

  it("takes the lane card down when the host retires the request", async () => {
    const { container, emitApproval, emitApprovalSettled } = await renderApp({ hasApiKey: true });
    await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ id: "req-host" }));
    });
    await waitFor(() => expect(laneCard(container)).toHaveLength(1));

    // The tile that asked closed, so the host cancelled the ask. Nothing in
    // this window watches that turn any more — the announcement is the only
    // thing that can retire the card, and its deny would answer nothing.
    await act(async () => {
      emitApprovalSettled("req-host");
    });

    await waitFor(() => expect(laneCard(container)).toHaveLength(0));
  });
});

describe("cards raised by one of three tiles", () => {
  const request = (overrides: Record<string, unknown>) =>
    approvalRequest({
      id: "req-middle-tile",
      toolName: "write_file",
      toolCategory: "write",
      args: { path: "/tmp/out.md" },
      reason: "write the summary",
      nonce: "nonce-middle-tile",
      hmac: "hmac-middle-tile",
      ...overrides,
    });
  const dock = (within: HTMLElement) =>
    within.querySelectorAll('[data-testid="approval-dock"]');
  const composer = (tile: { element: HTMLElement }) =>
    tile.element.querySelector<HTMLElement>('[data-composer-placement]');
  const textarea = (tile: { element: HTMLElement }) =>
    tile.element.querySelector<HTMLTextAreaElement>("textarea");
  const band = (tile: { element: HTMLElement }) =>
    tile.element.querySelector('[data-testid="approval-waiting-band"]');
  const tileCell = (node: Element) =>
    node.closest<HTMLElement>('[data-testid^="pane-cell:"]');
  /**
   * The tiles that did not ask: nothing covers them, their composers are not
   * inert, and each takes the keyboard — focus lands, typed text stays.
   */
  const expectUntouched = async (...others: Array<{ element: HTMLElement }>) => {
    for (const tile of others) {
      expect(tile.element.querySelectorAll(BLOCKING_SURFACE_SELECTOR)).toHaveLength(0);
      expect(composer(tile)).not.toHaveAttribute("inert");
      const input = textarea(tile)!;
      await act(async () => {
        input.focus();
      });
      expect(document.activeElement).toBe(input);
      fireEvent.change(input, { target: { value: "옆 타일은 계속 입력" } });
      expect(input.value).toBe("옆 타일은 계속 입력");
    }
  };

  it("shows the approval card in the tile that asked, while the other two keep their composers, their focus, and their turns", async () => {
    const { container, api, emitApproval } = await renderApp({ hasApiKey: true });
    const [first, middle, third] = await splitIntoThreeTiles(container);

    // The user is typing in the first tile when the middle tile's turn asks.
    await focusTile(first!);
    await act(async () => {
      textarea(first!)!.focus();
    });
    expect(document.activeElement).toBe(textarea(first!));

    await act(async () => {
      emitApproval(request({ sessionId: `session-${middle!.chatGroupId}` }));
    });

    await waitFor(() => expect(dock(middle!.element)).toHaveLength(1));
    expect(dock(first!.element)).toHaveLength(0);
    expect(dock(third!.element)).toHaveLength(0);
    expect(dock(container)).toHaveLength(1);

    // No focus steal: the caret stays where the user was typing.
    expect(document.activeElement).toBe(textarea(first!));
    // The card's nearest tile ancestor is the tile that asked.
    expect(tileCell(dock(container)[0]!)).toBe(middle!.element);
    // Only the covered composer is inert; the other two accept input.
    expect(composer(middle!)).toHaveAttribute("inert");
    await expectUntouched(first!, third!);

    // Both neighbours run a turn while the middle tile waits.
    await submitChatMessage(first!.element, "첫 타일 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await focusTile(third!);
    await submitChatMessage(third!.element, "셋째 타일 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));
    expect(dock(middle!.element)).toHaveLength(1);

    // Answering in the middle tile clears its card and frees its composer.
    const approve = middle!.element.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
    expect(approve).not.toBeNull();
    await act(async () => {
      fireEvent.click(approve!);
    });
    await waitFor(() => expect(dock(container)).toHaveLength(0));
    await waitFor(() => expect(composer(middle!)).not.toHaveAttribute("inert"));
  });

  it("shows a user-question card in the tile that asked, and only there, while another tile runs a turn", async () => {
    const { container, api, emitAskUserQuestion } = await renderApp({ hasApiKey: true });
    const [first, middle, third] = await splitIntoThreeTiles(container);

    // The user is typing in the first tile when the middle tile's turn asks.
    await focusTile(first!);
    await act(async () => {
      textarea(first!)!.focus();
    });
    expect(document.activeElement).toBe(textarea(first!));

    await act(async () => {
      emitAskUserQuestion({
        id: "ask-middle",
        sessionId: `session-${middle!.chatGroupId}`,
        questions: [{ question: "어느 형식으로 정리할까요?", choices: ["표", "목록"] }],
        createdAt: Date.now(),
      });
    });

    const question = (tile: { element: HTMLElement }) =>
      tile.element.querySelector('[data-testid="question-overlay"]');
    await waitFor(() => expect(question(middle!)).not.toBeNull());
    expect(tileCell(question(middle!)!)).toBe(middle!.element);
    expect(container.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(1);
    // The card seats its first answer a frame after mounting; let that frame
    // pass, then the caret must still be where the user was typing.
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(textarea(first!));
    await expectUntouched(first!, third!);

    await focusTile(first!);
    await submitChatMessage(first!.element, "첫 타일은 계속 진행");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    expect(question(middle!)).not.toBeNull();
    expect(question(first!)).toBeNull();
  });

  it("shows the sub-agent spawn card in the tile that asked, and only there", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [first, middle, third] = await splitIntoThreeTiles(container);

    await focusTile(first!);
    await act(async () => {
      textarea(first!)!.focus();
    });

    // `agent_spawn` asks by contract; its card is an approval card raised by
    // the turn that is spawning, so it belongs to that turn's tile.
    await act(async () => {
      emitApproval(request({
        id: "req-spawn-middle",
        toolName: "agent_spawn",
        toolCategory: "meta",
        args: { title: "메모 정리", instructions: "메모를 한 줄로 정리해" },
        reason: "spawn a sub-agent for the summary",
        nonce: "nonce-spawn-middle",
        hmac: "hmac-spawn-middle",
        sessionId: `session-${middle!.chatGroupId}`,
      }));
    });

    await waitFor(() => expect(dock(middle!.element)).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(tileCell(dock(container)[0]!)).toBe(middle!.element);
    expect(band(middle!)?.getAttribute("data-tool-names")).toBe("agent_spawn");
    expect(band(first!)).toBeNull();
    expect(band(third!)).toBeNull();

    expect(document.activeElement).toBe(textarea(first!));
    expect(composer(middle!)).toHaveAttribute("inert");
    await expectUntouched(first!, third!);
  });

  it("brings a spawn card the host was parked on back after a reload, into the tile holding its session", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      pendingApprovals: [request({
        id: "req-spawn-parked",
        toolName: "agent_spawn",
        toolCategory: "meta",
        args: { title: "메모 정리", instructions: "메모를 한 줄로 정리해" },
        sessionId: MOCK_DEFAULT_SESSION_ID,
      })],
    });
    const [primary, second] = await splitIntoTwoTiles(container);

    await waitFor(() => expect(dock(primary!.element)).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(band(primary!)?.getAttribute("data-tool-names")).toBe("agent_spawn");
    await expectUntouched(second!);
  });
});

describe("the skill badge with three tiles", () => {
  it("draws the badge in the tile whose turn loaded the skill, and nowhere else", async () => {
    const { container, emitSkillLoaded } = await renderApp({ hasApiKey: true });
    const [first, middle, third] = await splitIntoThreeTiles(container);
    const badges = (tile: { element: HTMLElement }) =>
      tile.element.querySelectorAll('[data-testid="skill-badge"]');

    // `lvis:skill-load:event` is window-wide and carries the session the tool
    // ran in. The tile that owns that session is the one that loaded the
    // skill; without the guard every open tile would grow the same badge.
    await act(async () => {
      emitSkillLoaded({
        name: "release-notes",
        description: "write the release notes",
        sessionId: `session-${middle!.chatGroupId}`,
      });
    });

    await waitFor(() => expect(badges(middle!)).toHaveLength(1));
    expect(container.querySelectorAll('[data-testid="skill-badge"]')).toHaveLength(1);
    expect(badges(first!)).toHaveLength(0);
    expect(badges(third!)).toHaveLength(0);
  });
});

/**
 * The whole directive at once, with three tiles: everything a session raises
 * belongs to that session's tile, and everything no session raised is drawn
 * once in the window's own chrome.
 */
describe("three tiles, every kind of surface at once", () => {
  it("puts each surface on exactly one tile, and what no tile owns in the window", async () => {
    const { container, api, emitApproval, emitAskUserQuestion, emitSkillLoaded, emitRoutineFired } =
      await renderApp({ hasApiKey: true });
    const [first, middle, third] = await splitIntoThreeTiles(container);
    const onHit = permissionSubscription(api, "onUserApprovalHit");
    const middleSession = `session-${middle!.chatGroupId}`;
    const count = (root: HTMLElement, testId: string) =>
      root.querySelectorAll(`[data-testid="${testId}"]`).length;

    // The middle tile's turn parks on an approval and loads a skill; a routine
    // fires with no tile behind it; the window's permission setting reports a
    // memory hit.
    await act(async () => {
      emitApproval({
        id: "req-acceptance",
        category: "tool",
        toolName: "write_file",
        toolCategory: "write",
        args: { path: "/tmp/out.md" },
        reason: "write the summary",
        createdAt: Date.now(),
        requireExplicit: true,
        sessionId: middleSession,
        nonce: "nonce-acceptance",
        hmac: "hmac-acceptance",
      });
      emitSkillLoaded({
        name: "release-notes",
        description: "write the release notes",
        sessionId: middleSession,
      });
      emitRoutineFired({
        id: "schedule-daily",
        trigger: "schedule",
        firedAt: new Date().toISOString(),
        title: "Daily schedule",
        summary: "daily summary",
      });
      (onHit.mock.calls[0]?.[0] as (payload: {
        toolName: string;
        scope: "session" | "persistent";
        verdictAtApproval: "low" | "medium" | "high";
      }) => void)({ toolName: "fs_write", scope: "persistent", verdictAtApproval: "low" });
    });

    // One of each, window-wide.
    await waitFor(() => expect(count(container, "approval-dock")).toBe(1));
    await waitFor(() => expect(count(container, "user-approval-hit-toast")).toBe(1));
    expect(count(container, "skill-badge")).toBe(1);
    expect(count(container, "overlay-card-region")).toBe(1);

    // The approval card that just landed in the middle tile takes focus with
    // it; the user goes back to the third tile, and the routine card — drawn
    // where the user is — goes with them.
    await focusTile(third!);

    // The two the middle tile's turn raised are inside the middle tile.
    expect(count(middle!.element, "approval-dock")).toBe(1);
    expect(count(middle!.element, "skill-badge")).toBe(1);
    // The routine belongs to no conversation, so it is drawn in the focused
    // tile — exactly one tile draws it, and the window draws none. Naming the
    // tile is the point: "exactly one tile draws it" would pass with the card
    // on the wrong tile, which is the whole subject here.
    await waitFor(() => expect(count(third!.element, "overlay-card-region")).toBe(1));
    expect(count(first!.element, "overlay-card-region")).toBe(0);
    expect(count(middle!.element, "overlay-card-region")).toBe(0);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();

    // While the middle tile waits, a question for it lands there too — and the
    // other two are still running turns of their own.
    await act(async () => {
      emitAskUserQuestion({
        id: "ask-acceptance",
        sessionId: middleSession,
        questions: [{ question: "어느 쪽으로 갈까요?", choices: ["A", "B"] }],
      });
    });
    await waitFor(() => expect(count(middle!.element, "question-overlay")).toBe(1));
    expect(count(container, "question-overlay")).toBe(1);

    await submitChatMessage(first!.element, "첫 타일 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await focusTile(third!);
    await submitChatMessage(third!.element, "셋째 타일 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));

    // Nothing the middle tile raised reached its neighbours, and the routine
    // card is where focus ended up: the third tile, and only there.
    const focused = third!;
    for (const tile of [first!, third!]) {
      expect(tile.element.querySelectorAll(BLOCKING_SURFACE_SELECTOR)).toHaveLength(0);
      expect(count(tile.element, "skill-badge")).toBe(0);
      expect(count(tile.element, "user-approval-hit-toast")).toBe(0);
      expect(count(tile.element, "overlay-card-region")).toBe(tile === focused ? 1 : 0);
    }
    expect(count(focused.element, "overlay-card-region")).toBe(1);
    expect(count(container, "overlay-card-region")).toBe(1);
  });
});

/**
 * Reaching a conversation from the sidebar while another one is mid-turn.
 *
 * A running turn writes through the loop that owns it, and main rewrites the
 * whole session file from that loop's in-memory history — so the session under
 * a running loop cannot be swapped. What used to happen instead is that the
 * sidebar went dead: every row disabled, no toast, and on a plugin panel (where
 * no row counts as active) not even the streaming conversation's own row was
 * clickable. The conversation is given a group of its own now.
 */
describe("opening a conversation while another is mid-turn", () => {
  const OTHER_SESSION = "sess-other";
  const withOtherSession = {
    hasApiKey: true,
    sessions: [
      { id: MOCK_DEFAULT_SESSION_ID, title: "지금 답하는 중", modifiedAt: new Date(2, 0, 2).toISOString() },
      { id: OTHER_SESSION, title: "다른 대화", modifiedAt: new Date(2, 0, 1).toISOString() },
    ],
  };

  const sessionRow = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-testid="sidebar-session-${id}"]`) as HTMLButtonElement | null;

  /**
   * Chat mode starts with the rail collapsed, which hides the session list. The
   * user in the report had it open — expanding it is part of reproducing them.
   */
  const expandSidebar = async (container: HTMLElement) => {
    const toggle = container.querySelector('[data-testid="sidebar-collapse-toggle"]') as HTMLButtonElement | null;
    if (!toggle || toggle.getAttribute("aria-pressed") === "true") return;
    await act(async () => { fireEvent.click(toggle); });
  };

  const rowFor = (container: HTMLElement, id: string) => waitFor(() => {
    const found = sessionRow(container, id);
    if (!found) throw new Error(`sidebar row for ${id} not rendered`);
    return found;
  });


  it("chat mode: adopts the conversation without splitting the canvas", async () => {
    const restoreMode = startInChatMode();
    try {
      const pendingSend = deferred<{ ok: true }>();
      const { container, api, releasedGroupIds } = await renderApp(withOtherSession);
      api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

      await submitChatMessage(container, "아직 답하는 중");
      await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
      await expandSidebar(container);

      const row = await rowFor(container, OTHER_SESSION);
      // A row that is not the streaming conversation stays live: one tile's
      // turn is not a reason to lock every other conversation away.
      expect(row.disabled).toBe(false);
      await act(async () => { fireEvent.click(row); });

      await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith(OTHER_SESSION));
      // The adopted conversation got a group of its own, and chat mode draws
      // only the focused one — so the canvas still shows a single tile. This is
      // the whole point: the user asked to READ another conversation, not to
      // rearrange the screen.
      const tiles = collectTiles(container);
      expect(tiles).toHaveLength(1);
      expect(tiles[0]!.chatGroupId).not.toBe(MAIN_CHAT_GROUP_ID);
      // The displaced group is HIDDEN, not gone: its tile stays mounted so the
      // running turn keeps its stream subscription, its streaming flag and its
      // stop control. Unmounting it would drop the frames on the floor and stop
      // the sidebar saying that conversation is running.
      expect(mountedTileIds(container)).toContain(MAIN_CHAT_GROUP_ID);
      // …and nothing released its loop to make room.
      expect(releasedGroupIds()).toEqual([]);

      await act(async () => {
        pendingSend.resolve({ ok: true });
        await pendingSend.promise;
      });
    } finally {
      restoreMode();
    }
  });

  it("work mode: the adopted conversation is a second tile, which is what that mode means", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api } = await renderApp(withOtherSession);
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });

    await waitFor(() => expect(collectTiles(container)).toHaveLength(2));
    const ids = collectTiles(container).map((tile) => tile.chatGroupId);
    expect(ids).toContain(MAIN_CHAT_GROUP_ID);
    // The second tile has to actually HOLD the conversation that was asked for.
    // A tile that merely appeared would lose the click's whole purpose.
    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith(OTHER_SESSION));
    await waitFor(() => expect(api.chatSessionHistory).toHaveBeenCalledWith(OTHER_SESSION));

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("stays reachable from a view that is not the conversation surface", async () => {
    // The reported dead end. Off the chat surface NO row counts as active, and
    // the old guard was `streaming && !active` — so a plugin panel (or any
    // other view) turned every row off, including the row of the conversation
    // that was streaming. There was no way back to it at all.
    const pendingSend = deferred<{ ok: true }>();
    const { container, api } = await renderApp(withOtherSession);
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    // The streaming conversation's row starts marked as the one on screen.
    const own = await rowFor(container, MOCK_DEFAULT_SESSION_ID);
    expect(own.getAttribute("aria-current")).toBe("page");

    // Leave the conversation surface. Settings has the same shape as the plugin
    // panel from the report: an inline view that is not "home", so no row is
    // "active" any more — which is exactly what the old guard keyed off.
    const settings = container.querySelector('[data-testid="sidebar-settings"]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(settings); });
    await waitFor(() => {
      expect(sessionRow(container, MOCK_DEFAULT_SESSION_ID)!.getAttribute("aria-current")).toBeNull();
    });

    const offSurface = await rowFor(container, MOCK_DEFAULT_SESSION_ID);
    const other = await rowFor(container, OTHER_SESSION);
    expect(offSurface.disabled).toBe(false);
    expect(other.disabled).toBe(false);

    // Clicking back into the streaming conversation returns to it.
    await act(async () => { fireEvent.click(offSurface); });
    await waitFor(() => {
      expect(sessionRow(container, MOCK_DEFAULT_SESSION_ID)!.getAttribute("aria-current")).toBe("page");
    });

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("refuses out loud when every other conversation is busy, and never evicts the primary", async () => {
    const { container, api, releasedGroupIds } = await renderApp(withOtherSession);
    const pending: Array<{ resolve: (value: { ok: true }) => void }> = [];
    api.chatSend.mockImplementation(async () => {
      const gate = deferred<{ ok: true }>();
      pending.push(gate);
      return gate.promise;
    });

    // Fill the window to the ceiling, then put every conversation mid-turn.
    const tiles = await splitIntoNTiles(container, MAX_CHAT_GROUPS);
    expect(tiles).toHaveLength(MAX_CHAT_GROUPS);
    for (const [index, tile] of tiles.entries()) {
      await focusTile(tile);
      await submitChatMessage(tile.element, `${index + 1}번째`);
    }
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(MAX_CHAT_GROUPS));

    const before = mountedTileIds(container);
    expect(before).toHaveLength(MAX_CHAT_GROUPS);
    api.chatSessionResume.mockClear();

    await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });

    // Nothing was released to make room — least of all the primary, whose
    // release also points its loop at a fresh conversation and clears the
    // persisted window-active session.
    expect(releasedGroupIds()).toEqual([]);
    expect(mountedTileIds(container)).toEqual(before);
    expect(api.chatSessionResume).not.toHaveBeenCalled();
    // And the user is told, because nothing in this gesture shows the limit the
    // way a missing drop edge does.
    await waitFor(() => expect(container.textContent).toContain("비워 둘 수 있는 대화가 없습니다"));

    await act(async () => {
      for (const gate of pending) gate.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("clicking the streaming conversation's own row is navigation, not a load", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api } = await renderApp(withOtherSession);
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    api.chatSessionResume.mockClear();

    const row = await rowFor(container, MOCK_DEFAULT_SESSION_ID);
    expect(row.disabled).toBe(false);
    await act(async () => { fireEvent.click(row); });

    // The tile already holds it, so there is nothing to load and nothing to
    // adopt — asking main would only earn a refusal for a conversation the
    // window is already showing. This is the click that used to dead-end from
    // a plugin panel, where no row counts as active.
    expect(api.chatSessionResume).not.toHaveBeenCalled();
    expect(collectTiles(container)).toHaveLength(1);
    expect(collectTiles(container)[0]!.chatGroupId).toBe(MAIN_CHAT_GROUP_ID);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("keeps a hidden tile's card with it, undrawn, and marks its sidebar row", async () => {
    const restoreMode = startInChatMode();
    try {
      const pendingSend = deferred<{ ok: true }>();
      const { container, api, emitOverlayShow } = await renderApp(withOtherSession);
      api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

      await submitChatMessage(container, "아직 답하는 중");
      await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
      await expandSidebar(container);
      await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });
      await waitFor(() => expect(mountedTileIds(container).length).toBe(2));

      // The primary tile now holds its conversation without drawing it. A card
      // for that conversation must not be handed to it: `display:none` would
      // swallow the one surface the parked turn can be answered from.
      await act(async () => {
        emitOverlayShow({
          id: "app:invoices:hidden",
          source: { kind: "app", serverId: "invoices", eventId: "hidden" },
          originSessionId: MOCK_DEFAULT_SESSION_ID,
          title: "invoices",
          summary: "숨은 타일의 카드",
          running: false,
          pendingPrompt: '<app-message source="app:invoices">\n숨은 타일의 카드\n</app-message>',
          createdAt: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(container.querySelector(`[data-testid="sidebar-pending-answer-${MOCK_DEFAULT_SESSION_ID}"]`)).not.toBeNull();
      });
      expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();
      expect(container.textContent).not.toContain("숨은 타일의 카드");
      const hiddenTile = container.querySelector<HTMLElement>(
        `[data-testid="pane-cell:${MAIN_CHAT_GROUP_ID}"]`,
      );
      expect(hiddenTile?.getAttribute("data-hidden")).toBe("true");

      await act(async () => {
        pendingSend.resolve({ ok: true });
        await pendingSend.promise;
      });
    } finally {
      restoreMode();
    }
  });

  it("keeps a hidden tile's question parked in it, and marks its sidebar row", async () => {
    const restoreMode = startInChatMode();
    try {
      const pendingSend = deferred<{ ok: true }>();
      const { container, api, emitAskUserQuestion } = await renderApp(withOtherSession);
      api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

      await submitChatMessage(container, "아직 답하는 중");
      await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

      // The gate arrives while the tile is still drawn, so the tile takes it —
      // it is the only surface that ever receives it.
      await act(async () => {
        emitAskUserQuestion({
          id: "ask-before-hide",
          sessionId: MOCK_DEFAULT_SESSION_ID,
          questions: [{ question: "어느 형식으로 정리할까요?", choices: ["표", "목록"] }],
          createdAt: Date.now(),
        });
      });
      await waitFor(() => {
        expect(container.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(1);
      });

      await expandSidebar(container);
      await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });
      await waitFor(() => expect(mountedTileIds(container).length).toBe(2));

      const hiddenTile = container.querySelector<HTMLElement>(
        `[data-testid="pane-cell:${MAIN_CHAT_GROUP_ID}"]`,
      )!;
      expect(hiddenTile.getAttribute("data-hidden")).toBe("true");
      // The question is that conversation's, so it stays with it — not drawn
      // into a surface nobody can see, not handed to the tile that is. The
      // way to it is the row, which says something is waiting there.
      await waitFor(() => {
        expect(container.querySelector(`[data-testid="sidebar-pending-answer-${MOCK_DEFAULT_SESSION_ID}"]`)).not.toBeNull();
      });
      expect(container.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(0);
      expect(hiddenTile.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(0);
      expect(container.querySelector('[data-testid="window-approval-scope"]')).toBeNull();

      await act(async () => {
        pendingSend.resolve({ ok: true });
        await pendingSend.promise;
      });
    } finally {
      restoreMode();
    }
  });

  it("keeps a hidden tile's approval parked in it, and marks its sidebar row", async () => {
    const restoreMode = startInChatMode();
    try {
      const pendingSend = deferred<{ ok: true }>();
      const { container, api, emitApproval } = await renderApp(withOtherSession);
      api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

      await submitChatMessage(container, "아직 답하는 중");
      await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
      await expandSidebar(container);
      await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });
      await waitFor(() => expect(mountedTileIds(container).length).toBe(2));

      // The turn that is still running is the reason the tile stays mounted —
      // and a running turn parks on approvals. The tile keeps the request but
      // draws nothing inside `display:none`; the row's dot is what says the
      // turn is waiting, and opening the row is what brings the card back.
      await act(async () => {
        emitApproval({
          id: "req-hidden-tile",
          category: "tool",
          toolName: "read_file",
          toolCategory: "read",
          args: { path: "/tmp/notes.md" },
          reason: "read the notes",
          createdAt: Date.now(),
          requireExplicit: false,
          nonce: "nonce-hidden-tile",
          hmac: "hmac-hidden-tile",
          sessionId: MOCK_DEFAULT_SESSION_ID,
        });
      });

      const hiddenTile = container.querySelector<HTMLElement>(
        `[data-testid="pane-cell:${MAIN_CHAT_GROUP_ID}"]`,
      )!;
      expect(hiddenTile.getAttribute("data-hidden")).toBe("true");
      await waitFor(() => {
        expect(container.querySelector(`[data-testid="sidebar-pending-answer-${MOCK_DEFAULT_SESSION_ID}"]`)).not.toBeNull();
      });
      expect(container.querySelectorAll('[data-testid="approval-dock"]')).toHaveLength(0);
      expect(container.querySelectorAll('[data-testid="approval-lane-card"]')).toHaveLength(0);

      await act(async () => {
        pendingSend.resolve({ ok: true });
        await pendingSend.promise;
      });
    } finally {
      restoreMode();
    }
  });

  it("a conversation dropped on a mid-turn tile's centre gets its own group", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api } = await renderApp(withOtherSession);
    const [, second] = await splitIntoTwoTiles(container);
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await focusTile(second!);
    await submitChatMessage(second!.element, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    api.chatSessionResume.mockClear();

    // A centre drop asks the tile to SHOW this conversation, which is the one
    // thing a mid-turn tile cannot do — the same refusal the sidebar hit.
    const frame = second!.element.querySelector('[data-testid="pane"]')!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    // jsdom drops the pointer coordinates a drag carries, and the coordinates
    // ARE the gesture — so they are set on the event itself.
    const drop = createEvent.drop(frame, {
      // `files` too: the window's file-drop guard reads it on every drop.
      dataTransfer: {
        types: [CHAT_SESSION_DRAG_TYPE], getData: () => OTHER_SESSION, dropEffect: "none", files: [],
      },
    });
    Object.defineProperty(drop, "clientX", { value: 400 });
    Object.defineProperty(drop, "clientY", { value: 300 });
    await act(async () => { fireEvent(frame, drop); });

    await waitFor(() => expect(mountedTileIds(container)).toHaveLength(3));
    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith(OTHER_SESSION));

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("releases the loop of the group it set aside, and says so", async () => {
    const { container, api, releasedGroupIds } = await renderApp(withOtherSession);
    const pending: Array<{ resolve: (value: { ok: true }) => void }> = [];
    api.chatSend.mockImplementation(async () => {
      const gate = deferred<{ ok: true }>();
      pending.push(gate);
      return gate.promise;
    });

    const tiles = await splitIntoNTiles(container, MAX_CHAT_GROUPS);
    // Two conversations mid-turn — the primary, which the click will target,
    // and one neighbour. The other two are idle and can be set aside.
    await focusTile(tiles[1]!);
    await submitChatMessage(tiles[1]!.element, "옆 타일");
    await focusTile(tiles[0]!);
    await submitChatMessage(tiles[0]!.element, "여기도 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));

    await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });

    const released = releasedGroupIds();
    expect(released).toHaveLength(1);
    // Not the primary, not the busy neighbour, and not the group just created
    // for the incoming conversation — releasing any of those either aborts a
    // turn or throws away the tile that was just made.
    expect(released[0]).not.toBe(MAIN_CHAT_GROUP_ID);
    expect(released[0]).not.toBe(tiles[1]!.chatGroupId);
    expect([tiles[2]!.chatGroupId, tiles[3]!.chatGroupId]).toContain(released[0]);
    expect(mountedTileIds(container)).not.toContain(released[0]);
    expect(mountedTileIds(container)).toHaveLength(MAX_CHAT_GROUPS);
    // Making room costs a tile the user did not ask to lose, from a click that
    // looked like plain navigation.
    await waitFor(() => expect(container.textContent).toContain("자리를 만들기 위해"));

    await act(async () => {
      for (const gate of pending) gate.resolve({ ok: true });
      await Promise.resolve();
    });
  });
});
