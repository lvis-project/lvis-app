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
  toggleTileMaximized,
} from "./helpers.js";
import { MOCK_DEFAULT_SESSION_ID, type MockLvisApi } from "./mock-lvis-api.js";
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

  it("shows the card in the focused tile without its action, and restores the action with the tile", async () => {
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
    // conversation. The card must not vanish with it, and must not become
    // actionable in a conversation it was never staged for.
    await toggleTileMaximized(primary!);
    const maximized = await waitFor(() => {
      const region = container.querySelector<HTMLElement>('[data-testid="overlay-card-region"]');
      expect(region).not.toBeNull();
      return region!;
    });
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
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
  it("counts and steps through each tile's own cards", async () => {
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

    // Two for the focused tile (no origin), one for the tile beside it.
    await act(async () => {
      emitOverlayShow(card("a1", undefined, "first for the focused tile"));
      emitOverlayShow(card("b1", `session-${second!.chatGroupId}`, "only for the other tile"));
      emitOverlayShow(card("a2", undefined, "second for the focused tile"));
    });

    const indicator = (tile: { element: HTMLElement }) =>
      tile.element.querySelector('[data-testid="routine-card-indicator"]')?.textContent;

    // Each tile counts what IT shows. A window-wide counter would say 3/3 here.
    await waitFor(() => expect(indicator(primary!)).toBe("2/2"));
    expect(primary!.element.textContent).toContain("second for the focused tile");
    // One card is not a queue, so the other tile shows no counter at all.
    expect(indicator(second!)).toBeUndefined();
    expect(second!.element.textContent).toContain("only for the other tile");

    // Stepping back stays inside this tile's slice — it never lands on the
    // card that renders in the tile beside it.
    const back = primary!.element.querySelector<HTMLButtonElement>('[data-testid="overlay-card-prev"]')!;
    await act(async () => {
      fireEvent.click(back);
    });
    await waitFor(() => expect(indicator(primary!)).toBe("1/2"));
    expect(primary!.element.textContent).toContain("first for the focused tile");
    expect(primary!.element.textContent).not.toContain("only for the other tile");
  });
});

describe("a card that follows focus keeps what the user did to it", () => {
  it("keeps the expanded summary and the original timestamp across a focus change", async () => {
    const restoreOverflow = forceOverflowingSummaries();
    try {
      const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
      const [primary, second] = await splitIntoTwoTiles(container);
      await focusTile(primary!);

      // No origin, so this card belongs to whichever tile is focused — it
      // unmounts and remounts every time focus moves.
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

      const toggle = await waitFor(() => {
        const button = primary!.element.querySelector<HTMLButtonElement>(
          '[data-testid="overlay-card-expand-toggle"]',
        );
        expect(button).not.toBeNull();
        return button!;
      });
      await act(async () => {
        fireEvent.click(toggle);
      });
      expect(
        primary!.element.querySelector('[data-testid="overlay-card-summary"]')
          ?.getAttribute("data-expanded"),
      ).toBe("true");
      expect(primary!.element.textContent).toContain("10분 전");

      await focusTile(second!);

      // The card moved tiles, which remounts it. Expansion lives in the queue
      // and the timestamp came from main, so neither is re-derived here — a
      // card that re-minted "now" would read 방금 instead.
      await waitFor(() => {
        expect(second!.element.querySelector('[data-testid="overlay-card-region"]')).not.toBeNull();
      });
      expect(
        second!.element.querySelector('[data-testid="overlay-card-summary"]')
          ?.getAttribute("data-expanded"),
      ).toBe("true");
      expect(second!.element.textContent).toContain("10분 전");
      expect(second!.element.textContent).not.toContain("방금");
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
