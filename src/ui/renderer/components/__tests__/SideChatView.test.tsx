// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { SideChatView } from "../SideChatView.js";
import type { ChatStreamEvent } from "../../../../lib/chat-stream-state.js";
import type { LvisApi } from "../../types.js";
import { ChatContextProvider, type ChatContextValue } from "../../context/ChatContext.js";
import { ApprovalSurfaceProvider } from "../../hooks/use-approval.js";
import { approvalSurfaceStub } from "../../../../../test/renderer/helpers.js";

function makeApi() {
  let handler: ((e: ChatStreamEvent) => void) | null = null;
  const spies = {
    send: vi.fn(async () => ({ ok: true as const, result: {} })),
    new: vi.fn(async () => ({ ok: true as const, sessionId: "side-2" })),
    abort: vi.fn(async () => ({ ok: true as const })),
  };
  const api = {
    sideChat: {
      ...spies,
      load: vi.fn(),
      list: vi.fn(),
      onStream: (h: (e: ChatStreamEvent) => void) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
      onFallback: () => () => {},
    },
  } as unknown as LvisApi;
  return { api, emit: (e: ChatStreamEvent) => act(() => handler?.(e)), spies };
}

function renderView(api: LvisApi, chatContext?: Partial<ChatContextValue>) {
  return render(
    <TooltipProvider>
      <ApprovalSurfaceProvider value={approvalSurfaceStub()}>
        {chatContext ? (
          <ChatContextProvider value={chatContext as ChatContextValue}>
            <SideChatView api={api} />
          </ChatContextProvider>
        ) : <SideChatView api={api} />}
      </ApprovalSurfaceProvider>
    </TooltipProvider>,
  );
}

describe("SideChatView — New button gating during streaming", () => {
  it("disables the New button while a turn is streaming", () => {
    const { api, emit } = makeApi();
    renderView(api);

    // Idle → New is enabled.
    const newBtn = screen.getByTestId("side-chat-new") as HTMLButtonElement;
    expect(newBtn.disabled).toBe(false);

    // Start a turn.
    fireEvent.change(screen.getByTestId("side-chat-composer"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByTestId("side-chat-send"));
    emit({ type: "text_delta", text: "streaming…", streamId: 1 });

    // Streaming → New is disabled (no mid-stream session swap).
    expect((screen.getByTestId("side-chat-new") as HTMLButtonElement).disabled).toBe(true);

    // Turn done → New is enabled again.
    emit({ type: "done", streamId: 1 });
    expect((screen.getByTestId("side-chat-new") as HTMLButtonElement).disabled).toBe(false);
  });

  it("uses the main runtime readiness gate before side-chat can send and preserves the draft", () => {
    const { api, spies } = makeApi();
    const onOpenSettings = vi.fn();
    renderView(api, {
      hasApiKey: false,
      subscriptionUnavailableProvider: "codex",
      onOpenSettings,
    });

    const composer = screen.getByTestId("side-chat-composer") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "keep this draft" } });
    expect((screen.getByTestId("side-chat-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(spies.send).not.toHaveBeenCalled();
    expect(composer.value).toBe("keep this draft");

    const status = screen.getByTestId("side-chat-runtime-status");
    const settings = status.querySelector("button") as HTMLButtonElement | null;
    expect(settings).toBeTruthy();
    fireEvent.click(settings!);
    expect(onOpenSettings).toHaveBeenCalledWith("llm");
  });

  it("does not render token or cost estimates for a subscription side-chat runtime", () => {
    const { api, emit } = makeApi();
    renderView(api, { hasApiKey: true, usageAvailable: false });

    fireEvent.change(screen.getByTestId("side-chat-composer"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByTestId("side-chat-send"));
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

    expect(screen.queryByTestId("token-cost-badge")).toBeNull();
  });
});
