// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, act, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { SideChatView } from "../SideChatView.js";
import type { ChatStreamEvent } from "../../../../lib/chat-stream-state.js";
import type { LvisApi } from "../../types.js";
import { ChatContextProvider, type ChatContextValue } from "../../context/ChatContext.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

function makeApi() {
  // Two subscribers share the side stream — the transcript reducer and the
  // message queue's drain — so the seam fans every frame out to all of them,
  // in subscription order, exactly as the preload channel does.
  const handlers = new Set<(e: ChatStreamEvent) => void>();
  const spies = {
    send: vi.fn(async (_input: string, _attachments?: unknown[]) => ({ ok: true as const, result: {} })),
    new: vi.fn(async () => ({ ok: true as const, sessionId: "side-2" })),
    abort: vi.fn(async () => ({ ok: true as const })),
  };
  const api = {
    sideChat: {
      ...spies,
      load: vi.fn(),
      list: vi.fn(),
      onStream: (h: (e: ChatStreamEvent) => void) => {
        handlers.add(h);
        return () => {
          handlers.delete(h);
        };
      },
      onFallback: () => () => {},
    },
  } as unknown as LvisApi;
  return {
    api,
    emit: (e: ChatStreamEvent) => act(() => { for (const h of handlers) h(e); }),
    spies,
  };
}

function renderView(api: LvisApi, chatContext?: Partial<ChatContextValue>) {
  return render(
    <TooltipProvider>
      {chatContext ? (
        <ChatContextProvider value={chatContext as ChatContextValue}>
          <SideChatView api={api} />
        </ChatContextProvider>
      ) : <SideChatView api={api} />}
    </TooltipProvider>,
  );
}

/** The side chat's own composer field and turn control, scoped to its view. */
function sideComposer() {
  const view = within(screen.getByTestId("side-chat-view"));
  return {
    textarea: view.getByTestId("composer-textarea") as HTMLTextAreaElement,
    sendButton: () => view.getByTestId("composer-send-button") as HTMLButtonElement,
    view,
  };
}

async function startTurn(text = "hello") {
  const { textarea, sendButton } = sideComposer();
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(sendButton());
  await act(async () => {});
}

describe("SideChatView — New button gating during streaming", () => {
  it("disables the New button while a turn is streaming", async () => {
    const { api, emit } = makeApi();
    renderView(api);

    // Idle → New is enabled.
    const newBtn = screen.getByTestId("side-chat-new") as HTMLButtonElement;
    expect(newBtn.disabled).toBe(false);

    await startTurn();
    emit({ type: "text_delta", text: "streaming…", streamId: 1 });

    // Streaming → New is disabled (no mid-stream session swap).
    expect((screen.getByTestId("side-chat-new") as HTMLButtonElement).disabled).toBe(true);

    // Turn done → New is enabled again.
    emit({ type: "done", streamId: 1 });
    expect((screen.getByTestId("side-chat-new") as HTMLButtonElement).disabled).toBe(false);
  });

  it("uses the main runtime readiness gate before side-chat can send and preserves the draft", async () => {
    const { api, spies } = makeApi();
    const onOpenSettings = vi.fn();
    renderView(api, {
      hasApiKey: false,
      subscriptionUnavailableProvider: "codex",
      onOpenSettings,
    });

    const { textarea, sendButton, view } = sideComposer();
    fireEvent.change(textarea, { target: { value: "keep this draft" } });
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(spies.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe("keep this draft");

    // The same no-credential chip the main dock shows, one click from settings.
    fireEvent.click(view.getByTestId("composer-subscription-runtime-chip"));
    const settings = await waitFor(() => {
      const button = document.querySelector<HTMLElement>('[data-testid="composer-api-key-chip:settings"]');
      expect(button).not.toBeNull();
      return button!;
    });
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledWith("llm");
  });

  it("does not render token or cost estimates for a subscription side-chat runtime", async () => {
    const { api, emit } = makeApi();
    renderView(api, { hasApiKey: true, usageAvailable: false });

    await startTurn();
    emit({ type: "assistant_round", text: "answer", stopReason: "end_turn", streamId: 1 } as ChatStreamEvent);
    emit({
      type: "turn_summary",
      turnDurationMs: 20,
      toolCount: 0,
      cumulativeToolMs: 0,
      tokensIn: 100,
      freshInputTokens: 90,
      tokensOut: 10,
      streamId: 1,
    } as ChatStreamEvent);
    emit({ type: "done", streamId: 1 });

    expect(screen.queryByTestId(TEST_IDS.tokenCostBadge)).toBeNull();
  });
});

describe("SideChatView — the main composer's input system", () => {
  it("renders the shared composer at the side surface, inside the shared frame", () => {
    const { api } = makeApi();
    renderView(api);
    const { textarea, view } = sideComposer();
    expect(textarea.getAttribute("data-composer-surface")).toBe("side");
    expect(textarea.className).toContain("max-h-[112px]");
    expect(textarea.className).toContain("text-body-sm");
    expect(textarea.className).toContain("text-input-bar-foreground");
    expect(textarea.getAttribute("rows")).toBeNull();
    expect(textarea.hasAttribute("data-tour-anchor")).toBe(false);
    expect(view.getByTestId("composer-frame")).toBeTruthy();
    expect(view.getByTestId("iab-attach-button")).toBeTruthy();
  });

  it("queues a plain Enter while a turn runs and drains it as the next turn on done", async () => {
    const { api, emit, spies } = makeApi();
    renderView(api);
    const { textarea, view } = sideComposer();

    await startTurn("first");
    emit({ type: "text_delta", text: "working…", streamId: 1 });
    expect(spies.send).toHaveBeenCalledTimes(1);

    // Enter mid-turn: queued, not sent — the field empties into the queue row.
    fireEvent.change(textarea, { target: { value: "second" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("");
    expect(within(view.getByTestId("message-queue-panel")).getByText("second")).toBeTruthy();
    expect(spies.abort).not.toHaveBeenCalled();

    // The turn closes → the queue goes out as a fresh turn, without an abort.
    emit({ type: "done", streamId: 1 });
    await waitFor(() => expect(spies.send).toHaveBeenCalledTimes(2));
    expect(spies.send.mock.calls[1][0]).toBe("second");
    expect(spies.abort).not.toHaveBeenCalled();
    await waitFor(() => expect(view.queryByTestId("message-queue-panel")).toBeNull());
  });

  it("interrupts the running turn on ⌘⏎: abort settles first, then the new send goes out", async () => {
    const { api, emit, spies } = makeApi();
    renderView(api);
    const { textarea } = sideComposer();

    await startTurn("first");
    emit({ type: "text_delta", text: "working…", streamId: 1 });

    fireEvent.change(textarea, { target: { value: "now instead" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => expect(spies.send).toHaveBeenCalledTimes(2));
    expect(spies.abort).toHaveBeenCalledTimes(1);
    expect(spies.abort.mock.invocationCallOrder[0]).toBeLessThan(spies.send.mock.invocationCallOrder[1]);
    expect(spies.send.mock.calls[1][0]).toBe("now instead");
    expect(textarea.value).toBe("");
  });

  it("aborts the running turn on Esc inside the field when nothing is queued", async () => {
    const { api, emit, spies } = makeApi();
    renderView(api);
    const { textarea } = sideComposer();

    await startTurn("first");
    emit({ type: "text_delta", text: "working…", streamId: 1 });

    fireEvent.keyDown(textarea, { key: "Escape" });
    await waitFor(() => expect(spies.abort).toHaveBeenCalledTimes(1));
    expect(spies.send).toHaveBeenCalledTimes(1);
  });

  it("does not send an Enter that commits an IME composition", () => {
    const { api, spies } = makeApi();
    renderView(api);
    const { textarea } = sideComposer();

    fireEvent.change(textarea, { target: { value: "한글" } });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(spies.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe("한글");
  });

  it("flips the turn control to stop while a turn runs with an empty draft", async () => {
    const { api, emit } = makeApi();
    renderView(api);
    const { view } = sideComposer();

    await startTurn("first");
    emit({ type: "text_delta", text: "working…", streamId: 1 });
    expect(view.getByTestId("composer-cancel-button")).toBeTruthy();

    emit({ type: "done", streamId: 1 });
    expect(view.getByTestId("composer-send-button")).toBeTruthy();
  });
});
