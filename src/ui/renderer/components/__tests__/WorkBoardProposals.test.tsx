// @vitest-environment jsdom
/**
 * The 추천 작업 band on the Work Board.
 *
 * What matters here is what the START button actually does. The plugin hands
 * over text and a key and nothing executable, so starting a proposal is two
 * host actions in order: promote it into an ordinary work item through the
 * ordinary create path, then hand THAT item id to the host's own
 * `runWorkBoardItem` (plan → approve → execute). Nothing the plugin supplied is
 * passed to the run, and the run is stubbed here because the point under test
 * is the wiring, not the engine.
 */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { LvisApi } from "../../types.js";
import type { WorkProposal } from "../../../../shared/work-board-types.js";

const PROPOSAL: WorkProposal = {
  id: "indexer:stale-index:0123456789abcdef",
  kind: "stale-index",
  key: "folder:reports",
  pluginId: "indexer",
  pluginLabel: "Indexer",
  title: "Re-index the reports folder",
  summary: "18 files changed since the last scan.",
  state: "Last scanned 12 days ago; 18 files newer than the index.",
  evidence: [{ label: "Newest change", detail: "quarterly-summary.docx" }],
  blockers: [{ reason: "The share is disconnected", resolution: "Reconnect the share" }],
  taskBrief: "Re-run the folder scan and report what changed.",
  priority: "high",
  createdAt: "2026-06-15T12:00:00.000Z",
  updatedAt: "2026-06-15T12:00:00.000Z",
  expiresAt: "2026-06-22T12:00:00.000Z",
};

function stubApi(overrides: Partial<LvisApi> = {}): {
  api: LvisApi;
  accept: ReturnType<typeof vi.fn>;
  dismiss: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
} {
  const accept = vi.fn(async () => ({
    status: "accepted" as const,
    itemId: 7,
    item: {
      id: 7,
      title: PROPOSAL.title,
      status: "planned" as const,
      status_resolved: "planned" as const,
      priority: "high" as const,
      created_at: PROPOSAL.createdAt,
      updated_at: PROPOSAL.updatedAt,
    },
  }));
  const dismiss = vi.fn(async () => ({
    status: "dismissed" as const,
    proposalId: PROPOSAL.id,
  }));
  const run = vi.fn(async () => ({ status: "completed" as const }));
  const noop = () => () => {};
  const api = {
    listWorkBoard: async () => ({ status: "ok" as const, items: [] }),
    listWorkProposals: async () => ({ status: "ok" as const, proposals: [PROPOSAL] }),
    acceptWorkProposal: accept,
    dismissWorkProposal: dismiss,
    runWorkBoardItem: run,
    onWorkBoardItemChanged: noop,
    onWorkProposalChanged: noop,
    onWorkBoardRunProgress: noop,
    onWorkBoardRunStarted: noop,
    onWorkBoardRunFinished: noop,
    onWorkBoardRunFailed: noop,
    ...overrides,
  } as unknown as LvisApi;
  return { api, accept, dismiss, run };
}

describe("Work Board — recommended-work cards", () => {
  afterEach(() => cleanup());

  it("draws the card with its title, one-line summary and source plugin", async () => {
    const { api } = stubApi();
    render(<WorkBoardPanel api={api} />);

    await screen.findByTestId("work-board-proposal-card");
    expect(screen.getByTestId("work-board-proposal-title").textContent).toBe(PROPOSAL.title);
    expect(screen.getByTestId("work-board-proposal-summary").textContent).toBe(PROPOSAL.summary);
    // The source is always named: a card inside the host's own board would
    // otherwise read as the host's own recommendation.
    expect(screen.getByTestId("work-board-proposal-source").textContent).toContain("Indexer");
    expect(screen.getByTestId("work-board-proposal-start")).toBeTruthy();
    // The detail is collapsed until asked for.
    expect(screen.queryByTestId("work-board-proposal-detail")).toBeNull();
  });

  it("expands into current state, evidence, and what is blocking it", async () => {
    const { api } = stubApi();
    render(<WorkBoardPanel api={api} />);
    fireEvent.click(await screen.findByTestId("work-board-proposal-expand"));

    expect(screen.getByTestId("work-board-proposal-state").textContent).toBe(PROPOSAL.state);
    expect(screen.getByTestId("work-board-proposal-evidence").textContent).toContain(
      "quarterly-summary.docx",
    );
    expect(screen.getByTestId("work-board-proposal-blockers").textContent).toContain(
      "Reconnect the share",
    );
    // `taskBrief` is instruction text for the run, never rendered to the user.
    expect(screen.getByTestId("work-board-proposal-detail").textContent).not.toContain(
      "Re-run the folder scan",
    );
  });

  it("start promotes the proposal and runs the resulting item, passing nothing the plugin supplied", async () => {
    const { api, accept, run } = stubApi();
    render(<WorkBoardPanel api={api} />);
    fireEvent.click(await screen.findByTestId("work-board-proposal-start"));

    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(accept).toHaveBeenCalledWith(PROPOSAL.id, undefined);
    // The run is addressed by the ITEM id the host just created — the only
    // thing that crosses is a number the host allocated.
    expect(run.mock.calls[0]).toEqual([7]);
  });

  it("later promotes the proposal without running it", async () => {
    const { api, accept, run } = stubApi();
    render(<WorkBoardPanel api={api} />);
    fireEvent.click(await screen.findByTestId("work-board-proposal-later"));

    await waitFor(() => expect(accept).toHaveBeenCalled());
    expect(run).not.toHaveBeenCalled();
  });

  it("dismiss closes the card without creating anything", async () => {
    const { api, accept, dismiss, run } = stubApi();
    render(<WorkBoardPanel api={api} />);
    fireEvent.click(await screen.findByTestId("work-board-proposal-dismiss"));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith(PROPOSAL.id));
    expect(accept).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("draws no band at all when nothing is proposed", async () => {
    const { api } = stubApi({
      listWorkProposals: async () => ({ status: "ok" as const, proposals: [] }),
    } as Partial<LvisApi>);
    render(<WorkBoardPanel api={api} />);

    await screen.findByTestId("work-board-panel");
    expect(screen.queryByTestId("work-board-proposals")).toBeNull();
  });
});
