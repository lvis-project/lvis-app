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
    expect(queryByTestId("token-cost-badge")).toBeNull();
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
    expect(getByTestId("token-cost-badge").getAttribute("data-usage-kind")).toBe("subscription");
  });

  it("continues to show token and cost estimates by default for runtimes with a usage contract", () => {
    const { getByTestId } = renderCore(
      <TranscriptRenderer entries={[userEntry("q"), assistant("a")]} streaming={false} currentSessionId="s1" turnSummaryByTurnStart={completedTurnSummary()} />,
    );
    expect(getByTestId("token-cost-badge")).toBeTruthy();
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
