// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { SideChatView } from "../SideChatView.js";
import type { StreamEvent } from "../../../../lib/chat-stream-state.js";
import type { LvisApi } from "../../types.js";

function makeApi() {
  let handler: ((e: StreamEvent) => void) | null = null;
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
      onStream: (h: (e: StreamEvent) => void) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
      onFallback: () => () => {},
    },
  } as unknown as LvisApi;
  return { api, emit: (e: StreamEvent) => act(() => handler?.(e)), spies };
}

function renderView(api: LvisApi) {
  return render(
    <TooltipProvider>
      <SideChatView api={api} />
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
});
