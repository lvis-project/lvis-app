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
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import {
  collectTiles,
  focusTile,
  forceOverflowingSummaries,
  splitIntoThreeTiles,
  splitIntoTwoTiles,
  submitChatMessage,
  deferred,
  toggleTileMaximized,
} from "./helpers.js";
import { MOCK_DEFAULT_SESSION_ID, type MockLvisApi } from "./mock-lvis-api.js";
import { MAIN_CHAT_GROUP_ID } from "../../src/contract/app-contract.js";
import { BLOCKING_SURFACE_SELECTOR } from "../../src/shared/test-ids.js";

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

  it("draws a routine card once in the tile it arrived over, and does not move it when focus moves", async () => {
    const { container, emitRoutineFired } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    // Focus follows the split, so the second tile is the one the card arrives
    // over. A routine turn runs in no tile, but confirming its card starts a
    // turn in one, so the card is pinned to the tile that shows it.
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

    // The pin was taken once, on arrival. Reading live focus instead would
    // slide the card out from under the user mid-read, and the turn would
    // start in whichever tile focus had reached by the click.
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
    expect(overlayRegions(second!)).toHaveLength(1);
    expect(overlayRegions(primary!)).toHaveLength(0);
  });

  it("keeps a routine card on its tile when the result replaces the spinner", async () => {
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

    // The result REPLACES the spinner in the queue. If the pin were taken per
    // push rather than per slot, the replacement would carry the card to
    // whichever tile focus had reached.
    await waitFor(() => expect(second!.element.textContent).toContain("daily summary"));
    expect(overlayRegions(second!)).toHaveLength(1);
    expect(overlayRegions(primary!)).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
  });

  it("starts the confirmed turn in the tile that showed the card, not the focused one", async () => {
    const { container, api, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitOverlayShow({
        id: "plugin:notes:pinned",
        source: { kind: "plugin", pluginId: "notes", eventId: "pinned" },
        title: "notes",
        summary: "pinned target",
        running: false,
        pendingPrompt: "<untrusted-plugin>notes</untrusted-plugin>",
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

    // Focus moves between the card appearing and the click. The turn belongs to
    // the conversation the card was shown over.
    await focusTile(primary!);
    await act(async () => {
      fireEvent.click(confirm);
    });

    // The staged prompt is inserted through the TILE's own handle, so the
    // transcript it lands in is the answer to "which conversation ran it".
    await waitFor(() => expect(second!.element.textContent).toContain("pinned target"));
    expect(primary!.element.textContent).not.toContain("pinned target");
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
      // Wherever the card was pinned, there is exactly one of it to dismiss.
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

  it("shows the card in the window's chrome without its action, and restores the action with the tile", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    await focusTile(primary!);

    await act(async () => {
      emitOverlayShow(appCard("app:invoices:e3", `session-${second!.chatGroupId}`, "reconcile the ledger"));
    });
    await waitFor(() => {
      expect(second!.element.querySelector('[data-testid="overlay-card-region"]')).not.toBeNull();
    });

    // Showing only the primary tile unmounts the tile holding the card's
    // conversation. Nothing owns the card now, so it falls to the window's own
    // region — it must not vanish with the tile, and must not become
    // actionable in a conversation it was never staged for.
    await toggleTileMaximized(primary!);
    const maximized = await waitFor(() => {
      const region = container.querySelector<HTMLElement>('[data-testid="overlay-card-region"]');
      expect(region).not.toBeNull();
      return region!;
    });
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
    expect(maximized).toHaveAttribute("data-overlay-surface", "window");
    expect(maximized.querySelector('[data-testid="overlay-card-primary-action"]')).toBeNull();
    expect(maximized.querySelector('[data-testid="overlay-card-notice"]')).not.toBeNull();
    expect(maximized.querySelector('[data-testid="routine-card-dismiss"]')).not.toBeNull();

    // Restoring the split brings the origin conversation back, and with it the
    // action — which runs in that conversation, not the focused one.
    await toggleTileMaximized(primary!);
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

    // Two with no origin — both pinned to the focused tile — and one for the
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

describe("a card pinned to a tile stays put when focus moves", () => {
  it("keeps the expanded summary and the original timestamp across a focus change", async () => {
    const restoreOverflow = forceOverflowingSummaries();
    try {
      const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
      const [primary, second] = await splitIntoTwoTiles(container);
      await focusTile(primary!);

      // No origin, so the card is pinned to the tile it arrived over — the
      // primary here. Moving focus neither moves it nor remounts it.
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

      const pinnedRegion = () =>
        primary!.element.querySelector<HTMLElement>('[data-testid="overlay-card-region"]')!;
      const toggle = await waitFor(() => {
        const button = pinnedRegion().querySelector<HTMLButtonElement>(
          '[data-testid="overlay-card-expand-toggle"]',
        );
        expect(button).not.toBeNull();
        return button!;
      });
      await act(async () => {
        fireEvent.click(toggle);
      });
      expect(
        pinnedRegion().querySelector('[data-testid="overlay-card-summary"]')
          ?.getAttribute("data-expanded"),
      ).toBe("true");
      expect(pinnedRegion().textContent).toContain("10분 전");

      await focusTile(second!);

      // Same surface, same card. Expansion lives in the queue and the
      // timestamp came from main, so neither is re-derived here — a card that
      // re-minted "now" would read 방금 instead.
      expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
      expect(primary!.element.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
      expect(second!.element.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(0);
      expect(
        pinnedRegion().querySelector('[data-testid="overlay-card-summary"]')
          ?.getAttribute("data-expanded"),
      ).toBe("true");
      expect(pinnedRegion().textContent).toContain("10분 전");
      expect(pinnedRegion().textContent).not.toContain("방금");
    } finally {
      restoreOverflow();
    }
  });
});

describe("a turn parked on an approval, with two tiles", () => {
  const request = (overrides: Record<string, unknown>) => ({
    id: "req-parked-turn",
    category: "tool",
    toolName: "read_file",
    toolCategory: "read",
    args: { path: "/tmp/notes.md" },
    reason: "read the notes",
    createdAt: Date.now(),
    requireExplicit: false,
    nonce: "nonce-parked-turn",
    hmac: "hmac-parked-turn",
    ...overrides,
  });
  const band = (tile: { element: HTMLElement }) =>
    tile.element.querySelector('[data-testid="approval-waiting-band"]');
  const dock = (within: HTMLElement) =>
    within.querySelectorAll('[data-testid="approval-dock"]');

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

  it("draws a request parked before this tile knew its session once: in the tile, never beside it in the window", async () => {
    // A reload: the request comes back from the host before the primary tile
    // has loaded the session it names. Until then nothing owns it and the
    // window's dock holds it; once the tile knows its session it claims the
    // request, and the window's dock must let go of it.
    let resolveHistory!: (history: { sessionId: string; messages: never[] }) => void;
    const history = new Promise<{ sessionId: string; messages: never[] }>((resolve) => {
      resolveHistory = resolve;
    });
    const { container } = await renderApp({
      hasApiKey: true,
      history,
      pendingApprovals: [request({ sessionId: MOCK_DEFAULT_SESSION_ID })],
    });
    await waitFor(() => expect(dock(container)).toHaveLength(1));
    expect(dock(container)[0]!.closest("[data-approval-scope]"))
      .toHaveAttribute("data-testid", "window-approval-scope");

    await act(async () => {
      resolveHistory({ sessionId: MOCK_DEFAULT_SESSION_ID, messages: [] });
    });
    const [primary] = collectTiles(container);
    await waitFor(() => expect(dock(primary!.element)).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(band(primary!)!.getAttribute("data-tool-names")).toBe("read_file");
  });

  it("leaves a request that names no conversation to the window's own dock, outside every tile", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ id: "req-host" }));
    });

    await waitFor(() => expect(dock(container)).toHaveLength(1));
    expect(dock(primary!.element)).toHaveLength(0);
    expect(dock(second!.element)).toHaveLength(0);
    expect(band(primary!)).toBeNull();
    expect(band(second!)).toBeNull();
    // The window's dock has a scope of its own beside the tiles: no tile's
    // composer goes inert, and both still take the keyboard.
    expect(dock(container)[0]!.closest("[data-approval-scope]"))
      .toHaveAttribute("data-testid", "window-approval-scope");
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

  it("keeps the window's dock out of the tile grid, in a band of its own", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ id: "req-host" }));
    });
    await waitFor(() => expect(dock(container)).toHaveLength(1));

    const card = dock(container)[0]!;
    const scope = card.closest<HTMLElement>("[data-approval-scope]")!;
    const canvas = container.querySelector<HTMLElement>('[data-testid="route-canvas"]')!;

    // Disjoint subtrees, both ways: the dock is not drawn over the canvas the
    // tiles live in, and no tile is drawn inside the dock's band. `inert` and
    // the caret were already left alone — what was not was the hit-test, and
    // hit-testing follows the box, not the DOM courtesies.
    expect(canvas.contains(scope)).toBe(false);
    expect(scope.contains(canvas)).toBe(false);
    for (const tile of [primary!, second!]) {
      expect(scope.contains(tile.element)).toBe(false);
    }
    // Nothing for it to cover, so it covers nothing: the band holds no
    // composer, and the card is in flow rather than floating over one.
    expect(scope.querySelectorAll("[data-composer-placement]")).toHaveLength(0);
    expect(card).toHaveAttribute("data-overlay-position", "window-chrome");
  });

  it("takes the unclaimed card down when the host retires the request", async () => {
    const { container, emitApproval, emitApprovalSettled } = await renderApp({ hasApiKey: true });
    await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ id: "req-host" }));
    });
    await waitFor(() => expect(dock(container)).toHaveLength(1));

    // The tile that asked closed, so the host cancelled the ask. Nothing in
    // this window watches that turn any more — the announcement is the only
    // thing that can retire the card, and its deny would answer nothing.
    await act(async () => {
      emitApprovalSettled("req-host");
    });

    await waitFor(() => expect(dock(container)).toHaveLength(0));
  });
});

describe("cards raised by one of three tiles", () => {
  const request = (overrides: Record<string, unknown>) => ({
    id: "req-middle-tile",
    category: "tool",
    toolName: "write_file",
    toolCategory: "write",
    args: { path: "/tmp/out.md" },
    reason: "write the summary",
    createdAt: Date.now(),
    requireExplicit: false,
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
    node.closest<HTMLElement>('[data-testid^="chat-group-cell:"]');
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

    // The two the middle tile's turn raised are inside the middle tile.
    expect(count(middle!.element, "approval-dock")).toBe(1);
    expect(count(middle!.element, "skill-badge")).toBe(1);
    // The routine belongs to no conversation, so it is pinned to the tile it
    // arrived over — exactly one tile draws it, and the window draws none.
    // Focus follows each split, so the third tile is the one the routine
    // arrived over. Naming it is the point: "exactly one tile draws it" would
    // pass with the card on the wrong tile, which is the whole subject here.
    expect(count(third!.element, "overlay-card-region")).toBe(1);
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

    // Nothing the middle tile raised reached its neighbours, and typing in two
    // other tiles did not drag the routine card off the tile it was pinned to.
    const pinned = third!;
    for (const tile of [first!, third!]) {
      expect(tile.element.querySelectorAll(BLOCKING_SURFACE_SELECTOR)).toHaveLength(0);
      expect(count(tile.element, "skill-badge")).toBe(0);
      expect(count(tile.element, "user-approval-hit-toast")).toBe(0);
      expect(count(tile.element, "overlay-card-region")).toBe(tile === pinned ? 1 : 0);
    }
    expect(count(pinned.element, "overlay-card-region")).toBe(1);
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

  /** The mode the shell reads before first paint; "work" is the harness default. */
  const startInChatMode = () => {
    (window as { __lvisInitialAppMode?: string }).__lvisInitialAppMode = "chat";
    return () => { delete (window as { __lvisInitialAppMode?: string }).__lvisInitialAppMode; };
  };

  it("chat mode: adopts the conversation without splitting the canvas", async () => {
    const restoreMode = startInChatMode();
    try {
      const pendingSend = deferred<{ ok: true }>();
      const { container, api } = await renderApp(withOtherSession);
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
      // …and the group that was running was never released to make room: its
      // turn is still going behind the adopted one.
      expect(api.chatGroup).not.toHaveBeenCalledWith(MAIN_CHAT_GROUP_ID);

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
    expect(collectTiles(container).map((tile) => tile.chatGroupId)).toContain(MAIN_CHAT_GROUP_ID);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
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
});
