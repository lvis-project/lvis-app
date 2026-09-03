// @vitest-environment jsdom
/**
 * The briefing buttons on the Work Board.
 *
 * They sit in the same card as the report buttons and must not read as more of
 * the same: a report summarizes the board, a briefing goes and looks and files
 * what it found. What is asserted here is the path the press actually takes —
 * button → `runWorkBoardBriefing` over IPC → a result line that says how many
 * cards arrived — plus the running state while the survey is in flight.
 */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { LvisApi } from "../../types.js";
import type { WorkBoardBriefingResult } from "../../../../shared/work-board-types.js";

function stubApi(
  briefing: (kind: string) => Promise<WorkBoardBriefingResult>,
): { api: LvisApi; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(briefing);
  const noop = () => () => {};
  const api = {
    listWorkBoard: async () => ({ status: "ok" as const, items: [] }),
    listWorkProposals: async () => ({ status: "ok" as const, proposals: [] }),
    runWorkBoardBriefing: run,
    onWorkBoardItemChanged: noop,
    onWorkProposalChanged: noop,
    onWorkBoardRunProgress: noop,
    onWorkBoardRunStarted: noop,
    onWorkBoardRunFinished: noop,
    onWorkBoardRunFailed: noop,
  } as unknown as LvisApi;
  return { api, run };
}

describe("Work Board — briefing buttons", () => {
  afterEach(() => cleanup());

  it("sits alongside the report buttons rather than in a card of its own", async () => {
    const { api } = stubApi(async (kind) => ({
      status: "empty",
      kind: kind as "daily",
      reason: "nothing",
    }));
    render(<WorkBoardPanel api={api} />);

    const section = await screen.findByTestId("work-board-reports");
    for (const id of [
      "work-board-report-daily",
      "work-board-report-weekly",
      "work-board-briefing-daily",
      "work-board-briefing-weekly",
    ]) {
      expect(section.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });

  it("runs the survey for the window that was pressed and reports what it filed", async () => {
    const { api, run } = stubApi(async (kind) => ({
      status: "ok",
      kind: kind as "weekly",
      filed: ["lvis.briefing:weekly-briefing:aaaaaaaaaaaaaaaa", "lvis.briefing:weekly-briefing:bbbbbbbbbbbbbbbb"],
      refreshed: [],
    }));
    render(<WorkBoardPanel api={api} />);

    fireEvent.click(await screen.findByTestId("work-board-briefing-weekly"));

    await waitFor(() => expect(screen.queryByTestId("work-board-briefing-filed")).not.toBeNull());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe("weekly");
    expect(screen.getByTestId("work-board-briefing-filed").textContent).toContain("2");
  });

  it("shows the survey is running while it is in flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api } = stubApi(async (kind) => {
      await gate;
      return { status: "empty", kind: kind as "daily", reason: "nothing" };
    });
    render(<WorkBoardPanel api={api} />);

    const button = await screen.findByTestId("work-board-briefing-daily");
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByTestId("work-board-briefing-running")).not.toBeNull());
    // Both windows are disabled while one survey runs — a second press would
    // only be refused by the engine anyway.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("work-board-briefing-weekly") as HTMLButtonElement).disabled).toBe(true);

    release?.();
    await waitFor(() => expect(screen.queryByTestId("work-board-briefing-running")).toBeNull());
    expect(screen.getByTestId("work-board-briefing-empty")).not.toBeNull();
  });

  it("says nothing arrived when the survey only refreshed cards already on the board", async () => {
    const { api } = stubApi(async (kind) => ({
      status: "ok",
      kind: kind as "daily",
      filed: [],
      refreshed: ["lvis.briefing:daily-briefing:cccccccccccccccc"],
    }));
    render(<WorkBoardPanel api={api} />);

    fireEvent.click(await screen.findByTestId("work-board-briefing-daily"));
    await waitFor(() => expect(screen.queryByTestId("work-board-briefing-empty")).not.toBeNull());
  });

  it("surfaces a failed survey instead of leaving the press silent", async () => {
    const { api } = stubApi(async (kind) => ({
      status: "error",
      kind: kind as "daily",
      reason: "no LLM provider configured",
    }));
    render(<WorkBoardPanel api={api} />);

    fireEvent.click(await screen.findByTestId("work-board-briefing-daily"));
    await waitFor(() => expect(screen.queryByTestId("work-board-briefing-error")).not.toBeNull());
    expect(screen.getByTestId("work-board-briefing-error").textContent).toContain(
      "no LLM provider configured",
    );
  });
});

describe("Work Board — focus from the sidebar", () => {
  afterEach(() => cleanup());

  it("opens the item's detail with its newest run transcript expanded, then releases the focus", async () => {
    const { api } = stubApi(async () => ({ status: "ok" as const, kind: "daily", markdown: "" }) as unknown as WorkBoardBriefingResult);
    const startedAt = "2026-09-03T10:00:00.000Z";
    const getWorkBoardItem = vi.fn(async (itemId: number) => ({
      status: "found" as const,
      itemId,
      item: {
        id: itemId,
        title: "월간 보고서 초안",
        status: "in_progress",
        status_resolved: "in_progress",
        priority: "medium",
        created_at: startedAt,
        updated_at: startedAt,
        runHistory: [
          { runId: "run-old", startedAt: "2026-09-02T10:00:00.000Z", endedAt: "2026-09-02T10:05:00.000Z", status: "completed" },
          { runId: "run-new", startedAt, endedAt: "2026-09-03T10:05:00.000Z", status: "completed" },
        ],
      },
    }));
    const getWorkBoardRunTranscript = vi.fn(async () => ({
      events: [{ ts: startedAt, phase: "executing", kind: "turn", turn: 1, text: "hello from run" }],
    }));
    Object.assign(api, { getWorkBoardItem, getWorkBoardRunTranscript });
    const onFocusConsumed = vi.fn();

    render(<WorkBoardPanel api={api} focusItemId={7} onFocusConsumed={onFocusConsumed} />);

    await waitFor(() => expect(screen.getByTestId("work-board-detail-dialog")).toBeTruthy());
    expect(getWorkBoardItem).toHaveBeenCalledWith(7);
    await waitFor(() => expect(getWorkBoardRunTranscript).toHaveBeenCalledWith(7, "run-new"));
    await waitFor(() => expect(screen.getByText(/hello from run/)).toBeTruthy());
    expect(getWorkBoardRunTranscript).not.toHaveBeenCalledWith(7, "run-old");
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
  });
});
