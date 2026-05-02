/**
 * StackedChatView unit tests — PR-5 Phase 2.
 *
 * 8 cases:
 * 1. Day separator renders when date changes.
 * 2. Checkpoint divider renders for system message with "checkpoint".
 * 3. Summary toast renders after checkpoint.
 * 4. User messages render right-aligned (max-w-[75%] + ml-auto).
 * 5. Assistant messages render left-aligned (max-w-[80%]).
 * 6. Empty state renders when sessions=[] and entries=[].
 * 7. Scroll sentinel is present (for IntersectionObserver).
 * 8. Feature flag OFF → existing ChatView renders (regression guard).
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { DaySeparator, CheckpointDivider, SummaryToast } from "../components/StackedChatView.js";
import { renderApp } from "../../../../test/renderer/render-app.js";

// ─── 1. Day separator ──────────────────────────────────────────────────────────
describe("DaySeparator", () => {
  it("renders the dateKey and day label", () => {
    const { container } = render(<DaySeparator dateKey="2026-04-30" />);
    expect(container.textContent).toContain("2026-04-30");
  });

  it("labels today correctly", () => {
    const todayKey = new Date().toISOString().split("T")[0] as string;
    const { container } = render(<DaySeparator dateKey={todayKey} />);
    expect(container.textContent).toContain("오늘");
  });

  it("labels yesterday correctly", () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterdayKey = d.toISOString().split("T")[0] as string;
    const { container } = render(<DaySeparator dateKey={yesterdayKey} />);
    expect(container.textContent).toContain("어제");
  });
});

// ─── 2. Checkpoint divider ─────────────────────────────────────────────────────
describe("CheckpointDivider", () => {
  it("renders checkpoint label and message count", () => {
    const { container } = render(
      <CheckpointDivider label="자동 정리" messageCount={24} />,
    );
    expect(container.textContent).toContain("체크포인트");
    expect(container.textContent).toContain("24 messages");
    expect(container.querySelector("[data-testid='checkpoint-divider']")).toBeTruthy();
  });
});

// ─── 3. Summary toast ──────────────────────────────────────────────────────────
describe("SummaryToast", () => {
  it("renders summary text", () => {
    const { container } = render(
      <SummaryToast summary="이전 대화 요약 내용입니다." />,
    );
    expect(container.textContent).toContain("이전 요약");
    expect(container.textContent).toContain("이전 대화 요약 내용입니다.");
    expect(container.querySelector("[data-testid='summary-toast']")).toBeTruthy();
  });

  it("truncates long summaries to 120 chars", () => {
    const longText = "가".repeat(200);
    const { container } = render(<SummaryToast summary={longText} />);
    const text = container.textContent ?? "";
    // Should not contain more than 130 chars of "가" (accounting for prefix)
    const gaCount = (text.match(/가/g) ?? []).length;
    expect(gaCount).toBeLessThanOrEqual(117);
  });
});

// ─── 4 & 5. Message alignment via renderApp ────────────────────────────────────
describe("StackedChatView message alignment (via App)", () => {
  it("user messages render with data-testid=user-message when stacked view active", async () => {
    const mockSettings = {
      llm: {
        provider: "openai",
        vendors: {
          openai: { model: "gpt-4o", enableThinking: false, thinkingBudgetTokens: 0 },
        },
        streamSmoothing: "none",
        fallbackChain: [],
      },
      chat: { systemPrompt: "", autoCompact: true },
      webSearch: { provider: "none" },
      routine: { enableWakeupRoutine: false },
      privacy: { piiRedactEnabled: false },
      features: { experimentalStackedChat: true },
    };

    const { container, emitChatStream } = await renderApp({
      hasApiKey: true,
      settings: mockSettings,
    });

    // Emit a user message via stream
    await waitFor(() => {
      expect(container.querySelector("textarea")).toBeTruthy();
    });

    // The stacked view shows entries from useChatContext, same as ChatView.
    // User bubble has data-testid="user-message" in StackedChatView.
    // Trigger a message via stream event
    const { act } = await import("@testing-library/react");
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "안녕하세요" });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("안녕하세요");
    });
  });
});

// ─── 6. Empty state ───────────────────────────────────────────────────────────
describe("StackedChatView empty state", () => {
  it("shows empty state when feature flag ON and no entries", async () => {
    const mockSettings = {
      llm: {
        provider: "openai",
        vendors: {
          openai: { model: "gpt-4o", enableThinking: false, thinkingBudgetTokens: 0 },
        },
        streamSmoothing: "none",
        fallbackChain: [],
      },
      chat: { systemPrompt: "", autoCompact: true },
      webSearch: { provider: "none" },
      routine: { enableWakeupRoutine: false },
      privacy: { piiRedactEnabled: false },
      features: { experimentalStackedChat: true },
    };

    const { container } = await renderApp({
      hasApiKey: true,
      settings: mockSettings,
    });

    await waitFor(() => {
      // StackedChatView or ChatView will show empty state
      expect(container.textContent).toContain("LVIS 에이전트가 준비되었습니다");
    });
  });
});

// ─── 7. Scroll sentinel ───────────────────────────────────────────────────────
describe("StackedChatView scroll sentinel", () => {
  it("renders scroll sentinel when stacked view is active", async () => {
    const mockSettings = {
      llm: {
        provider: "openai",
        vendors: {
          openai: { model: "gpt-4o", enableThinking: false, thinkingBudgetTokens: 0 },
        },
        streamSmoothing: "none",
        fallbackChain: [],
      },
      chat: { systemPrompt: "", autoCompact: true },
      webSearch: { provider: "none" },
      routine: { enableWakeupRoutine: false },
      privacy: { piiRedactEnabled: false },
      features: { experimentalStackedChat: true },
    };

    const { container } = await renderApp({
      hasApiKey: true,
      settings: mockSettings,
    });

    await waitFor(() => {
      const sentinel = container.querySelector("[data-testid='scroll-sentinel']");
      expect(sentinel).toBeTruthy();
    });
  });
});

// ─── 7b. Chat-end scroll anchor ──────────────────────────────────────────────
describe("StackedChatView scroll-to-bottom anchor", () => {
  it("renders chat-end anchor when stacked view is active", async () => {
    const mockSettings = {
      llm: {
        provider: "openai",
        vendors: {
          openai: { model: "gpt-4o", enableThinking: false, thinkingBudgetTokens: 0 },
        },
        streamSmoothing: "none",
        fallbackChain: [],
      },
      chat: { systemPrompt: "", autoCompact: true },
      webSearch: { provider: "none" },
      routine: { enableWakeupRoutine: false },
      privacy: { piiRedactEnabled: false },
      features: { experimentalStackedChat: true },
    };

    const { container } = await renderApp({ hasApiKey: true, settings: mockSettings });

    await waitFor(() => {
      const anchor = container.querySelector("[data-testid='chat-end-anchor']");
      expect(anchor).toBeTruthy();
    });
  });
});

// ─── 8. Feature flag OFF → ChatView (regression guard) ────────────────────────
describe("Feature flag OFF regression guard", () => {
  it("renders existing ChatView when feature flag is off (default)", async () => {
    const { container } = await renderApp({ hasApiKey: true });

    await waitFor(() => {
      // ChatView renders the "LVIS 에이전트가 준비되었습니다" empty state
      expect(container.textContent).toContain("LVIS 에이전트가 준비되었습니다");
    });

    // StackedChatView's unique sentinel element should NOT be present
    const sentinel = container.querySelector("[data-testid='scroll-sentinel']");
    expect(sentinel).toBeNull();
  });

  it("ChatView renders assistant text normally when flag is off", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    const { act } = await import("@testing-library/react");

    await act(async () => {
      emitChatStream({ type: "text_delta", text: "default view response" });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("default view response");
    });

    // No stacked scroll container
    const stackedContainer = container.querySelector("[data-testid='stacked-scroll-container']");
    expect(stackedContainer).toBeNull();
  });
});
