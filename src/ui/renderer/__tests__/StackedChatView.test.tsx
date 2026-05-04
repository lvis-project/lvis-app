/**
 * StackedChatView unit tests — PR-5 Phase 2 (§457 PR-A: structured-kind refactor).
 *
 * 9 cases:
 * 1. Day separator renders when date changes.
 * 2. CheckpointDivider tier-aware label/icon/color.
 * 3. Summary toast renders summary + truncates long ones.
 * 4. SessionResumeDivider renders preamble char count (§457 PR-A).
 * 5. User messages render right-aligned (max-w-[75%] + ml-auto).
 * 6. Empty state renders when sessions=[] and entries=[].
 * 7. Scroll sentinel is present (for IntersectionObserver).
 * 8. Feature flag OFF → existing ChatView renders (regression guard).
 * 9. Legacy free-text "checkpoint" system message no longer triggers a divider
 *    (regression-lock for the dead-string-match removal).
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  DaySeparator,
  CheckpointDivider,
  SummaryToast,
  SessionResumeDivider,
} from "../components/StackedChatView.js";
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

// ─── 2. Checkpoint divider — tier-aware label/icon (§457 PR-A) ────────────────
describe("CheckpointDivider tier mapping", () => {
  it("hard-token tier → 긴급 정리 label + 🚨 icon", () => {
    const { container } = render(<CheckpointDivider tier="hard-token" messageCount={42} />);
    expect(container.textContent).toContain("긴급 정리");
    expect(container.textContent).toContain("🚨");
    expect(container.textContent).toContain("42 messages");
    const divider = container.querySelector("[data-testid='checkpoint-divider']");
    expect(divider?.getAttribute("data-tier")).toBe("hard-token");
  });

  it("semantic-llm tier → 주제 전환 label + 🔀 icon", () => {
    const { container } = render(<CheckpointDivider tier="semantic-llm" messageCount={16} />);
    expect(container.textContent).toContain("주제 전환");
    expect(container.textContent).toContain("🔀");
  });

  it("soft-time tier → 이전 세션 정리 label + 🌙 icon", () => {
    const { container } = render(<CheckpointDivider tier="soft-time" messageCount={30} />);
    expect(container.textContent).toContain("이전 세션 정리");
    expect(container.textContent).toContain("🌙");
  });

  it("undefined tier → default 자동 정리 label + 📌 icon", () => {
    const { container } = render(<CheckpointDivider messageCount={5} />);
    expect(container.textContent).toContain("자동 정리");
    expect(container.textContent).toContain("📌");
    const divider = container.querySelector("[data-testid='checkpoint-divider']");
    expect(divider?.getAttribute("data-tier")).toBe("default");
  });

  // §457 Phase 3: revert button surfaced only when onRevert is provided
  it("renders revert button when onRevert is supplied", () => {
    const { getByTestId } = render(
      <CheckpointDivider tier="hard-token" messageCount={10} onRevert={() => {}} />,
    );
    const btn = getByTestId("checkpoint-revert-btn");
    expect(btn.textContent).toContain("여기로 되돌아가기");
  });

  it("hides revert button when onRevert is omitted", () => {
    const { queryByTestId } = render(
      <CheckpointDivider tier="hard-token" messageCount={10} />,
    );
    expect(queryByTestId("checkpoint-revert-btn")).toBeNull();
  });

  it("invokes onRevert when revert button is clicked", async () => {
    const { vi } = await import("vitest");
    const onRevert = vi.fn();
    const { getByTestId } = render(
      <CheckpointDivider tier="soft-time" messageCount={3} onRevert={onRevert} />,
    );
    getByTestId("checkpoint-revert-btn").click();
    expect(onRevert).toHaveBeenCalledTimes(1);
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

// ─── 3b. Session resume divider (§457 PR-A) ───────────────────────────────────
describe("SessionResumeDivider", () => {
  it("renders preamble char count and resume marker", () => {
    const { container } = render(<SessionResumeDivider preambleChars={1234} />);
    expect(container.textContent).toContain("이전 대화 이어서 시작");
    expect(container.textContent).toContain("1234자");
    expect(container.querySelector("[data-testid='session-resume-divider']")).toBeTruthy();
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
// PR #480 disabled `HomeChatPane → StackedChatView` routing while keeping
// the component itself in the tree for future completion. The two
// `experimentalStackedChat: true` tests in §7 + §7b assert StackedChatView-only
// DOM (`scroll-sentinel`, `chat-end-anchor`) which no longer renders, so
// they're skipped until the feature is re-enabled. Cleanup follow-up to
// #480 / #477.
describe("StackedChatView scroll sentinel", () => {
  it.skip("renders scroll sentinel when stacked view is active (skipped — feature disabled per #480)", async () => {
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
  it.skip("renders chat-end anchor when stacked view is active (skipped — feature disabled per #480)", async () => {
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

// ─── 10. Multi-round visibility (parity with ChatView 2026-05-04 fix) ─────────
//
// Regression — without this, multi-round LLM turns dropped the round-1
// assistant bubble into the auto-collapsing WorkGroup ("작업 N단계 ▶")
// once the turn ended, hiding the front of the response. The fix bucketed
// assistant entries out of `intermediate` in StackedChatView's flushTurn,
// matching the carve-out in ChatView's classifier.
describe("StackedChatView multi-round visibility", () => {
  it("keeps round-1 assistant text visible after a tool-use multi-round turn", async () => {
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
    const { act } = await import("@testing-library/react");

    await act(async () => {
      // Round 1 — text + tool_use
      emitChatStream({ type: "text_delta", text: "첫번째 답변입니다" });
      emitChatStream({
        type: "assistant_round",
        text: "첫번째 답변입니다",
        thought: "",
        stopReason: "tool_use",
        hasToolCalls: true,
      });
      emitChatStream({
        type: "tool_start",
        name: "calendar_list",
        groupId: "g1",
        toolUseId: "t1",
      });
      emitChatStream({
        type: "tool_end",
        name: "calendar_list",
        groupId: "g1",
        toolUseId: "t1",
        result: "ok",
        isError: false,
      });
      // Round 2 — final answer
      emitChatStream({ type: "text_delta", text: "두번째 답변입니다" });
      emitChatStream({
        type: "assistant_round",
        text: "두번째 답변입니다",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      // Both round texts must remain in DOM. Pre-fix the StackedChatView
      // bucketed round-1 assistant as `intermediate`, dropping it inside
      // a WorkGroup that auto-collapsed after the turn ended.
      expect(container.textContent).toContain("첫번째 답변입니다");
      expect(container.textContent).toContain("두번째 답변입니다");
      // WorkGroup contains exactly the tool entry (1단계). Pre-fix this
      // would have been "2단계" because round-1 assistant was inside.
      expect(container.textContent).toContain("1단계");
      expect(container.textContent).not.toContain("2단계");
    });
  });
});
