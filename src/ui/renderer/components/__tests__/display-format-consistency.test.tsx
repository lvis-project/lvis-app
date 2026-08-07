/**
 * Cross-surface display consistency — durations and costs.
 *
 * These are the *consumers*, on purpose. Both quantities used to have one
 * formatter per screen, and every one of those formatters had a green unit
 * test of its own; what nobody tested was that two screens showing the same
 * number showed the same string. So each case below renders the real
 * components and compares the rendered text across surfaces, and pins the
 * exact strings for the inputs where the old copies disagreed.
 *
 * Duration surfaces: the per-tool badge on `ToolGroupCard` and the turn
 * footer on `WorkGroup`. The footer's number is the sum of the badges above
 * it, so `1h 03m` over rows reading `63m 0.0s` was a visible contradiction.
 *
 * Cost surfaces: the per-turn `TokenCostBadge`, the starred-day usage panel,
 * and the pre-flight estimate badge (`formatCostBadge`, rendered by
 * `TokenProgressRing`).
 */
// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ToolGroupCard } from "../ToolGroupCard.js";
import { WorkGroup } from "../WorkGroup.js";
import { TokenCostBadge } from "../TokenCostBadge.js";
import { StarredView } from "../StarredView.js";
import { formatCostBadge } from "../../../../lib/cost-estimator.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";

type ToolEntry = Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];

function toolGroupWithDuration(durationMs: number | undefined): Extract<ChatEntry, { kind: "tool_group" }> {
  const tool = {
    toolUseId: "t1",
    name: "read_file",
    displayOrder: 0,
    status: "done",
    input: {},
    result: "ok",
    ...(durationMs === undefined ? {} : { durationMs }),
  } as ToolEntry;
  return { kind: "tool_group", groupId: "g1", groupIds: ["g1"], status: "done", tools: [tool] };
}

/** The `⏱ …` text a completed tool row shows for `durationMs`. */
function toolBadgeText(durationMs: number | undefined): string | null {
  render(
    <TooltipProvider>
      <ToolGroupCard group={toolGroupWithDuration(durationMs)} />
    </TooltipProvider>,
  );
  const badge = screen.queryByTestId("tool-duration");
  return badge ? (badge.textContent ?? "").replace("⏱", "").trim() : null;
}

/** The `⏱ …` text the turn footer shows for the same elapsed milliseconds. */
function turnFooterText(turnDurationMs: number): string {
  render(
    <WorkGroup stepCount={1} streaming={false} revision="r" turnDurationMs={turnDurationMs}>
      <div>work</div>
    </WorkGroup>,
  );
  const node = screen.getByText(/⏱/);
  return (node.textContent ?? "").replace("⏱", "").trim();
}

describe("duration renders identically on the tool badge and the turn footer", () => {
  afterEach(() => cleanup());

  // Every one of these disagreed between the two copies before consolidation.
  it.each([
    { ms: 72_000, expected: "1m 12s" },
    { ms: 72_400, expected: "1m 12.4s" },
    { ms: 60_000, expected: "1m 0s" },
    { ms: 3_780_000, expected: "1h 03m" },
    { ms: 1_400, expected: "1.4s" },
    { ms: 50, expected: "<0.1s" },
  ])("$ms ms → $expected on both surfaces", ({ ms, expected }) => {
    expect(toolBadgeText(ms)).toBe(expected);
    cleanup();
    expect(turnFooterText(ms)).toBe(expected);
  });

  it("hides the tool badge for a missing or nonsensical duration instead of printing 0s", () => {
    expect(toolBadgeText(undefined)).toBeNull();
    cleanup();
    expect(toolBadgeText(-1)).toBeNull();
    cleanup();
    expect(toolBadgeText(Number.NaN)).toBeNull();
  });
});

describe("cost renders identically across the badge, the usage panel and the estimate", () => {
  afterEach(() => cleanup());

  /** $0.50 exactly: 500k input tokens at $1/1M, no output, no cache. */
  const halfDollar = {
    tokensIn: 500_000,
    freshInputTokens: 500_000,
    tokensOut: 0,
    pricing: { inputPer1M: 1, outputPer1M: 0, contextWindow: 1_000_000 },
    vendor: "claude" as const,
  };

  it("the per-turn badge renders $0.500, not $0.50 or $0.5", () => {
    render(
      <TooltipProvider>
        <TokenCostBadge {...halfDollar} />
      </TooltipProvider>,
    );
    // The badge opens in "tokens" mode; `fireEvent` wraps the click in `act()`
    // so the cost render flushes before the assertion.
    fireEvent.click(screen.getByTestId("token-cost-badge"));
    expect(screen.getByText(/\$0\.500/)).toBeTruthy();
  });

  it("the starred-day usage panel renders the same string for the same amount", async () => {
    const api = {
      starredRemove: vi.fn(async () => ({ ok: true })),
      getUsageRange: vi.fn(async () => ({
        today: { totalTokens: 1234, inputTokens: 1000, outputTokens: 234, cost: 0.5 },
        trend: [],
      })),
    } as unknown as Parameters<typeof StarredView>[0]["api"];

    render(
      <StarredView
        api={api}
        starred={[]}
        sessions={[]}
        workspaceProjects={[]}
        currentSessionId=""
        refreshStarred={vi.fn()}
        onJumpToSession={vi.fn()}
        onActivateHome={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText(/\$0\.500/)).toBeTruthy());
  });

  it("the pre-flight estimate badge differs from the settled cost only by its ~ prefix", () => {
    expect(formatCostBadge(0.5)).toBe("~$0.500");
    expect(formatCostBadge(0.05)).toBe("~$0.050");
    expect(formatCostBadge(0)).toBe("~$0");
  });
});
