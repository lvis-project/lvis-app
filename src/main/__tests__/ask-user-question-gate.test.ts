/**
 * AskUserQuestionGate — timeout coverage + multi-question contract.
 *
 * The gate must:
 *   1. Resolve `{ dismissed: true }` after the configured timeout.
 *   2. Send a `lvis:ask-user-question:timeout` IPC event so the renderer
 *      can drop the stale card before the user clicks into a no-op.
 *   3. Accept 1–4 questions per card and surface them as a single request
 *      payload to the renderer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AskUserQuestionGate,
  IPC_ASK_USER_QUESTION_TIMEOUT,
} from "../ask-user-question-gate.js";
import { MAX_FREE_TEXT_LENGTH } from "../../shared/ask-user-question-limits.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";

/** Convenience — most tests only care about the wait/abort/timeout shape. */
function single(question: string) {
  return { sessionId: "session-1", questions: [{ question, choices: ["Continue", "Stop"] }] };
}

describe("AskUserQuestionGate — timeout path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with dismissed=true after 5 minutes and emits timeout event", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 5 * 60 * 1000);
    const promise = gate.ask(single("still there?"));
    // Drain the request emission tick first.
    expect(wc.send).toHaveBeenCalledWith(
      "lvis:ask-user-question:request",
      expect.objectContaining({
        questions: [expect.objectContaining({ question: "still there?" })],
      }),
    );

    // Fast-forward past the 5-minute timeout.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const response = await promise;
    expect(response.dismissed).toBe(true);

    // M2: renderer must be notified via the dedicated timeout channel.
    const timeoutCall = wc.send.mock.calls.find(
      (call) => call[0] === IPC_ASK_USER_QUESTION_TIMEOUT,
    );
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall![1]).toMatchObject({ requestId: response.requestId });
  });

  it("caps concurrent pending requests to 5", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);
    const slots: Array<Promise<unknown>> = [];
    // Fill the gate up to the cap.
    for (let i = 0; i < 5; i++) {
      slots.push(gate.ask(single(`q-${i}`)));
    }
    expect(gate.pendingCount).toBe(5);
    // The 6th must be dismissed immediately, not queued.
    const overflow = await gate.ask(single("q-6"));
    expect(overflow.dismissed).toBe(true);
    // Pending count unchanged — the overflow never registered.
    expect(gate.pendingCount).toBe(5);
    // Cleanup so unrelated timers don't leak.
    gate.disposeAll();
    await Promise.allSettled(slots);
  });

  // Regression: the user's 중단 button must unblock a pending question
  // immediately. Before this, the gate sat on its 5-minute timer even after
  // the conversation loop had aborted, and the abort button felt dead.
  it("aborts immediately when the abortSignal fires and notifies the renderer", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);
    const ac = new AbortController();
    const promise = gate.ask({ ...single("blocking?"), abortSignal: ac.signal });
    expect(gate.pendingCount).toBe(1);

    ac.abort();
    const response = await promise;
    expect(response.dismissed).toBe(true);
    expect(gate.pendingCount).toBe(0);

    // Renderer must be told the card is gone, same channel as the timeout
    // path, so the composer-dock card disappears even if the user never clicked.
    const timeoutCall = wc.send.mock.calls.find(
      (call) => call[0] === IPC_ASK_USER_QUESTION_TIMEOUT,
    );
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall![1]).toMatchObject({ requestId: response.requestId });
  });

  // Regression for the LOW from PR #287's review: a long-lived
  // AbortController reused across several sequential asks must not leak an
  // abort listener every time the user resolves a question via IPC.
  it("removes the abort listener when the user resolves via IPC (no leak across sequential asks)", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");

    const slot = gate.ask({ ...single("first?"), abortSignal: ac.signal });
    // Find the request id that was sent to the renderer.
    const reqCall = wc.send.mock.calls.find(
      (c) => c[0] === "lvis:ask-user-question:request",
    );
    const requestId = (reqCall![1] as { id: string }).id;

    // User confirms — this is what `ipcMain.handle("lvis:ask-user-question:respond")` calls.
    gate.resolve({ requestId, answers: [{ choice: "Continue" }] });
    const response = await slot;
    expect(response.answers).toEqual([{ choice: "Continue" }]);

    // The listener registered on the controller's signal must have been cleaned up,
    // so a later abort on the same controller does not invoke a stale handler.
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(gate.pendingCount).toBe(0);
  });

  it("returns immediately as dismissed when called with an already-aborted signal", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);
    const ac = new AbortController();
    ac.abort();

    const response = await gate.ask({ ...single("stale"), abortSignal: ac.signal });
    expect(response.dismissed).toBe(true);
    // Never registered as pending, so the request event never fires.
    expect(gate.pendingCount).toBe(0);
    expect(wc.send).not.toHaveBeenCalled();
  });

  // Dev-mode reload destroys the boot-time webContents. A lazy resolver lets
  // the gate keep working against the current window after reload.
  it("uses the lazy resolver every send so a fresh webContents is picked up after reload", async () => {
    const stale = makeMockWebContents();
    stale.isDestroyed.mockReturnValue(true);
    const fresh = makeMockWebContents();
    let current = stale;

    const gate = new AskUserQuestionGate(() => (current.isDestroyed() ? null : (current as never)), 60_000);

    // Stale window: gate must short-circuit to dismissed.
    const dismissed = await gate.ask(single("before reload"));
    expect(dismissed.dismissed).toBe(true);
    expect(stale.send).not.toHaveBeenCalled();

    // Simulate a reload — fresh webContents is now current.
    current = fresh;
    const slot = gate.ask(single("after reload"));
    expect(fresh.send).toHaveBeenCalledWith(
      "lvis:ask-user-question:request",
      expect.objectContaining({
        questions: [expect.objectContaining({ question: "after reload" })],
      }),
    );
    gate.disposeAll();
    await slot;
  });
});

describe("AskUserQuestionGate — multi-question contract", () => {
  it("rejects empty or oversized questions[] without engaging the timer", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);

    const empty = await gate.ask({ sessionId: "session-1", questions: [] });
    expect(empty.dismissed).toBe(true);
    expect(gate.pendingCount).toBe(0);
    expect(wc.send).not.toHaveBeenCalled();

    const noChoices = await gate.ask({ sessionId: "session-1",
      questions: [{ question: "Pick one" } as never],
    });
    expect(noChoices.dismissed).toBe(true);
    expect(gate.pendingCount).toBe(0);
    expect(wc.send).not.toHaveBeenCalled();

    const tooManyChoices = await gate.ask({ sessionId: "session-1",
      questions: [{ question: "Pick one", choices: ["A", "B", "C", "D"] }],
    });
    expect(tooManyChoices.dismissed).toBe(true);
    expect(gate.pendingCount).toBe(0);

    const nonStringChoice = await gate.ask({ sessionId: "session-1",
      questions: [{ question: "Pick one", choices: ["A", 7] } as never],
    });
    expect(nonStringChoice.dismissed).toBe(true);
    expect(gate.pendingCount).toBe(0);

    const duplicateChoices = await gate.ask({ sessionId: "session-1",
      questions: [{ question: "Pick one", choices: ["A", " A "] }],
    });
    expect(duplicateChoices.dismissed).toBe(true);
    expect(gate.pendingCount).toBe(0);

    const overlongChoice = await gate.ask({ sessionId: "session-1",
      questions: [{ question: "Pick one", choices: ["x".repeat(21)] }],
    });
    expect(overlongChoice.dismissed).toBe(true);
    expect(gate.pendingCount).toBe(0);

    const oversized = await gate.ask({ sessionId: "session-1",
      questions: Array.from({ length: 5 }, (_, i) => ({
        question: `q-${i}`,
        choices: ["A", "B"],
      })),
    });
    expect(oversized.dismissed).toBe(true);
    expect(gate.pendingCount).toBe(0);
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("emits one request payload carrying all questions in order", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);

    const slot = gate.ask({ sessionId: "session-1",
      questions: [
        { question: "Where?", choices: ["A", "B"] },
        { question: "When?", choices: ["Now", "Later"] },
        { question: "Why?", choices: ["Required", "Optional"] },
      ],
    });

    const reqCall = wc.send.mock.calls.find(
      (c) => c[0] === "lvis:ask-user-question:request",
    );
    expect(reqCall).toBeDefined();
    const payload = reqCall![1] as { sessionId: string; questions: Array<{ question: string }> };
    expect(payload.questions.map((q) => q.question)).toEqual(["Where?", "When?", "Why?"]);
    // The channel is window-wide; only the named conversation may draw the card.
    expect(payload.sessionId).toBe("session-1");

    gate.disposeAll();
    await slot;
  });

  it("preserves recommendation metadata and labels in the renderer request", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);

    const slot = gate.ask({ sessionId: "session-1",
      questions: [
        {
          question: "범위는?",
          choices: ["국내", "국제", "IT/경제"],
          recommendedIndex: 2,
          altIndices: [0, 1],
          summaryHint: "범위",
        },
      ],
    });

    const reqCall = wc.send.mock.calls.find(
      (c) => c[0] === "lvis:ask-user-question:request",
    );
    expect(reqCall).toBeDefined();
    expect(reqCall![1]).toMatchObject({
      questions: [
        {
          question: "범위는?",
          choices: ["국내", "국제", "IT/경제"],
          recommendedIndex: 2,
          altIndices: [0, 1],
          summaryHint: "범위",
        },
      ],
    });

    gate.disposeAll();
    await slot;
  });

  it("propagates per-question answers from resolve() back to the awaiting caller", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);

    const slot = gate.ask({ sessionId: "session-1",
      questions: [
        { question: "Where?", choices: ["서울", "부산"] },
        { question: "When?", choices: ["오늘", "내일"] },
      ],
    });
    const reqCall = wc.send.mock.calls.find(
      (c) => c[0] === "lvis:ask-user-question:request",
    );
    const requestId = (reqCall![1] as { id: string }).id;

    gate.resolve({
      requestId,
      answers: [{ choice: "서울" }, { choice: "내일" }],
    });

    const response = await slot;
    expect(response.answers).toEqual([{ choice: "서울" }, { choice: "내일" }]);
    expect(response.dismissed).toBeFalsy();
  });

  it("keeps the request pending until every answer is bound to its declared choices", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);

    const slot = gate.ask({ sessionId: "session-1",
      questions: [
        { question: "Where?", choices: ["서울", "부산"] },
        { question: "Tags?", choices: ["AI", "보안", "UX"], allowMultiple: true },
      ],
    });
    const reqCall = wc.send.mock.calls.find(
      (c) => c[0] === "lvis:ask-user-question:request",
    );
    const requestId = (reqCall![1] as { id: string }).id;

    // Neither question asked for a typed answer, so text is not an answer
    // channel the renderer may open on its own.
    expect(gate.resolve({
      requestId,
      answers: [{ freeText: "수기 응답" }, { choices: ["AI"] }],
    })).toBe(false);
    expect(gate.resolve({
      requestId,
      answers: [{ choice: "임의 입력" }, { choices: ["AI"] }],
    })).toBe(false);
    expect(gate.resolve({
      requestId,
      answers: [{ choice: "서울" }, { choices: ["AI", "AI"] }],
    })).toBe(false);
    expect(gate.pendingCount).toBe(1);

    expect(gate.resolve({
      requestId,
      answers: [{ choice: "부산" }, { choices: ["UX", "AI"] }],
    })).toBe(true);
    await expect(slot).resolves.toEqual({
      requestId,
      answers: [{ choice: "부산" }, { choices: ["AI", "UX"] }],
    });
    expect(gate.pendingCount).toBe(0);
  });

  it("carries allowFreeText and its placeholder into the renderer request", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);

    const slot = gate.ask({
      sessionId: "session-1",
      questions: [
        { question: "몇 개?", choices: [], allowFreeText: true, placeholder: "숫자" },
        // A placeholder without the field it belongs to has nothing to sit in.
        { question: "언제?", choices: ["오늘"], placeholder: "무시됨" },
      ],
    });

    const reqCall = wc.send.mock.calls.find(
      (c) => c[0] === "lvis:ask-user-question:request",
    );
    expect(reqCall![1]).toMatchObject({
      questions: [
        { choices: [], allowFreeText: true, placeholder: "숫자" },
        { choices: ["오늘"] },
      ],
    });
    const second = (reqCall![1] as { questions: Array<Record<string, unknown>> }).questions[1];
    expect(second.allowFreeText).toBeUndefined();
    expect(second.placeholder).toBeUndefined();

    gate.disposeAll();
    await slot;
  });

  it("rejects a question that offers neither choices nor a typed answer", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);

    await expect(
      gate.ask({ sessionId: "session-1", questions: [{ question: "Pick", choices: [] }] }),
    ).resolves.toMatchObject({ dismissed: true });
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("admits a typed answer only where the question asked for one, trimmed and capped", async () => {
    const wc = makeMockWebContents();
    const gate = new AskUserQuestionGate(wc as never, 60_000);

    const slot = gate.ask({
      sessionId: "session-1",
      questions: [
        { question: "몇 개?", choices: [], allowFreeText: true },
        { question: "분야?", choices: ["AI", "UX"], allowMultiple: true, allowFreeText: true },
      ],
    });
    const reqCall = wc.send.mock.calls.find(
      (c) => c[0] === "lvis:ask-user-question:request",
    );
    const requestId = (reqCall![1] as { id: string }).id;

    // Blank once trimmed is no answer at all.
    expect(gate.resolve({
      requestId,
      answers: [{ freeText: "   " }, { choices: ["AI"] }],
    })).toBe(false);
    // Past the cap the text stops being an answer and becomes a payload.
    expect(gate.resolve({
      requestId,
      answers: [{ freeText: "x".repeat(MAX_FREE_TEXT_LENGTH + 1) }, { choices: ["AI"] }],
    })).toBe(false);
    // The first question has no chips, so an empty multi-select with no text
    // leaves it unanswered.
    expect(gate.resolve({
      requestId,
      answers: [{ freeText: "10" }, {}],
    })).toBe(false);
    expect(gate.pendingCount).toBe(1);

    expect(gate.resolve({
      requestId,
      answers: [
        { freeText: "  10  " },
        { choices: ["UX", "AI"], freeText: "직접 만든 도구" },
      ],
    })).toBe(true);
    await expect(slot).resolves.toEqual({
      requestId,
      answers: [
        { freeText: "10" },
        { choices: ["AI", "UX"], freeText: "직접 만든 도구" },
      ],
    });
  });
});
