// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { AskUserQuestionCard } from "../AskUserQuestionCard.js";
import type { AskUserQuestionRequest } from "../AskUserQuestionCard.js";

/**
 * Minimal mock LvisApi — only the surface AskUserQuestionCard uses.
 */
function makeApi(opts: { respondDelay?: number } = {}) {
  const respondAskUserQuestion = vi.fn(async () => {
    if (opts.respondDelay) {
      await new Promise((r) => setTimeout(r, opts.respondDelay));
    }
    return { ok: true };
  });
  return { respondAskUserQuestion };
}

function makeRequest(overrides: Partial<AskUserQuestionRequest> = {}): AskUserQuestionRequest {
  return {
    id: "req-1",
    questions: [
      {
        question: "색상을 선택하세요",
        choices: ["빨강", "파랑", "초록"],
        allowFreeText: false,
      },
    ],
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Single-question flow
// ---------------------------------------------------------------------------

describe("AskUserQuestionCard — single question keyboard Enter", () => {
  it("calls respondAndClose exactly once and does NOT call goNext a second time", async () => {
    /**
     * Regression: before ChoiceResult, handleChoiceKeyDown called onAdvance()
     * whenever onChoose returned truthy. In the single-question path onChoose
     * also called respondAndClose() — resulting in a double advance / race.
     *
     * With ChoiceResult the single-question path returns { kind: "closed" },
     * so the keyboard handler skips onAdvance(). respondAskUserQuestion must
     * be called exactly once.
     */
    const api = makeApi();
    const onResolved = vi.fn();
    const request = makeRequest();

    const { getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={onResolved} />,
    );

    // Focus the first choice button and press Enter.
    const btn = getByText("빨강").closest("button")!;
    btn.focus();
    await act(async () => {
      fireEvent.keyDown(btn, { key: "Enter" });
    });

    // respondAskUserQuestion called exactly once — no double-advance.
    expect(api.respondAskUserQuestion).toHaveBeenCalledTimes(1);
    expect(api.respondAskUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-1", answers: [{ choice: "빨강" }] }),
    );
  });

  it("calls respondAndClose exactly once on Space key", async () => {
    const api = makeApi();
    const request = makeRequest();

    const { getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    const btn = getByText("파랑").closest("button")!;
    btn.focus();
    await act(async () => {
      fireEvent.keyDown(btn, { key: " " });
    });

    expect(api.respondAskUserQuestion).toHaveBeenCalledTimes(1);
    expect(api.respondAskUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ answers: [{ choice: "파랑" }] }),
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-step flow — intermediate step
// ---------------------------------------------------------------------------

describe("AskUserQuestionCard — multi-step keyboard Enter (intermediate step)", () => {
  it("does NOT call respondAndClose — advances step only", async () => {
    /**
     * On an intermediate step of a multi-question flow, pressing Enter after
     * selecting a choice should advance to the next step (goNext) but must NOT
     * call respondAndClose yet.
     */
    const api = makeApi();
    const onResolved = vi.fn();
    const request = makeRequest({
      questions: [
        { question: "첫 번째 질문", choices: ["A", "B"], allowFreeText: false },
        { question: "두 번째 질문", choices: ["X", "Y"], allowFreeText: false },
      ],
    });

    const { getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={onResolved} />,
    );

    // Step 0: select choice "A" via Enter — should advance to step 1.
    const btnA = getByText("A").closest("button")!;
    btnA.focus();
    await act(async () => {
      fireEvent.keyDown(btnA, { key: "Enter" });
    });

    // Still on step 1 (not submitted yet) — respondAskUserQuestion not called.
    expect(api.respondAskUserQuestion).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();

    // Step 1 question is now visible.
    expect(getByText("두 번째 질문")).toBeTruthy();
  });

  it("calls respondAndClose exactly once on the final step after all answers given", async () => {
    /**
     * After navigating through all multi-step questions via keyboard, the final
     * "보내기" button submit path should call respondAndClose exactly once.
     * This test ensures no extra submit is triggered by the keyboard handler.
     */
    const api = makeApi();
    const onResolved = vi.fn();
    const request = makeRequest({
      questions: [
        { question: "Q1", choices: ["A", "B"], allowFreeText: false },
        { question: "Q2", choices: ["X", "Y"], allowFreeText: false },
      ],
    });

    const { getByRole, getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={onResolved} />,
    );

    // Step 0: press Enter on "A" → advance to step 1.
    const btnA = getByText("A").closest("button")!;
    btnA.focus();
    await act(async () => {
      fireEvent.keyDown(btnA, { key: "Enter" });
    });
    expect(api.respondAskUserQuestion).not.toHaveBeenCalled();

    // Step 1: press Enter on "X" → advance to confirm step (step === total).
    const btnX = getByText("X").closest("button")!;
    btnX.focus();
    await act(async () => {
      fireEvent.keyDown(btnX, { key: "Enter" });
    });
    // Confirm step reached, still not submitted.
    expect(api.respondAskUserQuestion).not.toHaveBeenCalled();

    // User clicks 보내기 on the confirm step.
    const submitBtn = getByRole("button", { name: "보내기" });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(api.respondAskUserQuestion).toHaveBeenCalledTimes(1);
    expect(api.respondAskUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        answers: [{ choice: "A" }, { choice: "X" }],
      }),
    );
  });
});

describe("AskUserQuestionCard — multi-step free-text keyboard navigation", () => {
  it("does not advance while Korean IME composition is being committed", async () => {
    const api = makeApi();
    const request = makeRequest({
      questions: [
        { question: "참석자", allowFreeText: true },
        { question: "의제", allowFreeText: true },
      ],
    });

    const { getByTestId, getByText, queryByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    const input = getByTestId("ask-freetext-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "알루우" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    });

    expect(getByText("참석자")).toBeTruthy();
    expect(queryByText("의제")).toBeNull();
    expect(input.value).toBe("알루우");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(getByText("의제")).toBeTruthy();
    expect((getByTestId("ask-freetext-input") as HTMLInputElement).value).toBe("");
  });

  it("moves between questions with ArrowDown and ArrowUp and exposes keyboard guidance", async () => {
    const api = makeApi();
    const request = makeRequest({
      questions: [
        { question: "참석자", allowFreeText: true },
        { question: "의제", allowFreeText: true },
      ],
    });

    const { getByTestId, getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    expect(getByTestId("ask-keyboard-hint").textContent).toContain("Enter");
    expect(getByTestId("ask-keyboard-hint").textContent).toContain("질문 이동");

    const firstInput = getByTestId("ask-freetext-input") as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "알루우" } });
    await act(async () => {
      fireEvent.keyDown(firstInput, { key: "ArrowDown" });
    });

    expect(getByText("의제")).toBeTruthy();

    const secondInput = getByTestId("ask-freetext-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.keyDown(secondInput, { key: "ArrowUp" });
    });

    expect(getByText("참석자")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ChoiceResult — click path (no regression)
// ---------------------------------------------------------------------------

describe("AskUserQuestionCard — mouse click path (single question)", () => {
  it("calls respondAndClose exactly once on click — no keyboard involved", async () => {
    const api = makeApi();
    const request = makeRequest();

    const { getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    await act(async () => {
      fireEvent.click(getByText("초록").closest("button")!);
    });

    expect(api.respondAskUserQuestion).toHaveBeenCalledTimes(1);
    expect(api.respondAskUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ answers: [{ choice: "초록" }] }),
    );
  });
});
