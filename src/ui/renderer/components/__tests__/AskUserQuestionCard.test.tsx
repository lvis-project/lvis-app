// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { AskUserQuestionCard } from "../AskUserQuestionCard.js";
import type { AskUserQuestionRequest } from "../AskUserQuestionCard.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

function askUserQuestionApi(opts: { respondDelay?: number } = {}) {
  const { api } = makeMockLvisApi();
  const respondAskUserQuestion = vi.fn(async () => {
    if (opts.respondDelay) {
      await new Promise((r) => setTimeout(r, opts.respondDelay));
    }
    return { ok: true };
  });
  api.respondAskUserQuestion = respondAskUserQuestion;
  return api;
}

function makeRequest(overrides: Partial<AskUserQuestionRequest> = {}): AskUserQuestionRequest {
  return {
    id: "req-1",
    sessionId: "session-1",
    questions: [
      {
        question: "색상을 선택하세요",
        choices: ["빨강", "파랑", "초록"],
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
    const api = askUserQuestionApi();
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
    const api = askUserQuestionApi();
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

  it("dismisses the current question on Escape", async () => {
    const api = askUserQuestionApi();
    const onResolved = vi.fn();
    const request = makeRequest();

    const { getByTestId } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={onResolved} />,
    );

    await act(async () => {
      fireEvent.keyDown(getByTestId("ask-user-question-card"), { key: "Escape" });
    });

    expect(api.respondAskUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-1", dismissed: true }),
    );
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("req-1"));
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
    const api = askUserQuestionApi();
    const onResolved = vi.fn();
    const request = makeRequest({
      questions: [
        { question: "첫 번째 질문", choices: ["A", "B"] },
        { question: "두 번째 질문", choices: ["X", "Y"] },
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
    const api = askUserQuestionApi();
    const onResolved = vi.fn();
    const request = makeRequest({
      questions: [
        { question: "Q1", choices: ["A", "B"] },
        { question: "Q2", choices: ["X", "Y"] },
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

  it("focuses the send button on the confirm step and submits with Enter", async () => {
    const api = askUserQuestionApi();
    const onResolved = vi.fn();
    const request = makeRequest({
      questions: [
        { question: "Q1", choices: ["A", "B"] },
        { question: "Q2", choices: ["X", "Y"] },
      ],
    });

    const { getByRole, getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={onResolved} />,
    );

    await act(async () => {
      fireEvent.keyDown(getByText("A").closest("button")!, { key: "Enter" });
    });
    await act(async () => {
      fireEvent.keyDown(getByText("X").closest("button")!, { key: "Enter" });
    });

    const submitBtn = getByRole("button", { name: "보내기" });
    await waitFor(() => expect(document.activeElement).toBe(submitBtn));
    await act(async () => {
      fireEvent.keyDown(submitBtn, { key: "Enter" });
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

describe("AskUserQuestionCard — choice-only answers", () => {
  it("does not render a manual input for a legacy request payload", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        {
          question: "참석자",
          choices: ["알루우", "지수"],
          allowFreeText: true,
          placeholder: "직접입력",
        } as never,
      ],
    });

    const { getByText, queryByTestId, queryByPlaceholderText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    expect(queryByTestId("ask-freetext-input")).toBeNull();
    expect(queryByPlaceholderText("직접입력")).toBeNull();

    await act(async () => {
      fireEvent.click(getByText("알루우").closest("button")!);
    });
    expect(api.respondAskUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ answers: [{ choice: "알루우" }] }),
    );
  });

  it("moves choice answers with ArrowUp and ArrowDown before ArrowRight changes question", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        { question: "첫 번째 질문", choices: ["A", "B"] },
        { question: "두 번째 질문", choices: ["X", "Y"] },
      ],
    });

    const { getByTestId, getByText, queryByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    expect(getByTestId("ask-keyboard-hint").textContent).toContain("답변 이동");
    expect(getByTestId("ask-keyboard-hint").textContent).toContain("질문 이동");

    const answerA = getByText("A").closest("button")!;
    answerA.focus();
    await act(async () => {
      fireEvent.keyDown(answerA, { key: "ArrowDown" });
    });
    expect(document.activeElement?.textContent).toContain("B");
    expect(queryByText("두 번째 질문")).toBeNull();

    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    });
    expect(document.activeElement?.textContent).toContain("A");

    await act(async () => {
      fireEvent.click(answerA);
    });
    const card = getByTestId("ask-user-question-card");
    card.focus();
    await act(async () => {
      fireEvent.keyDown(card, { key: "ArrowRight" });
    });
    expect(getByText("두 번째 질문")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ChoiceResult — click path (no regression)
// ---------------------------------------------------------------------------

describe("AskUserQuestionCard — mouse click path (single question)", () => {
  it("calls respondAndClose exactly once on click — no keyboard involved", async () => {
    const api = askUserQuestionApi();
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

// ---------------------------------------------------------------------------
// 4-direction card-level navigation (regression: ArrowUp/Down broken after
// composer redesign + message queue PR #720 merge)
// ---------------------------------------------------------------------------

describe("AskUserQuestionCard — 4-direction card-level arrow navigation", () => {
  /**
   * ArrowLeft / ArrowRight on the card container must navigate between questions
   * in a multi-step flow. These were working before PR #720; verify they remain
   * intact while we fix Up/Down.
   */
  it("ArrowLeft and ArrowRight navigate between questions from card surface", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        { question: "Q1", choices: ["A", "B"] },
        { question: "Q2", choices: ["X", "Y"] },
      ],
    });

    const { getByTestId, getByText, queryByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    // Click A to complete Q1 draft so ArrowRight can advance.
    await act(async () => { fireEvent.click(getByText("A").closest("button")!); });

    const card = getByTestId("ask-user-question-card");
    card.focus();

    // ArrowRight → should advance to Q2.
    await act(async () => { fireEvent.keyDown(card, { key: "ArrowRight" }); });
    expect(getByText("Q2")).toBeTruthy();

    // ArrowLeft → should go back to Q1.
    await act(async () => { fireEvent.keyDown(card, { key: "ArrowLeft" }); });
    expect(getByText("Q1")).toBeTruthy();
    expect(queryByText("Q2")).toBeNull();
  });

  /**
   * ArrowDown on the card container must move focus from the visible cursor
   * at answer 1 to the next choice button.
   * Regression: before this fix, ArrowUp/Down on the card surface had no effect.
   */
  it("ArrowDown from card surface moves focus to next choice answer", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        { question: "색상 선택", choices: ["빨강", "파랑", "초록"] },
      ],
    });

    const { getByTestId } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    const card = getByTestId("ask-user-question-card");
    card.focus();

    // The page starts with answer 1 ("빨강") as the visible cursor, so
    // ArrowDown from the card surface moves to answer 2 ("파랑").
    await act(async () => { fireEvent.keyDown(card, { key: "ArrowDown" }); });

    expect(document.activeElement).not.toBe(card);
    expect(document.activeElement?.tagName.toLowerCase()).toBe("button");
    expect(document.activeElement?.textContent).toContain("파랑");
  });

  /**
   * ArrowUp on the card container must move focus to the previous choice button
   * (wraps around to last when at index 0).
   */
  it("ArrowUp from card surface moves focus to a choice answer (wraps to last)", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        { question: "색상 선택", choices: ["빨강", "파랑", "초록"] },
      ],
    });

    const { getByTestId } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    const card = getByTestId("ask-user-question-card");
    card.focus();

    // ArrowUp from card → wraps focus to last choice ("초록", index 2).
    await act(async () => { fireEvent.keyDown(card, { key: "ArrowUp" }); });

    expect(document.activeElement).not.toBe(card);
    expect(document.activeElement?.tagName.toLowerCase()).toBe("button");
    // The focused button text should be "초록" (last choice, wrap-around from index 0).
    expect(document.activeElement?.textContent).toContain("초록");
  });

  /**
   * Full 4-direction sequence: ArrowDown navigates choices, ArrowRight advances
   * questions — both work together without interfering.
   */
  it("ArrowDown navigates choices then ArrowRight advances question (4-dir together)", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        { question: "Q1", choices: ["A", "B"] },
        { question: "Q2", choices: ["X", "Y"] },
      ],
    });

    const { getByTestId, getByText, queryByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    const card = getByTestId("ask-user-question-card");
    card.focus();

    // The page starts at "A", so ArrowDown from card surface moves to "B".
    await act(async () => { fireEvent.keyDown(card, { key: "ArrowDown" }); });
    expect(document.activeElement?.tagName.toLowerCase()).toBe("button");
    expect(document.activeElement?.textContent).toContain("B");
    // Still on Q1, not Q2.
    expect(queryByText("Q2")).toBeNull();

    // Select A via click so the draft is complete.
    await act(async () => { fireEvent.click(getByText("A").closest("button")!); });

    // ArrowRight from card → should advance to Q2.
    card.focus();
    await act(async () => { fireEvent.keyDown(card, { key: "ArrowRight" }); });
    expect(getByText("Q2")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Med-3: confirm step — ArrowDown must NOT jump into prior question choices
// ---------------------------------------------------------------------------

describe("AskUserQuestionCard — ArrowDown suppressed on confirm step", () => {
  /**
   * After all questions answered and confirm step is shown (step === total),
   * there is no QuestionForm mounted, so card-level ArrowDown must not
   * move focus into prior question choices.
   */
  it("ArrowDown on card at confirm step does not move focus to a choice button", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        { question: "Q1", choices: ["A", "B"] },
        { question: "Q2", choices: ["X", "Y"] },
      ],
    });

    const { getByTestId, getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    // Advance to confirm step via Enter on each question's first choice.
    const btnA = getByText("A").closest("button")!;
    btnA.focus();
    await act(async () => { fireEvent.keyDown(btnA, { key: "Enter" }); });

    const btnX = getByText("X").closest("button")!;
    btnX.focus();
    await act(async () => { fireEvent.keyDown(btnX, { key: "Enter" }); });

    // Confirm step is now visible (보내기 button).
    const card = getByTestId("ask-user-question-card");
    card.focus();
    const focusBefore = document.activeElement;

    await act(async () => { fireEvent.keyDown(card, { key: "ArrowDown" }); });

    // Focus must NOT have jumped into a Q1/Q2 choice button (role="option").
    // On confirm step the QuestionForm is unmounted, so arrowNav ref is null
    // and the card-level handler guards with !onConfirmStep. Either focus stays
    // on the card or moves to the 보내기 submit button — never a choice option.
    const focused = document.activeElement;
    expect(focused?.getAttribute("role")).not.toBe("option");
  });
});

// ---------------------------------------------------------------------------
// Auto-focus on mount/step change — focus starts at answer 1 so arrow keys
// have a visible cursor and do not inherit the prior page's cursor position.
// ---------------------------------------------------------------------------

describe("AskUserQuestionCard — auto-focus on mount enables arrow nav", () => {
  it("focuses the first answer immediately when the request mounts", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest();
    const { getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    await waitFor(() => expect(document.activeElement).toBe(getByText("빨강").closest("button")));
  });

  it("ArrowDown moves from the first answer to the second answer right after mount", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        { question: "색상", choices: ["빨강", "파랑"] },
      ],
    });

    const { getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    await waitFor(() => expect(document.activeElement).toBe(getByText("빨강").closest("button")));
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }); });

    expect(document.activeElement?.textContent).toContain("파랑");
  });

  it("restores focus to the first answer after advancing to the next question", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        { question: "Q1", choices: ["A"] },
        { question: "Q2", choices: ["X", "Y"] },
      ],
    });

    const { getByTestId, getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    await act(async () => {
      fireEvent.keyDown(getByText("A").closest("button")!, { key: "Enter" });
    });

    await waitFor(() => expect(document.activeElement).toBe(getByText("X").closest("button")));
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    });

    expect(document.activeElement?.textContent).toContain("Y");
  });
});

// ---------------------------------------------------------------------------
// Multi-select (allowMultiple: true)
// ---------------------------------------------------------------------------

describe("AskUserQuestionCard — multi-select", () => {
  it("clicking a choice toggles its membership and does NOT auto-submit", async () => {
    const api = askUserQuestionApi();
    const onResolved = vi.fn();
    const request = makeRequest({
      questions: [
        {
          question: "관심 분야 (복수)",
          choices: ["AI", "보안", "UX"],
          allowMultiple: true,
        },
      ],
    });

    const { getByRole, getByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={onResolved} />,
    );

    expect(getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");

    await act(async () => { fireEvent.click(getByText("AI").closest("button")!); });
    // Multi-select must not auto-submit on single-question cards either.
    expect(api.respondAskUserQuestion).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(getByText("UX").closest("button")!); });
    expect(api.respondAskUserQuestion).not.toHaveBeenCalled();

    // Both AI and UX should be visually selected.
    expect(getByText("AI").closest("button")!.getAttribute("aria-selected")).toBe("true");
    expect(getByText("UX").closest("button")!.getAttribute("aria-selected")).toBe("true");
    expect(getByText("보안").closest("button")!.getAttribute("aria-selected")).toBe("false");
  });

  it("explicit 보내기 sends choices: string[] for multi-select", async () => {
    const api = askUserQuestionApi();
    const onResolved = vi.fn();
    const request = makeRequest({
      questions: [
        {
          question: "관심 분야 (복수)",
          choices: ["AI", "보안", "UX"],
          allowMultiple: true,
        },
      ],
    });

    const { getByText, getByRole } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={onResolved} />,
    );

    await act(async () => { fireEvent.click(getByText("AI").closest("button")!); });
    await act(async () => { fireEvent.click(getByText("UX").closest("button")!); });

    const submit = getByRole("button", { name: "보내기" });
    await act(async () => { fireEvent.click(submit); });

    expect(api.respondAskUserQuestion).toHaveBeenCalledTimes(1);
    expect(api.respondAskUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        answers: [expect.objectContaining({ choices: ["AI", "UX"] })],
      }),
    );
  });

  it("re-clicking a selected chip removes it from the selection set", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        {
          question: "관심 분야 (복수)",
          choices: ["AI", "보안"],
          allowMultiple: true,
        },
      ],
    });

    const { getByText, getByRole } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    await act(async () => { fireEvent.click(getByText("AI").closest("button")!); });
    await act(async () => { fireEvent.click(getByText("보안").closest("button")!); });
    // Toggle "AI" back off.
    await act(async () => { fireEvent.click(getByText("AI").closest("button")!); });

    expect(getByText("AI").closest("button")!.getAttribute("aria-selected")).toBe("false");
    expect(getByText("보안").closest("button")!.getAttribute("aria-selected")).toBe("true");

    const submit = getByRole("button", { name: "보내기" });
    await act(async () => { fireEvent.click(submit); });

    expect(api.respondAskUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: [expect.objectContaining({ choices: ["보안"] })],
      }),
    );
  });

  it("Enter on a multi-select chip toggles it but does not advance the step", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        {
          question: "Q1",
          choices: ["A", "B"],
          allowMultiple: true,
        },
        { question: "Q2", choices: ["X"] },
      ],
    });

    const { getByText, queryByText } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    const btnA = getByText("A").closest("button")!;
    btnA.focus();
    await act(async () => { fireEvent.keyDown(btnA, { key: "Enter" }); });

    // Multi-select Enter must NOT auto-advance to Q2.
    expect(queryByText("Q2")).toBeNull();
    expect(btnA.getAttribute("aria-selected")).toBe("true");
  });

});

// ---------------------------------------------------------------------------
// 4-question card — confirms the cap is honored end-to-end through the UI
// ---------------------------------------------------------------------------

describe("AskUserQuestionCard — 4-question pagination", () => {
  it("paginates through 4 questions and submits all answers", async () => {
    const api = askUserQuestionApi();
    const request = makeRequest({
      questions: [
        { question: "Q1", choices: ["A"] },
        { question: "Q2", choices: ["B"] },
        { question: "Q3", choices: ["C"] },
        { question: "Q4", choices: ["D"] },
      ],
    });

    const { getByText, getByRole } = render(
      <AskUserQuestionCard api={api as never} request={request} onResolved={vi.fn()} />,
    );

    // Advance through each step via Enter on the only choice.
    for (const label of ["A", "B", "C", "D"]) {
      const btn = getByText(label).closest("button")!;
      btn.focus();
      await act(async () => { fireEvent.keyDown(btn, { key: "Enter" }); });
    }

    const submit = getByRole("button", { name: "보내기" });
    await act(async () => { fireEvent.click(submit); });

    expect(api.respondAskUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: [
          { choice: "A" },
          { choice: "B" },
          { choice: "C" },
          { choice: "D" },
        ],
      }),
    );
  });
});
