/**
 * First-run sample-data seed for the Work Board (user-guide onboarding).
 *
 * A brand-new install opens to an empty board, which makes the agentic flow
 * (create → approve → sub-agent executes → output) hard to discover. This step
 * seeds a small set of clearly-labelled example items on the FIRST boot of the
 * work-board domain so the board demonstrates itself — including one item that
 * is already `completed` with a captured plan + output, so the columns show the
 * full lifecycle, not just empty lanes.
 *
 * Idempotency is keyed by a one-time marker file (`sample-seeded.json`), NOT by
 * the board being empty: once the decision is recorded, deleting the demo items
 * never makes them reappear. The seed is skipped (and the marker still written)
 * when the board was migrated from a legacy plugin or already has items — a real
 * board is never polluted with examples.
 *
 * Non-fatal: any failure logs and leaves the board untouched (boot continues).
 */
import type { WorkBoardStorage } from "./storage.js";
import type {
  WorkItemCreateInput,
  WorkItemCreateResult,
  WorkItemListResult,
} from "../shared/work-board-types.js";

/** Marker recording that the first-run seed decision was already made. */
export const SAMPLE_SEEDED_FILE = "sample-seeded.json";

/** Narrow store surface the seed needs (satisfied by WorkBoardStore). */
export interface SampleSeedStore {
  list(): Promise<WorkItemListResult>;
  create(input: WorkItemCreateInput): Promise<WorkItemCreateResult>;
  setRunResult(
    id: number,
    patch: {
      runStatus: "completed";
      plan?: string | null;
      output?: string | null;
      runSessionId?: string | null;
    },
  ): Promise<unknown>;
}

export interface SampleSeedDeps {
  store: SampleSeedStore;
  marker: Pick<WorkBoardStorage, "readJson" | "writeJson">;
  /** True when boot migrated a legacy plugin board this run — never seed over real data. */
  alreadyMigrated: boolean;
  /** Injectable clock so due dates / timestamps are deterministic in tests. */
  now: () => number;
}

export interface SampleSeedResult {
  seeded: boolean;
  reason?: string;
  count?: number;
}

interface SampleSeededMarker {
  seeded: boolean;
  decidedAt: string;
  count?: number;
}

/**
 * Build the sample items. `now` anchors the due dates so the high-priority
 * planned item lands inside the due-soon window (demonstrating the nudge) and
 * the completed item reads as finished recently.
 */
function sampleItems(nowMs: number): Array<{
  input: WorkItemCreateInput;
  run?: { plan: string; output: string };
}> {
  const inHours = (h: number) => new Date(nowMs + h * 60 * 60_000).toISOString();
  return [
    {
      input: {
        title: "[Sample] Draft the weekly work report",
        detail:
          "Collect this week's completed and in-progress items into a weekly report draft. Open the card and choose Run; the agent will plan, request approval, and draft the report after approval.",
        priority: "high",
        status: "planned",
        // Roughly 20 hours out: demonstrates the due-soon (24h) nudge.
        due_at: inHours(20),
      },
    },
    {
      input: {
        title: "[Sample] Organize competitor research",
        detail:
          "The agent is researching sources and drafting a comparison table. The In Progress column shows the live execution state.",
        priority: "medium",
        status: "in_progress",
        due_at: inHours(3 * 24),
      },
    },
    {
      input: {
        title: "[Sample] Summarize the Q2 retrospective",
        detail: "A completed example where a subagent ran autonomously after approval and saved the result.",
        priority: "medium",
        status: "completed",
      },
      run: {
        plan:
          "1) Collect completed Q2 work  2) Sort into wins/issues/lessons learned  3) Derive next-quarter action items  4) Summarize on one page",
        output:
          "## Q2 Retrospective Summary\n\n**Wins** — Shipped three core features and reduced response latency by 28%.\n**Issues** — Review cycle delays repeated, so a checklist was introduced.\n**Next Quarter** — (1) Expand automation coverage (2) refresh onboarding docs (3) make weekly retrospectives routine.\n\n_This result is sample data._",
      },
    },
  ];
}

/**
 * Seed the sample board exactly once. Returns whether items were created.
 * Writes the marker on every terminal decision (seeded or deliberately skipped)
 * so the choice is made at most once per install.
 */
export async function seedSampleWorkBoard(deps: SampleSeedDeps): Promise<SampleSeedResult> {
  const { store, marker, alreadyMigrated, now } = deps;

  // The marker — not board emptiness — is the idempotency key.
  const existing = await marker.readJson<SampleSeededMarker>(SAMPLE_SEEDED_FILE);
  if (existing) return { seeded: false, reason: "already-decided" };

  const decidedAt = new Date(now()).toISOString();

  // Never seed over real data: a migrated or already-populated board.
  if (alreadyMigrated) {
    await marker.writeJson(SAMPLE_SEEDED_FILE, { seeded: false, decidedAt });
    return { seeded: false, reason: "migrated" };
  }
  const listed = await store.list();
  if (listed.status === "ok" && listed.items.length > 0) {
    await marker.writeJson(SAMPLE_SEEDED_FILE, { seeded: false, decidedAt });
    return { seeded: false, reason: "non-empty" };
  }

  let count = 0;
  for (const sample of sampleItems(now())) {
    const created = await store.create(sample.input);
    if (created.status !== "created") continue;
    count += 1;
    if (sample.run) {
      await store.setRunResult(created.itemId, {
        runStatus: "completed",
        plan: sample.run.plan,
        output: sample.run.output,
        runSessionId: `sample:${created.itemId}`,
      });
    }
  }

  await marker.writeJson(SAMPLE_SEEDED_FILE, { seeded: true, decidedAt, count });
  return { seeded: true, count };
}
