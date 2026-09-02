/**
 * Renderer smoke tests for the 5 workflow tool UI components.
 * Mounts each component with a mocked `LvisApi` and verifies the basic
 * render contract + at least one interaction.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act, waitFor, within, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { AskUserQuestionCard } from "../components/AskUserQuestionCard.js";
import { QuestionOverlay } from "../components/QuestionOverlay.js";
import { RoutinePanel } from "../components/RoutinePanel.js";
import { SessionTodoPanel } from "../components/SessionTodoPanel.js";
import { SkillBadge } from "../components/SkillBadge.js";
import { t } from "../../../i18n/runtime.js";
import type { LvisApi } from "../types.js";

function fakeApi(overrides: Partial<LvisApi> = {}): LvisApi {
  const stub = (..._args: unknown[]) => Promise.resolve({ ok: true });
  const noopUnsub = () => () => undefined;
  return {
    // Only methods used by the components under test need real impls;
    // the rest are stubbed minimally to satisfy the type.
    listRoutines: () => Promise.resolve([]),
    dismissRoutine: stub as never,
    removeRoutine: stub as never,
    listRoutineSessions: () => Promise.resolve([]),
    onRoutineFired: noopUnsub as never,
    listSessionTodos: () => Promise.resolve([]),
    onSessionTodoChanged: noopUnsub as never,
    respondAskUserQuestion: stub as never,
    onAskUserQuestion: noopUnsub as never,
    onAgentSpawnEvent: noopUnsub as never,
    onSkillLoaded: noopUnsub as never,
    ...overrides,
  } as unknown as LvisApi;
}

describe("AskUserQuestionCard — single question", () => {
  it("renders question + choices and dispatches answers[] on click", async () => {
    const respond = vi.fn().mockResolvedValue({ ok: true });
    const api = fakeApi({ respondAskUserQuestion: respond as never });
    const onResolved = vi.fn();
    const { getByText, container, queryByTestId } = render(
      <AskUserQuestionCard
        api={api}
        request={{
          id: "q1",
          sessionId: "session-1",
          questions: [
            { question: "Continue?", choices: ["yes", "no"] },
          ],
          createdAt: 0,
        }}
        onResolved={onResolved}
      />,
    );
    expect(container.textContent).toContain("Continue?");
    // Single-question card has no pagination label.
    expect(queryByTestId("ask-step-label")).toBeNull();
    expect(getByText("yes")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(getByText("yes"));
    });
    expect(respond).toHaveBeenCalledWith({
      requestId: "q1",
      answers: [{ choice: "yes" }],
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("q1"));
  });

  it("renders Recommend badge only on the recommendedIndex chip", async () => {
    const api = fakeApi();
    const { getAllByTestId } = render(
      <AskUserQuestionCard
        api={api}
        request={{
          id: "q-recommend",
          sessionId: "session-1",
          questions: [
            {
              question: "수정 방향?",
              choices: ["A안", "B안", "C안"],
              recommendedIndex: 1,
            },
          ],
          createdAt: 0,
        }}
        onResolved={vi.fn()}
      />,
    );
    const recommendBadges = getAllByTestId("ask-badge-recommend");
    expect(recommendBadges).toHaveLength(1);
    // Badge should sit alongside the second choice ("B안") — assert by
    // walking up to the surrounding button text.
    const button = recommendBadges[0]?.closest("button");
    expect(button?.textContent).toContain("B안");
  });

  it("keeps the card pending when main rejects a stale or invalid answer", async () => {
    const respond = vi.fn().mockResolvedValue({ ok: false, error: "invalid-answer" });
    const api = fakeApi({ respondAskUserQuestion: respond as never });
    const onResolved = vi.fn();
    const { getByText, getByTestId } = render(
      <AskUserQuestionCard
        api={api}
        request={{
          id: "q-rejected",
          sessionId: "session-1",
          questions: [{ question: "Continue?", choices: ["yes", "no"] }],
          createdAt: 0,
        }}
        onResolved={onResolved}
      />,
    );

    await act(async () => {
      fireEvent.click(getByText("yes"));
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();
    expect(getByTestId("ask-user-question-card")).toBeInTheDocument();
    expect(getByText("no").closest("button")).not.toBeDisabled();
  });

  it("renders 대안 badges only on altIndices chips and skips the recommend slot", async () => {
    const api = fakeApi();
    const { getAllByTestId, queryAllByTestId } = render(
      <AskUserQuestionCard
        api={api}
        request={{
          id: "q-alt",
          sessionId: "session-1",
          questions: [
            {
              question: "방향?",
              choices: ["A", "B", "C"],
              recommendedIndex: 0,
              // 0 is the recommend slot — UI must dedupe and not double-tag.
              altIndices: [0, 2],
            },
          ],
          createdAt: 0,
        }}
        onResolved={vi.fn()}
      />,
    );
    expect(getAllByTestId("ask-badge-recommend")).toHaveLength(1);
    const altBadges = queryAllByTestId("ask-badge-alt");
    expect(altBadges).toHaveLength(1);
    expect(altBadges[0]?.closest("button")?.textContent).toContain("C");
  });

  it("does not render a manual input for legacy free-text metadata", async () => {
    const api = fakeApi();
    const { queryByTestId, queryByPlaceholderText } = render(
      <AskUserQuestionCard
        api={api}
        request={{
          id: "q-ph",
          sessionId: "session-1",
          questions: [
            {
              question: "?",
              choices: ["A", "B"],
              allowFreeText: true,
              placeholder: "다른 방향을 한 줄로",
            } as never,
          ],
          createdAt: 0,
        }}
        onResolved={vi.fn()}
      />,
    );
    expect(queryByTestId("ask-freetext-input")).toBeNull();
    expect(queryByPlaceholderText("다른 방향을 한 줄로")).toBeNull();
  });

  it("dismiss surfaces dismissed:true with no answers", async () => {
    const respond = vi.fn().mockResolvedValue({ ok: true });
    const api = fakeApi({ respondAskUserQuestion: respond as never });
    const { getByText } = render(
      <AskUserQuestionCard
        api={api}
        request={{
          id: "q-dismiss",
          sessionId: "session-1",
          questions: [{ question: "?", choices: ["계속", "중단"] }],
          createdAt: 0,
        }}
        onResolved={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(getByText("건너뛰기"));
    });
    expect(respond).toHaveBeenCalledWith({ requestId: "q-dismiss", dismissed: true });
  });
});

describe("QuestionOverlay — FIFO request identity", () => {
  it("remounts the card when a one-question head advances to a two-question head", async () => {
    const respond = vi.fn().mockResolvedValue({ ok: true });
    const api = fakeApi({ respondAskUserQuestion: respond as never });
    const onResolved = vi.fn();
    const first = {
      id: "fifo-first",
      sessionId: "session-1",
      questions: [{ question: "First?", choices: ["A", "B"] }],
      createdAt: 1,
    };
    const second = {
      id: "fifo-second",
      sessionId: "session-1",
      questions: [
        { question: "Second one?", choices: ["C", "D"] },
        { question: "Second two?", choices: ["E", "F"] },
      ],
      createdAt: 2,
    };
    const view = render(
      <QuestionOverlay api={api} requests={[first]} onResolved={onResolved} />,
    );

    await act(async () => {
      fireEvent.click(view.getByText("A"));
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("fifo-first"));

    view.rerender(
      <QuestionOverlay api={api} requests={[second]} onResolved={onResolved} />,
    );
    expect(view.getByText("Second one?")).toBeInTheDocument();
    expect(view.getByTestId("ask-step-label")).toHaveTextContent("1 / 2");
    expect(view.queryByText("A")).toBeNull();
  });

  it("focuses its first choice when a covering approval releases the composer", async () => {
    const api = fakeApi();
    const view = render(
      <div data-composer-placement="bottom" inert aria-hidden="true">
        <QuestionOverlay
          api={api}
          requests={[{
            id: "question-beneath-approval",
            sessionId: "session-1",
            questions: [{ question: "Range?", choices: ["Today", "This week"] }],
            createdAt: 1,
          }]}
          onResolved={vi.fn()}
        />
      </div>,
    );
    const composer = view.container.querySelector<HTMLElement>('[data-composer-placement]')!;
    const firstChoice = view.getByRole("option", { name: "Today", hidden: true });
    expect(firstChoice).not.toHaveFocus();

    act(() => {
      composer.inert = false;
      composer.removeAttribute("inert");
      composer.removeAttribute("aria-hidden");
    });

    await waitFor(() => expect(firstChoice).toHaveFocus());
  });
});

describe("AskUserQuestionCard — multi-question", () => {
  it("paginates 1→2→confirm and submits all answers at once", async () => {
    const respond = vi.fn().mockResolvedValue({ ok: true });
    const api = fakeApi({ respondAskUserQuestion: respond as never });
    const { getByRole, getByText, getByTestId, queryByTestId, container } = render(
      <AskUserQuestionCard
        api={api}
        request={{
          id: "multi",
          sessionId: "session-1",
          questions: [
            { question: "Where?", choices: ["서울", "부산"] },
            { question: "When?", choices: ["오늘", "내일"] },
          ],
          createdAt: 0,
        }}
        onResolved={vi.fn()}
      />,
    );
    // Step label shows pagination on multi.
    expect(getByTestId("ask-step-label").textContent).toBe("· 1 / 2");
    expect(container.textContent).toContain("Where?");
    // Picking a choice on a multi-question card does NOT auto-submit;
    // user must hit 다음/검토.
    await act(async () => {
      fireEvent.click(getByText("서울"));
    });
    expect(respond).not.toHaveBeenCalled();
    // Step 0 of 2 → button reads "다음" (next).
    await act(async () => {
      fireEvent.click(getByText("다음"));
    });
    expect(getByTestId("ask-step-label").textContent).toBe("· 2 / 2");
    await act(async () => {
      fireEvent.click(getByText("내일"));
    });
    // Last question (step total-1) → button reads "검토" (review).
    await act(async () => {
      fireEvent.click(getByText("검토"));
    });
    // Now on the confirm page — review surface present.
    expect(queryByTestId("ask-confirm-review")).not.toBeNull();
    expect(getByTestId("ask-step-label").textContent).toBe("· 검토");
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "보내기" }));
    });
    expect(respond).toHaveBeenCalledWith({
      requestId: "multi",
      answers: [{ choice: "서울" }, { choice: "내일" }],
    });
  });
});

describe("RoutinePanel", () => {
  it("renders empty-state when there are no routines", async () => {
    const api = fakeApi();
    const { findByText } = render(<RoutinePanel api={api} />);
    expect(await findByText(/등록된 루틴이 없습니다/)).toBeInTheDocument();
  });

  it("renders an active routine card", async () => {
    const api = fakeApi({
      listRoutines: () =>
        Promise.resolve([
          {
            id: "r1",
            trigger: "schedule" as const,
            execution: "notification-only" as const,
            schedule: { at: "2099-01-01T00:00:00.000Z", repeat: { kind: "daily" as const } },
            notificationTitle: "year-end",
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ]),
    });
    const { findByText } = render(<RoutinePanel api={api} />);
    expect(await findByText("year-end")).toBeInTheDocument();
  });

  it("renders past LLM routine sessions beside the routine list", async () => {
    const listRoutineSessions = vi.fn(async () => [
      {
        routineId: "r-llm",
        firedAt: "2026-05-11T04:00:00.003Z",
        sessionId: "session-routine-1",
        title: "뉴스 요약",
        preview: "뉴스 요약 완료",
      },
    ]);
    const onOpenSession = vi.fn();
    const api = fakeApi({
      listRoutines: () =>
        Promise.resolve([
          {
            id: "r-llm",
            trigger: "schedule" as const,
            execution: "llm-session" as const,
            schedule: { at: "2099-01-01T00:00:00.000Z", repeat: { kind: "daily" as const } },
            title: "뉴스 요약",
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ]),
      listRoutineSessions: listRoutineSessions as never,
    });
    const { findByTestId } = render(<RoutinePanel api={api} onOpenSession={onOpenSession} />);

    const sessionList = await findByTestId("routine-session-list");
    await waitFor(() => {
      expect(sessionList.textContent).toContain("과거 루틴 세션");
      expect(sessionList.textContent).toContain("뉴스 요약");
      expect(sessionList.textContent).toContain("뉴스 요약 완료");
    });
    expect(listRoutineSessions).toHaveBeenCalledWith("r-llm", 10);

    fireEvent.click(within(sessionList).getByText("열기"));
    expect(onOpenSession).toHaveBeenCalledWith("session-routine-1");
  });
});

describe("SessionTodoPanel", () => {
  // The chip is the trigger; the list opens in a popover (portalled to body,
  // so assertions on the list go through `document.body` / screen queries).
  // Requires the chip to be rendered already (items loaded), so callers await
  // the chip text first.
  async function openPanel(container: HTMLElement) {
    const header = container.querySelector('[data-testid="session-todo-panel"]');
    if (!header) throw new Error("session-todo chip not rendered");
    await act(async () => {
      header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("hides when no items", async () => {
    const api = fakeApi();
    const { container } = render(<SessionTodoPanel api={api} sessionId="session-todo" />);
    // Async initial fetch resolves to []; panel should not render.
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="session-todo-panel"]')).toBeNull();
  });

  it("renders items with per-row status pills when present", async () => {
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([
          { id: "t1", content: "step 1", status: "pending" },
          { id: "t2", content: "step 2", status: "completed" },
        ]),
    });
    const { container } = render(<SessionTodoPanel api={api} sessionId="session-todo" />);
    await screen.findByTestId("session-todo-panel");
    await openPanel(container);
    const list = await screen.findByTestId("session-todo-list");
    // The chip repeats the focus item's title, so rows are read from the list.
    expect(list.textContent).toContain("step 1");
    expect(list.textContent).toContain("step 2");
    // Per-row status pills survive the header-badge removal: each row keeps a
    // 대기/진행/완료 chip.
    expect(list.textContent).toContain("대기");
    expect(list.textContent).toContain("완료");
    // The removed transient header badges must no longer render.
    expect(list.textContent).not.toContain("수정");
    expect(container.querySelector('[data-testid="session-todo-continuation"]')).toBeNull();
    expect(container.querySelector('[data-testid="session-todo-fresh"]')).toBeNull();
    expect(container.querySelector('[data-testid="session-todo-added"]')).toBeNull();
    expect(container.querySelector('[data-testid="session-todo-updated"]')).toBeNull();
  });

  it("pulses the in-progress row in the expanded view so it's the focal point", async () => {
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([
          { id: "t1", content: "done thing", status: "completed" },
          { id: "t2", content: "current thing", status: "in_progress" },
          { id: "t3", content: "next thing", status: "pending" },
        ]),
    });
    const { findByTestId, queryAllByTestId, container } = render(<SessionTodoPanel api={api} sessionId="session-todo" />);
    await screen.findByTestId("session-todo-panel");
    await openPanel(container);
    const active = await findByTestId("session-todo-active-row");
    expect(active.className).toContain("animate-pulse");
    // Only the in-progress row gets the active testid — pending/completed
    // must not.
    expect(queryAllByTestId("session-todo-active-row")).toHaveLength(1);
  });

  it("shows the active item next to the count when collapsed, with pulse", async () => {
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([
          { id: "t1", content: "done thing", status: "completed" },
          { id: "t2", content: "current thing", status: "in_progress" },
          { id: "t3", content: "next thing", status: "pending" },
        ]),
    });
    const { findByText, container } = render(<SessionTodoPanel api={api} sessionId="session-todo" />);
    // Panel starts collapsed by default — the active item should already show
    // next to the count without any toggle.
    await findByText("current thing");
    const collapsed = container.querySelector('[data-testid="session-todo-collapsed-active"]');
    expect(collapsed).not.toBeNull();
    expect(collapsed!.textContent).toBe("current thing");
    expect(collapsed!.className).toContain("animate-pulse");
  });

  it("falls back to the first pending item in the collapsed header when nothing is in progress", async () => {
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([
          { id: "t1", content: "first pending", status: "pending" },
          { id: "t2", content: "second pending", status: "pending" },
        ]),
    });
    const { findByText, container } = render(<SessionTodoPanel api={api} sessionId="session-todo" />);
    // Starts collapsed; with no in_progress item the header surfaces the first
    // non-completed item instead of going blank.
    await findByText("first pending");
    const collapsed = container.querySelector('[data-testid="session-todo-collapsed-active"]');
    expect(collapsed).not.toBeNull();
    expect(collapsed!.textContent).toBe("first pending");
    // A pending (not in-progress) focus item must not pulse.
    expect(collapsed!.className).not.toContain("animate-pulse");
  });

  it("shows the dismiss X only when every item is completed and clears via the store emit", async () => {
    let pushPayload: ((p: {
      sessionId: string;
      items: Array<{ id: string; content: string; status: string }>;
    }) => void) | null = null;
    const clearSpy = vi.fn(async (_sessionId?: string) => {
      // The real clear path drives the panel away by emitting an empty list,
      // not a local hide — simulate that here.
      pushPayload?.({ sessionId: "session-dismiss", items: [] });
      return { ok: true };
    });
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([{ id: "t1", content: "only step", status: "in_progress" }]),
      clearSessionTodos: clearSpy as never,
      onSessionTodoChanged: ((handler: (p: {
        sessionId: string;
        items: Array<{ id: string; content: string; status: string }>;
      }) => void) => {
        pushPayload = handler;
        return () => undefined;
      }) as never,
    });
    const { queryByTestId, findByTestId, container } = render(
      <SessionTodoPanel api={api} sessionId="session-dismiss" />,
    );
    await screen.findByTestId("session-todo-panel");
    await openPanel(container);
    await screen.findByTestId("session-todo-list");
    // Not yet all-complete: the dismiss X must be absent.
    expect(queryByTestId("session-todo-dismiss")).toBeNull();

    // Mark the single item completed → 1/1 → dismiss X appears.
    await act(async () => {
      pushPayload!({
        sessionId: "session-dismiss",
        items: [{ id: "t1", content: "only step", status: "completed" }],
      });
    });
    const dismiss = await findByTestId("session-todo-dismiss");

    // Clicking it calls clearSessionTodos; the resulting empty-list emit
    // removes the panel entirely (returns null at items.length === 0).
    await act(async () => {
      dismiss.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(clearSpy).toHaveBeenCalledWith("session-dismiss");
    expect(queryByTestId("session-todo-panel")).toBeNull();
  });

  it("keeps a stale list snapshot from clobbering a live push (no header badges)", async () => {
    let pushPayload: ((p: {
      sessionId: string;
      items: Array<{ id: string; content: string; status: string }>;
    }) => void) | null = null;
    let resolveList!: (value: Array<{ id: string; content: string; status: string }>) => void;
    const listPromise = new Promise<Array<{ id: string; content: string; status: string }>>((resolve) => {
      resolveList = resolve;
    });
    const api = fakeApi({
      listSessionTodos: () => listPromise,
      onSessionTodoChanged: ((handler: (p: {
        sessionId: string;
        items: Array<{ id: string; content: string; status: string }>;
      }) => void) => {
        pushPayload = handler;
        return () => undefined;
      }) as never,
    });
    const { queryByText, container } = render(
      <SessionTodoPanel api={api} sessionId="session-race" />,
    );

    const firstItems = [{ id: "n1", content: "live plan", status: "pending" }];
    await act(async () => {
      pushPayload!({ sessionId: "session-race", items: firstItems });
    });
    await screen.findByTestId("session-todo-panel");

    await act(async () => {
      resolveList([{ id: "old", content: "stale list snapshot", status: "pending" }]);
      await listPromise;
    });
    // Live push wins over the late initial fetch; removed transient header
    // badges never render.
    expect(queryByText("stale list snapshot")).toBeNull();
    expect(container.querySelector('[data-testid="session-todo-fresh"]')).toBeNull();
    expect(container.querySelector('[data-testid="session-todo-continuation"]')).toBeNull();
  });

  it("ignores malformed push events without a session id", async () => {
    let pushPayload: ((p: {
      sessionId?: string;
      items: Array<{ id: string; content: string; status: string }>;
    }) => void) | null = null;
    const api = fakeApi({
      listSessionTodos: () => Promise.resolve([]),
      onSessionTodoChanged: ((handler: (p: {
        sessionId?: string;
        items: Array<{ id: string; content: string; status: string }>;
      }) => void) => {
        pushPayload = handler;
        return () => undefined;
      }) as never,
    });
    const { queryByTestId } = render(
      <SessionTodoPanel api={api} sessionId="session-strict" />,
    );
    await act(async () => {
      await Promise.resolve();
      pushPayload!({
        items: [{ id: "bad", content: "missing session", status: "pending" }],
      });
    });
    expect(queryByTestId("session-todo-panel")).toBeNull();
  });

  it("ignores malformed push payloads with a valid session id", async () => {
    let pushPayload: ((p: unknown) => void) | null = null;
    const api = fakeApi({
      listSessionTodos: () => Promise.resolve([]),
      onSessionTodoChanged: ((handler: (p: unknown) => void) => {
        pushPayload = handler;
        return () => undefined;
      }) as never,
    });
    const { queryByTestId } = render(
      <SessionTodoPanel api={api} sessionId="session-strict" />,
    );
    await act(async () => {
      await Promise.resolve();
      pushPayload!({ sessionId: "session-strict", items: null });
      pushPayload!({
        sessionId: "session-strict",
        items: [{ id: "bad", content: "bad status", status: "not-a-status" }],
      });
    });
    expect(queryByTestId("session-todo-panel")).toBeNull();
  });

  it("ignores an array push payload (an array is not a record)", async () => {
    let pushPayload: ((p: unknown) => void) | null = null;
    const api = fakeApi({
      listSessionTodos: () => Promise.resolve([]),
      onSessionTodoChanged: ((handler: (p: unknown) => void) => {
        pushPayload = handler;
        return () => undefined;
      }) as never,
    });
    const { queryByTestId } = render(
      <SessionTodoPanel api={api} sessionId="session-strict" />,
    );
    await act(async () => {
      await Promise.resolve();
      pushPayload!([{ id: "ghost", content: "array payload", status: "pending" }]);
    });
    expect(queryByTestId("session-todo-panel")).toBeNull();
  });

  it("ignores push events until the active chat session id is known", async () => {
    let pushPayload: ((p: {
      sessionId: string;
      items: Array<{ id: string; content: string; status: string }>;
    }) => void) | null = null;
    const api = fakeApi({
      listSessionTodos: () => Promise.resolve([]),
      onSessionTodoChanged: ((handler: (p: {
        sessionId: string;
        items: Array<{ id: string; content: string; status: string }>;
      }) => void) => {
        pushPayload = handler;
        return () => undefined;
      }) as never,
    });
    const { queryByTestId } = render(
      <SessionTodoPanel api={api} sessionId="" />,
    );
    await act(async () => {
      await Promise.resolve();
      pushPayload!({
        sessionId: "session-other",
        items: [{ id: "ghost", content: "wrong session", status: "pending" }],
      });
    });
    expect(queryByTestId("session-todo-panel")).toBeNull();
  });

  it("ignores malformed initial session-todo snapshots", async () => {
    const api = fakeApi({
      listSessionTodos: () => Promise.resolve(null) as never,
    });
    const { queryByTestId } = render(
      <SessionTodoPanel api={api} sessionId="session-strict" />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId("session-todo-panel")).toBeNull();
  });

  it("clears the panel when the store emits an empty list, then repopulates on the next plan", async () => {
    let pushPayload: ((p: {
      sessionId: string;
      items: Array<{ id: string; content: string; status: string }>;
    }) => void) | null = null;
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([{ id: "old", content: "old plan", status: "completed" }]),
      onSessionTodoChanged: ((handler: (p: {
        sessionId: string;
        items: Array<{ id: string; content: string; status: string }>;
      }) => void) => {
        pushPayload = handler;
        return () => undefined;
      }) as never,
    });
    const { findByText, queryByTestId } = render(
      <SessionTodoPanel api={api} sessionId="session-clear" />,
    );
    await screen.findByTestId("session-todo-panel");

    await act(async () => {
      pushPayload!({ sessionId: "session-clear", items: [] });
    });
    expect(queryByTestId("session-todo-panel")).toBeNull();

    await act(async () => {
      pushPayload!({
        sessionId: "session-clear",
        items: [{ id: "new", content: "new topic", status: "pending" }],
      });
    });
    await findByText("new topic");
    expect(queryByTestId("session-todo-panel")).toBeInTheDocument();
  });

  it("ignores push events emitted for a different session id", async () => {
    let pushPayload: ((p: {
      sessionId: string;
      items: Array<{ id: string; content: string; status: string }>;
    }) => void) | null = null;
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([{ id: "t1", content: "session-A item", status: "pending" }]),
      onSessionTodoChanged: ((handler: (p: {
        sessionId: string;
        items: Array<{ id: string; content: string; status: string }>;
      }) => void) => {
        pushPayload = handler;
        return () => undefined;
      }) as never,
    });
    const { queryByText, queryAllByText, container } = render(
      <SessionTodoPanel api={api} sessionId="session-A" />,
    );
    await screen.findByTestId("session-todo-panel");
    await openPanel(container);
    await screen.findAllByText("session-A item");
    // A foreign session emits — must NOT clobber the visible list.
    await act(async () => {
      pushPayload!({
        sessionId: "session-OTHER",
        items: [{ id: "x1", content: "stale ghost", status: "pending" }],
      });
    });
    expect(queryByText("stale ghost")).toBeNull();
    // The chip and the list row both carry the title, so more than one match is right.
    expect(queryAllByText("session-A item").length).toBeGreaterThan(0);
  });

  it("clears items immediately when the chat session id changes", async () => {
    let resolveList!: (value: Array<{ id: string; content: string; status: string }>) => void;
    const fetchPromise = new Promise<Array<{ id: string; content: string; status: string }>>((r) => {
      resolveList = r;
    });
    const fetchSpy = vi.fn(() => fetchPromise);
    const api = fakeApi({ listSessionTodos: fetchSpy as never });
    const { rerender, queryByText, container } = render(
      <SessionTodoPanel api={api} sessionId="session-A" />,
    );
    resolveList([{ id: "t1", content: "first", status: "pending" }]);
    await screen.findByTestId("session-todo-panel");
    await openPanel(container);
    await screen.findAllByText("first");
    // Swap session id — synchronously the panel should clear its visible
    // items so a stale row never lingers between sessions. The pending
    // listSessionTodos for the new id will repopulate when it resolves.
    fetchSpy.mockReturnValueOnce(Promise.resolve([]));
    rerender(<SessionTodoPanel api={api} sessionId="session-B" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByText("first")).toBeNull();
  });

  it("applies a transition class to status pills so changes don't snap", async () => {
    const api = fakeApi({
      listSessionTodos: () =>
        Promise.resolve([{ id: "t1", content: "smooth pill", status: "pending" }]),
    });
    const { container } = render(
      <SessionTodoPanel api={api} sessionId="s" />,
    );
    await screen.findByTestId("session-todo-panel");
    await openPanel(container);
    await screen.findAllByText("smooth pill");
    // The list is a portalled popover, so it is not under `container`.
    const pill = document.body.querySelector('li[data-status="pending"] span:nth-child(2)');
    expect(pill).not.toBeNull();
    expect(pill!.className).toContain("transition-colors");
  });
});


describe("SkillBadge", () => {
  it("renders the skill name", () => {
    const { container } = render(
      <TooltipProvider>
        <SkillBadge name="report-writing" description="reports" />
      </TooltipProvider>,
    );
    expect(container.textContent).toContain(t("skillBadge.loadedLabel", { name: "report-writing" }));
  });
});
