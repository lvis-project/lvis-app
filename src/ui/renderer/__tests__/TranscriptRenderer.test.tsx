/**
 * TranscriptRenderer — shared-core isolation contract.
 *
 * PR1 extracts the main-chat render loop (formerly `useTranscriptEntries`) into
 * a context-free `<TranscriptRenderer>` so side-chat / sub-agent sources (PR2 /
 * PR3) can reuse it by omitting optional prop clusters. The true regression risk
 * of that reshape is NOT a type error — it is a *silent* one: forgetting a
 * default value makes footer actions / stars vanish (or crash) at
 * runtime with no compile-time signal.
 *
 * These tests render the core directly with ONLY the three required props and
 * lock the default-value contract:
 *   (a) no crash,
 *   (b) no edit / fork / star hover actions,
 *   (c) no TurnActionBar retry/fork/star footer buttons,
 *   (d) WorkGroup still collapses mid-turn work.
 * A parallel "fully-wired" case asserts the actions DO appear once their
 * callbacks are supplied — i.e. suppression keys off callback presence.
 *
 * The main-path visual regression net stays in ChatView.test.tsx (which renders
 * the full <App/> through this same core). If PR1 is truly pure, that suite
 * passes untouched.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { withTz, userEntry } from "../../../__tests__/test-helpers.js";
import { fireEvent, render } from "@testing-library/react";
import type React from "react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { TranscriptRenderer, type TurnSummary } from "../components/TranscriptRenderer.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { TEST_IDS } from "../../../shared/test-ids.js";

// Radix Tooltip (used by WorkGroup / TurnActionBar primitives) requires a
// provider in the tree — the real app mounts it in App.tsx. Wrap the
// isolated core the same way so these unit renders mirror production context.
const renderCore = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

const assistant = (
  text: string,
  extra: Partial<Extract<ChatEntry, { kind: "assistant" }>> = {},
): ChatEntry => ({ kind: "assistant", text, ...extra });
const toolGroup = (toolUseId = "t1"): ChatEntry => ({
  kind: "tool_group",
  groupId: "g",
  groupIds: ["g"],
  status: "done",
  tools: [{ toolUseId, name: "x", displayOrder: 0, status: "done" }],
});

// Korean labels — the jsdom vitest project pins the runtime locale to ko.
const RETRY_TITLE = "다시 시도 (깊이: high)";
const EDIT_TITLE = "편집"; // chatView.editButtonTitle
const RETURN_HERE_TITLE = "여기로 되돌아가기"; // chatView.returnHereButtonTitle

const completedTurnSummary = (): Map<number, TurnSummary> => new Map([[
  0,
  {
    turnDurationMs: 250,
    toolCount: 0,
    cumulativeToolMs: 0,
    tokensIn: 120,
    freshInputTokens: 100,
    tokensOut: 20,
  },
]]);

describe("TranscriptRenderer — minimal (required-only) contract", () => {
  const minimal = [userEntry("q"), assistant("a")];

  it("renders without crashing when only entries/streaming/currentSessionId are passed", () => {
    const { container } = renderCore(
      <TranscriptRenderer entries={minimal} streaming={false} currentSessionId="s1" />,
    );
    expect(container.textContent).toContain("q");
    expect(container.textContent).toContain("a");
  });

  it("omits edit / fork / star hover actions when the action clusters are absent", () => {
    const { queryByTitle } = renderCore(
      <TranscriptRenderer entries={minimal} streaming={false} currentSessionId="s1" />,
    );
    // The user-bubble hover actions (edit) are gated on callback presence.
    expect(queryByTitle(EDIT_TITLE)).toBeNull();
  });

  it("omits the TurnActionBar retry footer button when actions cluster is absent", () => {
    const { queryByTitle } = renderCore(
      <TranscriptRenderer entries={minimal} streaming={false} currentSessionId="s1" />,
    );
    expect(queryByTitle(RETRY_TITLE)).toBeNull();
  });

  it("still collapses mid-turn work into a WorkGroup", () => {
    const entries = [userEntry("q"), toolGroup(), assistant("done")];
    const { getAllByTestId } = renderCore(
      <TranscriptRenderer entries={entries} streaming={false} currentSessionId="s1" />,
    );
    // The intermediate tool_group collapses into exactly one work-group; the
    // final assistant renders outside it. This is the heart of the unified
    // render and must survive extraction unchanged.
    expect(getAllByTestId("work-group").length).toBe(1);
  });

  it("keeps a clean final answer's completion label when invisible metadata precedes it", () => {
    const { getByTestId, getByText } = renderCore(
      <TranscriptRenderer
        entries={[
          userEntry("q"),
          toolGroup(),
          { kind: "context_usage", tokensIn: 120, source: "compact-estimate" },
          assistant("final answer"),
        ]}
        streaming={false}
        currentSessionId="s1"
      />,
    );

    expect(getByTestId("work-group").textContent).toContain("작업 완료");
    expect(getByText("final answer")).toBeTruthy();
  });

  it("keeps one live thinking status, then folds non-final work under the completed-turn summary", () => {
    const thought = "답변 전에 필요한 정보를 확인합니다.";
    const liveEntries: ChatEntry[] = [
      userEntry("q"),
      { kind: "reasoning", text: thought, streaming: true },
    ];
    const view = renderCore(
      <TranscriptRenderer entries={liveEntries} streaming currentSessionId="s1" />,
    );

    const liveGroup = view.getByTestId("work-group");
    expect(liveGroup.textContent).toContain("생각 중...");
    expect(liveGroup.textContent).not.toContain(thought);
    expect(view.getAllByText("생각 중...")).toHaveLength(1);

    const summary = completedTurnSummary();
    const completed = summary.get(0);
    if (!completed) throw new Error("test turn summary missing");
    completed.turnDurationMs = 72_000;
    const completedEntries: ChatEntry[] = [
      userEntry("q"),
      { kind: "reasoning", text: thought },
      toolGroup("completed-tool"),
      assistant("final answer"),
    ];
    view.rerender(
      <TooltipProvider>
        <TranscriptRenderer
          entries={completedEntries}
          streaming={false}
          currentSessionId="s1"
          turnSummaryByTurnStart={summary}
        />
      </TooltipProvider>,
    );

    const completedGroup = view.getByTestId("work-group");
    expect(completedGroup.textContent).toContain("작업 완료 1분 12초");
    expect(completedGroup.textContent).not.toContain(thought);
    expect(view.getByText("final answer")).toBeTruthy();

    fireEvent.click(completedGroup.querySelector("button")!);
    expect(completedGroup.textContent).toContain("생각 완료");
    expect(completedGroup.textContent).toContain("x");
    const reasoningButton = Array.from(completedGroup.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("생각 완료"),
    );
    expect(reasoningButton).toBeTruthy();
    fireEvent.click(reasoningButton!);
    expect(completedGroup.textContent).toContain(thought);
  });

  it("uses the WorkGroup header for a provider-status placeholder", () => {
    const status = "생각 중... 모델 응답을 다시 기다리는 중입니다. (2/5)";
    const { getByTestId, queryByTestId } = renderCore(
      <TranscriptRenderer
        entries={[
          userEntry("q"),
          { kind: "assistant", text: status, streaming: true, phase: "status" },
        ]}
        streaming
        currentSessionId="s1"
      />,
    );

    expect(getByTestId("work-group").textContent).toContain(status);
    expect(queryByTestId("assistant-message-body")).toBeNull();
  });

  it("folds a reasoning-only turn after its authoritative summary arrives", () => {
    const thought = "결과를 확인합니다.";
    const summary = completedTurnSummary();
    const current = summary.get(0);
    if (!current) throw new Error("test turn summary missing");
    current.turnDurationMs = 0;

    const { getByTestId } = renderCore(
      <TranscriptRenderer
        entries={[
          userEntry("q"),
          { kind: "reasoning", text: thought },
          {
            kind: "turn_summary",
            turnDurationMs: 0,
            toolCount: 0,
            cumulativeToolMs: 0,
            tokensIn: 120,
            freshInputTokens: 100,
            tokensOut: 20,
          },
        ]}
        streaming={false}
        currentSessionId="s1"
        turnSummaryByTurnStart={summary}
      />,
    );

    const group = getByTestId("work-group");
    expect(group.textContent).toContain("작업 완료 0초");
    expect(group.textContent).not.toContain(thought);
  });

  const terminalStates: Array<[string, Partial<Extract<ChatEntry, { kind: "assistant" }>>]> = [
    ["ordinary error", { terminalError: true }],
    ["stream error", { systemNotice: "stream-error" as const }],
    ["interrupted turn", { interrupted: true }],
  ];

  it.each(terminalStates)("does not call a settled %s work group complete", (_case, terminalState) => {
    const { getByTestId } = renderCore(
      <TranscriptRenderer
        entries={[userEntry("q"), toolGroup(), assistant("terminal state", terminalState)]}
        streaming={false}
        currentSessionId="s1"
      />,
    );

    expect(getByTestId("work-group").textContent).not.toContain("작업 완료");
  });

  it("can force historical WorkGroups open for read-only companion surfaces", () => {
    const entries = [userEntry("q"), toolGroup("forced-tool"), assistant("done")];
    const { getByTestId } = renderCore(
      <TranscriptRenderer
        entries={entries}
        streaming={false}
        currentSessionId="s1"
        workGroupsForceOpen
      />,
    );
    expect(getByTestId("work-group").textContent).toContain("x");
  });

  it("hides token and cost estimates when the active runtime has no verified usage contract", () => {
    const { queryByTestId } = renderCore(
      <TranscriptRenderer
        entries={[userEntry("q"), assistant("a")]}
        streaming={false}
        currentSessionId="s1"
        turnSummaryByTurnStart={completedTurnSummary()}
        showTokenCostBadge={false}
      />,
    );
    expect(queryByTestId(TEST_IDS.tokenCostBadge)).toBeNull();
  });

  it("keeps non-billable subscription telemetry visible when API pricing is gated off", () => {
    const summary = completedTurnSummary();
    const current = summary.get(0);
    if (!current) throw new Error("test turn summary missing");
    current.subscriptionUsage = [{
      provider: "codex",
      model: "gpt-5.4",
      source: "provider-reported",
      billable: false,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    }];

    const { getByTestId } = renderCore(
      <TranscriptRenderer
        entries={[userEntry("q"), assistant("a")]}
        streaming={false}
        currentSessionId="s1"
        turnSummaryByTurnStart={summary}
        showTokenCostBadge={false}
      />,
    );
    expect(getByTestId(TEST_IDS.tokenCostBadge).getAttribute("data-usage-kind")).toBe("subscription");
  });

  it("continues to show token and cost estimates by default for runtimes with a usage contract", () => {
    const { getByTestId } = renderCore(
      <TranscriptRenderer entries={[userEntry("q"), assistant("a")]} streaming={false} currentSessionId="s1" turnSummaryByTurnStart={completedTurnSummary()} />,
    );
    expect(getByTestId(TEST_IDS.tokenCostBadge)).toBeTruthy();
  });
});

describe("TranscriptRenderer — processing detail", () => {
  const processingEntries: ChatEntry[] = [
    userEntry("question"),
    { kind: "reasoning", text: "private reasoning", streaming: false },
    assistant("intermediate narration", { phase: "work" }),
    toolGroup("matrix-tool"),
    assistant("final answer", { phase: "final" }),
  ];

  for (const [level, showsReasoning, showsIntermediate] of [
    ["tools", false, false],
    ["reasoning", true, false],
    ["full", true, true],
  ] as const) {
    it(`${level} renders the exact work-item matrix`, () => {
      const { container, getByTestId } = renderCore(
        <TranscriptRenderer
          entries={processingEntries}
          streaming={false}
          currentSessionId={`matrix-${level}`}
          processingDisplayLevel={level}
          workGroupsForceOpen
        />,
      );

      const workGroup = getByTestId("work-group");
      expect(workGroup.textContent).toContain("x");
      expect(workGroup.textContent?.includes("생각 완료")).toBe(showsReasoning);
      expect(workGroup.textContent?.includes("intermediate narration")).toBe(showsIntermediate);
      expect(container.textContent).toContain("final answer");
    });
  }

  it("opens only the completed work group containing the current reasoning search match", () => {
    const entries: ChatEntry[] = [
      userEntry("first question"),
      { kind: "reasoning", text: "first reasoning", streaming: false },
      assistant("first final", { phase: "final" }),
      userEntry("second question"),
      { kind: "reasoning", text: "second reasoning", streaming: false },
      assistant("second final", { phase: "final" }),
    ];
    const { container } = renderCore(
      <TranscriptRenderer
        entries={entries}
        streaming={false}
        currentSessionId="grouped-reasoning-search"
        processingDisplayLevel="reasoning"
        search={{
          searchOpen: true,
          searchMatches: [1],
          searchMatchSet: new Set([1]),
          searchIdx: 0,
          searchHighlight: "reasoning",
        }}
      />,
    );

    const target = container.querySelector<HTMLElement>('[data-chat-entry-index="1"]');
    expect(target).toBeTruthy();
    expect(target?.className).toContain("ring-2");
    expect(container.querySelector('[data-chat-entry-index="4"]')).toBeNull();
  });

  it("moves the current search ring between reasoning entries in the same work group", () => {
    const entries: ChatEntry[] = [
      userEntry("question"),
      { kind: "reasoning", text: "first reasoning", streaming: false },
      { kind: "reasoning", text: "second reasoning", streaming: false },
      assistant("final", { phase: "final" }),
    ];
    const renderWithSearchIndex = (searchIdx: number) => (
      <TooltipProvider>
        <TranscriptRenderer
          entries={entries}
          streaming={false}
          currentSessionId="same-group-reasoning-search"
          processingDisplayLevel="reasoning"
          search={{
            searchOpen: true,
            searchMatches: [1, 2],
            searchMatchSet: new Set([1, 2]),
            searchIdx,
            searchHighlight: "reasoning",
          }}
        />
      </TooltipProvider>
    );
    const { container, rerender } = render(renderWithSearchIndex(0));

    const first = container.querySelector<HTMLElement>('[data-chat-entry-index="1"]');
    const second = container.querySelector<HTMLElement>('[data-chat-entry-index="2"]');
    expect(first?.className).toContain("ring-2");
    expect(second?.className).toContain("ring-1");

    rerender(renderWithSearchIndex(1));

    const updatedFirst = container.querySelector<HTMLElement>('[data-chat-entry-index="1"]');
    const updatedSecond = container.querySelector<HTMLElement>('[data-chat-entry-index="2"]');
    expect(updatedFirst?.className).toContain("ring-1");
    expect(updatedFirst?.className).not.toContain("ring-2");
    expect(updatedSecond?.className).toContain("ring-2");
  });

  it.each(["reasoning", "full"] as const)(
    "exposes standalone reasoning for navigation at %s detail",
    (processingDisplayLevel) => {
      const { container } = renderCore(
        <TranscriptRenderer
          entries={[
            { kind: "reasoning", text: "standalone reasoning", streaming: true },
          ]}
          streaming
          currentSessionId={`standalone-reasoning-${processingDisplayLevel}`}
          processingDisplayLevel={processingDisplayLevel}
          search={{
            searchOpen: true,
            searchMatches: [0],
            searchMatchSet: new Set([0]),
            searchIdx: 0,
            searchHighlight: "reasoning",
          }}
        />,
      );

      const target = container.querySelector<HTMLElement>('[data-chat-entry-index="0"]');
      expect(target).toBeTruthy();
      expect(target?.className).toContain("ring-2");
    },
  );

  it("treats a phase-less persisted assistant before a tool as intermediate work", () => {
    const entries: ChatEntry[] = [
      userEntry("question"),
      assistant("persisted intermediate"),
      toolGroup("persisted-tool"),
      assistant("persisted final"),
    ];
    const { queryByText, rerender } = renderCore(
      <TranscriptRenderer
        entries={entries}
        streaming={false}
        currentSessionId="persisted"
        processingDisplayLevel="reasoning"
        workGroupsForceOpen
      />,
    );
    expect(queryByText("persisted intermediate")).toBeNull();
    expect(queryByText("persisted final")).toBeTruthy();

    rerender(
      <TooltipProvider>
        <TranscriptRenderer
          entries={entries}
          streaming={false}
          currentSessionId="persisted"
          processingDisplayLevel="full"
          workGroupsForceOpen
        />
      </TooltipProvider>,
    );
    expect(queryByText("persisted intermediate")).toBeTruthy();
  });

  it("keeps final, error, interrupted, and provider-status assistant rows visible at tools level", () => {
    const entries: ChatEntry[] = [
      userEntry("question"),
      assistant("retrying provider", { phase: "status", streaming: true }),
      assistant("visible ordinary error", { phase: "work", terminalError: true }),
      assistant("visible stream error", { phase: "work", systemNotice: "stream-error" }),
      assistant("visible interrupted work", { phase: "work", interrupted: true }),
      toolGroup("required-tool"),
      assistant("always visible final", { phase: "final" }),
    ];
    const { container } = renderCore(
      <TranscriptRenderer
        entries={entries}
        streaming={false}
        currentSessionId="required-status"
        processingDisplayLevel="tools"
        workGroupsForceOpen
      />,
    );

    expect(container.textContent).toContain("retrying provider");
    expect(container.textContent).toContain("visible ordinary error");
    expect(container.textContent).toContain("visible stream error");
    expect(container.textContent).toContain("visible interrupted work");
    expect(container.textContent).toContain("always visible final");
  });

  it("withholds ambiguous live text until assistant_round identifies it as final", () => {
    const { queryByText, rerender } = renderCore(
      <TranscriptRenderer
        entries={[userEntry("question"), assistant("ambiguous stream", { streaming: true })]}
        streaming
        currentSessionId="ambiguous"
        processingDisplayLevel="reasoning"
      />,
    );
    expect(queryByText("ambiguous stream")).toBeNull();

    rerender(
      <TooltipProvider>
        <TranscriptRenderer
          entries={[userEntry("question"), assistant("final stream", { phase: "final" })]}
          streaming
          currentSessionId="ambiguous"
          processingDisplayLevel="reasoning"
          workGroupsForceOpen
        />
      </TooltipProvider>,
    );
    expect(queryByText("final stream")).toBeTruthy();
  });

  it("omits a completed WorkGroup when every intermediate row is hidden", () => {
    const { queryByTestId, getByText } = renderCore(
      <TranscriptRenderer
        entries={[
          userEntry("question"),
          { kind: "reasoning", text: "hidden reasoning", streaming: false },
          assistant("hidden narration", { phase: "work" }),
          assistant("final answer", { phase: "final" }),
        ]}
        streaming={false}
        currentSessionId="hidden-only"
        processingDisplayLevel="tools"
      />,
    );

    expect(queryByTestId("work-group")).toBeNull();
    expect(getByText("final answer")).toBeTruthy();
  });
});

describe("TranscriptRenderer — permission review attaches to its tool row", () => {
  const review = (
    toolUseId: string,
    extra: Partial<Extract<ChatEntry, { kind: "permission_review" }>> = {},
  ): ChatEntry => ({
    kind: "permission_review",
    status: "auto_approved",
    toolName: "x",
    groupId: "g",
    toolUseId,
    displayOrder: 0,
    verdictLevel: "low",
    ...extra,
  });

  it("renders the verdict inside the tool row when the tool call exists", () => {
    const entries = [userEntry("q"), review("t1"), toolGroup("t1"), assistant("done")];
    const { getByTestId } = renderCore(
      <TranscriptRenderer
        entries={entries}
        streaming={false}
        currentSessionId="s1"
        workGroupsForceOpen
      />,
    );
    const card = getByTestId("permission-review-status-card");
    expect(card.getAttribute("data-variant")).toBe("attached");
    // The chip lives inside the tool_group entry (index 2), not as its sibling.
    expect(getByTestId("work-group").contains(card)).toBe(true);
    expect(card.closest("[data-chat-entry-index]")?.getAttribute("data-chat-entry-index")).toBe("2");
  });

  it("keeps the standalone card while no tool row carries that tool call", () => {
    const entries = [userEntry("q"), review("pending", { status: "needs_approval" }), assistant("done")];
    const { getByTestId } = renderCore(
      <TranscriptRenderer
        entries={entries}
        streaming={false}
        currentSessionId="s1"
        workGroupsForceOpen
      />,
    );
    const card = getByTestId("permission-review-status-card");
    expect(card.getAttribute("data-variant")).toBe("standalone");
    expect(card.getAttribute("data-status")).toBe("needs_approval");
  });

  it("attaches only the verdict whose tool call is present", () => {
    const entries = [
      userEntry("q"),
      review("t1"),
      review("orphan", { status: "failed" }),
      toolGroup("t1"),
      assistant("done"),
    ];
    const { getAllByTestId } = renderCore(
      <TranscriptRenderer
        entries={entries}
        streaming={false}
        currentSessionId="s1"
        workGroupsForceOpen
      />,
    );
    const variants = getAllByTestId("permission-review-status-card").map((card) =>
      card.getAttribute("data-variant"),
    );
    expect(variants.sort()).toEqual(["attached", "standalone"]);
  });

  it("opens the work group for a call the parent agent answered", () => {
    // No dock ever showed these calls. A collapsed group would leave the only
    // record of a decision made without the user folded away by default.
    for (const status of ["parent_approved", "parent_denied"] as const) {
      const entries = [userEntry("q"), review("t1", { status }), toolGroup("t1"), assistant("done")];
      const { getByTestId, unmount } = renderCore(
        <TranscriptRenderer entries={entries} streaming={false} currentSessionId="s1" />,
      );
      const card = getByTestId("permission-review-status-card");
      expect(card.getAttribute("data-variant")).toBe("attached");
      expect(card.getAttribute("data-status")).toBe(status);
      unmount();
    }
  });
});

describe("TranscriptRenderer — action suppression keys off callback presence", () => {
  it("renders the retry footer button once the actions cluster IS supplied", () => {
    const onRetryEffort = vi.fn();
    const { queryByTitle } = renderCore(
      <TranscriptRenderer
        entries={[userEntry("q"), assistant("a")]}
        streaming={false}
        currentSessionId="s1"
        actions={{ onRetryEffort }}
      />,
    );
    expect(queryByTitle(RETRY_TITLE)).not.toBeNull();
  });

  it("offers no pin control on the user card — pinning is a conversation-level action", () => {
    const { getByTestId, queryByTitle } = renderCore(
      <TranscriptRenderer
        entries={[userEntry("question"), assistant("answer")]}
        streaming={false}
        currentSessionId="s1"
        actions={{
          isEntryStarred: (idx) => (idx === 0 ? "star-1" : null),
          onToggleStar: vi.fn(),
          onReturnHere: vi.fn(),
        }}
      />,
    );

    expect(getByTestId("user-message-actions")).toBeTruthy();
    // starredView.unstar / chatView pin titles are gone from the user bubble;
    // the assistant footer keeps its own pin control.
    expect(queryByTitle("핀 고정")).toBeNull();
  });

  it("renders the return-here control on the user card and hands it the entry index", async () => {
    const onReturnHere = vi.fn();
    const { getAllByTitle } = renderCore(
      <TranscriptRenderer
        entries={[userEntry("first"), assistant("answer"), userEntry("second")]}
        streaming={false}
        currentSessionId="s1"
        actions={{ onReturnHere }}
      />,
    );

    const buttons = getAllByTitle(RETURN_HERE_TITLE);
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[1]);
    expect(onReturnHere).toHaveBeenCalledWith(2);
  });

  it("disables return-here while a turn is streaming — the rewind would race the turn it discards", () => {
    const onReturnHere = vi.fn();
    const { getAllByTitle } = renderCore(
      <TranscriptRenderer
        entries={[userEntry("first"), assistant("answering", { streaming: true })]}
        streaming
        currentSessionId="s1"
        actions={{ onReturnHere }}
      />,
    );

    const button = getAllByTitle(RETURN_HERE_TITLE)[0] as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onReturnHere).not.toHaveBeenCalled();
  });

  it("shows the send time recorded on a user message, in the host time zone", () => {
    // `formatHhMm` renders in the host zone, so pin it — otherwise this asserts
    // nothing more than "whatever zone the machine running the suite is in".
    withTz("UTC", () => {
      const { getByTestId } = renderCore(
        <TranscriptRenderer
          entries={[{ kind: "user", text: "timed", createdAt: Date.UTC(2026, 0, 2, 4, 26) }]}
          streaming={false}
          currentSessionId="s1"
        />,
      );

      expect(getByTestId("user-message-time").textContent).toContain("04:26");
    });
  });

  it("shows no time on a message that never recorded one", () => {
    const { queryByTestId } = renderCore(
      <TranscriptRenderer
        entries={[userEntry("untimed")]}
        streaming={false}
        currentSessionId="s1"
      />,
    );

    expect(queryByTestId("user-message-time")).toBeNull();
  });

  it("pins the send time to the trailing edge, with the hover controls before it", () => {
    // The footer row is `justify-end`, so the LAST child owns the trailing
    // edge. Ordering the controls first keeps the time in a fixed column while
    // they fade in on its leading side.
    const { getByTestId } = renderCore(
      <TranscriptRenderer
        entries={[{ kind: "user", text: "timed", createdAt: Date.UTC(2026, 0, 2, 4, 26) }]}
        streaming={false}
        currentSessionId="s1"
        actions={{ onReturnHere: vi.fn() }}
      />,
    );

    const actions = getByTestId("user-message-actions");
    const time = getByTestId("user-message-time");
    const footer = time.parentElement;

    expect(footer).toBe(actions.parentElement);
    expect(footer?.lastElementChild).toBe(time);
    expect(
      actions.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The reveal must stay opacity/transform-only: the row keeps its fixed
    // height so showing the controls never reflows the transcript.
    expect(footer?.className).toContain("h-7");
    expect(actions.className).toContain("opacity-0");
    expect(actions.className).not.toContain("h-");
  });
});

describe("TranscriptRenderer — sub-agent report box", () => {
  const report = (extra: Partial<Extract<ChatEntry, { kind: "user" }>> = {}): ChatEntry => ({
    kind: "user",
    text: "[Sub-Agent: Contract audit] (task child-1, message m-1)\nfound 3 issues",
    injectHint: "sub-agent",
    ...extra,
  });

  it("renders a sub-agent report in its own box, not the queued-message chip", () => {
    const { getByTestId, queryByTitle } = renderCore(
      <TranscriptRenderer
        entries={[report(), assistant("ok")]}
        streaming={false}
        currentSessionId="s1"
      />,
    );

    expect(getByTestId("subagent-report-bubble")).toBeTruthy();
    // chatView.queueInjectTitle — the generic chip must not appear for a child report.
    expect(queryByTitle("메시지 큐에서 자동 인입")).toBeNull();
    expect(getByTestId("subagent-report-label").textContent).toContain("서브에이전트 보고");
  });

  it("names the reporting child when the batch came from a single sub-agent", () => {
    const { getByTestId } = renderCore(
      <TranscriptRenderer
        entries={[report({ subAgentTitle: "Contract audit" })]}
        streaming={false}
        currentSessionId="s1"
      />,
    );

    expect(getByTestId("subagent-report-label").textContent).toContain("Contract audit");
  });

  it("offers no edit affordance on text the user never wrote", () => {
    const { queryByTitle } = renderCore(
      <TranscriptRenderer
        entries={[report(), assistant("ok")]}
        streaming={false}
        currentSessionId="s1"
        edit={{
          editingEntryIdx: null,
          editBusy: false,
          setEditingEntryIdx: vi.fn(),
          onEditSave: vi.fn(),
        }}
        actions={{ onFork: vi.fn(), onToggleStar: vi.fn() }}
      />,
    );

    expect(queryByTitle(EDIT_TITLE)).toBeNull();
  });
});

describe("TranscriptRenderer — external-surface origin badge", () => {
  it("labels a remote-origin user bubble with its provenance", () => {
    const { getByTestId } = renderCore(
      <TranscriptRenderer
        entries={[
          { kind: "user", text: "원격에서 온 메시지", origin: "platform-bridge" },
          assistant("답변"),
        ]}
        streaming={false}
        currentSessionId="s1"
      />,
    );

    // trustOriginLabel.platformBridge — ko locale pinned by the jsdom project.
    expect(getByTestId("user-message-origin-badge").textContent).toContain(
      "외부 채팅 플랫폼 입력",
    );
    expect(getByTestId("user-message-bubble").textContent).toContain("원격에서 온 메시지");
  });

  it("shows no origin badge on an ordinary local user bubble", () => {
    const { queryByTestId } = renderCore(
      <TranscriptRenderer entries={[userEntry("로컬 질문")]} streaming={false} currentSessionId="s1" />,
    );
    expect(queryByTestId("user-message-origin-badge")).toBeNull();
  });
});
