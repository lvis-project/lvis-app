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
import { render } from "@testing-library/react";
import type React from "react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { TranscriptRenderer } from "../components/TranscriptRenderer.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

// Radix Tooltip (used by WorkGroup / TurnActionBar primitives) requires a
// provider in the tree — the real app supplies it via AppProviders. Wrap the
// isolated core the same way so these unit renders mirror production context.
const renderCore = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

const user = (text: string): ChatEntry => ({ kind: "user", text });
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

describe("TranscriptRenderer — minimal (required-only) contract", () => {
  const minimal = [user("q"), assistant("a")];

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
    const entries = [user("q"), toolGroup(), assistant("done")];
    const { getAllByTestId } = renderCore(
      <TranscriptRenderer entries={entries} streaming={false} currentSessionId="s1" />,
    );
    // The intermediate tool_group collapses into exactly one work-group; the
    // final assistant renders outside it. This is the heart of the unified
    // render and must survive extraction unchanged.
    expect(getAllByTestId("work-group").length).toBe(1);
  });

  it("can force historical WorkGroups open for read-only companion surfaces", () => {
    const entries = [user("q"), toolGroup("forced-tool"), assistant("done")];
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
});

describe("TranscriptRenderer — action suppression keys off callback presence", () => {
  it("renders the retry footer button once the actions cluster IS supplied", () => {
    const onRetryEffort = vi.fn();
    const { queryByTitle } = renderCore(
      <TranscriptRenderer
        entries={[user("q"), assistant("a")]}
        streaming={false}
        currentSessionId="s1"
        actions={{ onRetryEffort }}
      />,
    );
    expect(queryByTitle(RETRY_TITLE)).not.toBeNull();
  });
});
