/**
 * WorkBoardEngine — the daily / weekly briefing.
 *
 * The briefing is the reports surface run backwards: instead of summarizing the
 * board it surveys the user's work and files what it found back onto the board
 * as proposals. Three things are worth pinning down, and all three are asserted
 * against a real {@link WorkBoardStore} over a temp path with a fake runner
 * standing in for the survey agent:
 *
 *   - the PROMPT the host hands the survey (bounded, autonomous, read-only,
 *     and told what is already on the board);
 *   - the PARSE of the survey's answer into proposals;
 *   - DUPLICATE SUPPRESSION — running the same briefing twice must refresh the
 *     card it already filed rather than adding a second one.
 */
import { describe, it, expect } from "vitest";
import { WorkBoardStore } from "../../main/work-board-store.js";
import { createWorkBoardEngine } from "../work-board-engine.js";
import type { SubAgentRunner } from "../../engine/subagent-runner.js";
import type { ApprovalGate } from "../../permissions/approval-gate.js";
import { BRIEFING_PROPOSAL_SOURCE_ID } from "../../shared/work-board-types.js";
import {
  boardParentToolRegistry,
  tempBoardStore as tempBoard,
} from "../../work-board/__tests__/board-test-fixtures.js";

interface SurveySpawn {
  title: string;
  instructions: string;
  sourceTools?: string[];
  maxRounds?: number;
  profileMode?: string;
  originSessionId?: string;
}

/** Runner whose survey answer is scripted per call. */
function fakeRunner(answers: string[]): {
  runner: SubAgentRunner;
  spawns: SurveySpawn[];
} {
  const spawns: SurveySpawn[] = [];
  const registry = boardParentToolRegistry();
  const runner = {
    parentToolRegistry: () => registry,
    async spawn(input: SurveySpawn) {
      spawns.push(input);
      return {
        summary: answers[spawns.length - 1] ?? "[]",
        toolCallCount: 0,
        turnCount: 1,
        childSessionId: "sub-briefing-0193c0f2-1f6d-7c2a-9c4e-2f8b6d1a4e70",
        entries: [],
        ok: true,
      };
    },
  } as unknown as SubAgentRunner;
  return { runner, spawns };
}

/** The gate is never reached by a briefing — a survey mutates nothing. */
const unusedGate = {
  async requestAndWait() {
    throw new Error("the briefing must not open a plan-approval prompt");
  },
} as unknown as ApprovalGate;

function engineOver(store: WorkBoardStore, runner: SubAgentRunner) {
  return createWorkBoardEngine({
    store,
    getRunner: () => runner,
    approvalGate: unusedGate,
    emitProgress: () => {},
  });
}

const ONE_ITEM = `Here you go:
\`\`\`json
[
  {
    "title": "Reply to the design review",
    "summary": "Three reviewers are waiting on your answer.",
    "state": "Opened four days ago; two comments unanswered.",
    "evidence": [{ "label": "Thread", "detail": "design review, 4 days old" }],
    "blockers": [{ "reason": "The spec link is dead", "resolution": "Ask for a new link" }],
    "taskBrief": "Open the review thread and answer the two open comments.",
    "priority": "high"
  }
]
\`\`\``;

describe("WorkBoardEngine — briefing survey", () => {
  it("hands the survey a bounded, autonomous, read-only prompt naming the open board", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "finish the migration" });
      expect(created.status).toBe("created");

      const { runner, spawns } = fakeRunner([ONE_ITEM]);
      const result = await engineOver(store, runner).runBriefing("daily");

      expect(result.status).toBe("ok");
      expect(spawns).toHaveLength(1);
      const spawn = spawns[0];

      // Bounded: the survey has no answer channel, so it runs on a host budget.
      expect(spawn.maxRounds).toBe(20);
      // Read-only at the registry, not merely in the prompt.
      expect(spawn.sourceTools).toContain("read_file");
      expect(spawn.sourceTools).not.toContain("write_file");
      expect(spawn.sourceTools).not.toContain("web_fetch");
      expect(spawn.profileMode).toBe("plan");
      // Autonomous: it is told there is nobody to ask.
      expect(spawn.instructions).toContain("AUTONOMOUSLY");
      expect(spawn.instructions).toContain("Do NOT ask the user any questions");
      // And it is shown the board so it reports what is NOT already there.
      expect(spawn.instructions).toContain("finish the migration");
    } finally {
      cleanup();
    }
  });

  it("files each parsed action item as a proposal carrying the host source id", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const { runner } = fakeRunner([ONE_ITEM]);
      const result = await engineOver(store, runner).runBriefing("daily");

      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
      expect(result.filed).toHaveLength(1);
      expect(result.refreshed).toHaveLength(0);

      const listed = await store.listProposals();
      if (listed.status !== "ok") throw new Error("proposals unreadable");
      expect(listed.proposals).toHaveLength(1);
      const proposal = listed.proposals[0];
      expect(proposal.pluginId).toBe(BRIEFING_PROPOSAL_SOURCE_ID);
      expect(proposal.kind).toBe("daily-briefing");
      expect(proposal.title).toBe("Reply to the design review");
      expect(proposal.priority).toBe("high");
      expect(proposal.evidence).toEqual([
        { label: "Thread", detail: "design review, 4 days old" },
      ]);
      expect(proposal.blockers).toEqual([
        { reason: "The spec link is dead", resolution: "Ask for a new link" },
      ]);
      // The instruction text is carried but never rendered as the card body.
      expect(proposal.taskBrief).toContain("Open the review thread");
    } finally {
      cleanup();
    }
  });

  it("reports an empty survey rather than filing nothing silently", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const { runner } = fakeRunner(["```json\n[]\n```"]);
      const result = await engineOver(store, runner).runBriefing("weekly");
      expect(result.status).toBe("empty");
      expect(result.kind).toBe("weekly");
    } finally {
      cleanup();
    }
  });

  it("treats a survey answer with no action-item array as a failure", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const { runner } = fakeRunner(["I could not read your mailbox."]);
      const result = await engineOver(store, runner).runBriefing("daily");
      expect(result.status).toBe("error");
    } finally {
      cleanup();
    }
  });

  it("drops an action item missing a field the card renders", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const answer = `\`\`\`json
[
  { "title": "No state or brief" },
  {
    "title": "Complete row",
    "summary": "s",
    "state": "st",
    "taskBrief": "tb"
  }
]
\`\`\``;
      const { runner } = fakeRunner([answer]);
      const result = await engineOver(store, runner).runBriefing("daily");

      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
      expect(result.filed).toHaveLength(1);
      const listed = await store.listProposals();
      if (listed.status !== "ok") throw new Error("proposals unreadable");
      expect(listed.proposals.map((p) => p.title)).toEqual(["Complete row"]);
    } finally {
      cleanup();
    }
  });

  it("refreshes rather than duplicates when the same action item is surveyed twice", async () => {
    const { store, cleanup } = tempBoard();
    try {
      // Second run re-words the summary and re-cases and re-punctuates the
      // title — the drift the normalized-title key exists to absorb.
      const reworded = ONE_ITEM
        .replace("Reply to the design review", "Reply to the Design Review!")
        .replace("Three reviewers are waiting on your answer.", "Still unanswered after five days.");

      const { runner } = fakeRunner([ONE_ITEM, reworded]);
      const engine = engineOver(store, runner);

      const first = await engine.runBriefing("daily");
      const second = await engine.runBriefing("daily");

      if (first.status !== "ok" || second.status !== "ok") throw new Error("both runs must file");
      expect(first.filed).toHaveLength(1);
      expect(second.filed).toHaveLength(0);
      expect(second.refreshed).toEqual(first.filed);

      const listed = await store.listProposals();
      if (listed.status !== "ok") throw new Error("proposals unreadable");
      expect(listed.proposals).toHaveLength(1);
      // The refresh carried the newer wording onto the card that was already there.
      expect(listed.proposals[0].summary).toBe("Still unanswered after five days.");
    } finally {
      cleanup();
    }
  });

  it("does not re-open a card the user already dismissed", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const { runner } = fakeRunner([ONE_ITEM, ONE_ITEM]);
      const engine = engineOver(store, runner);

      const first = await engine.runBriefing("daily");
      if (first.status !== "ok") throw new Error("first run must file");
      await store.dismissProposal(first.filed[0]);

      const second = await engine.runBriefing("daily");
      if (second.status !== "ok") throw new Error("second run must complete");
      expect(second.filed).toHaveLength(0);

      const listed = await store.listProposals();
      if (listed.status !== "ok") throw new Error("proposals unreadable");
      expect(listed.proposals).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("surfaces a survey that could not run as an error", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const registry = boardParentToolRegistry();
      const runner = {
        parentToolRegistry: () => registry,
        async spawn() {
          return {
            summary: "no LLM provider configured",
            toolCallCount: 0,
            turnCount: 0,
            childSessionId: "sub-briefing-0193c0f2-1f6d-7c2a-9c4e-2f8b6d1a4e71",
            entries: [],
            ok: false,
            error: "no LLM provider configured",
          };
        },
      } as unknown as SubAgentRunner;

      const result = await engineOver(store, runner).runBriefing("daily");
      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("unreachable");
      expect(result.reason).toContain("no LLM provider configured");
    } finally {
      cleanup();
    }
  });

  it("returns an error instead of spawning a second survey for the same window", async () => {
    const { store, cleanup } = tempBoard();
    try {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let spawnCount = 0;
      const registry = boardParentToolRegistry();
      const runner = {
        parentToolRegistry: () => registry,
        async spawn() {
          spawnCount += 1;
          await gate;
          return {
            summary: "[]",
            toolCallCount: 0,
            turnCount: 1,
            childSessionId: "sub-briefing-0193c0f2-1f6d-7c2a-9c4e-2f8b6d1a4e72",
            entries: [],
            ok: true,
          };
        },
      } as unknown as SubAgentRunner;

      const engine = engineOver(store, runner);
      const inFlight = engine.runBriefing("daily");
      const second = await engine.runBriefing("daily");
      expect(second.status).toBe("error");

      release?.();
      expect((await inFlight).status).toBe("empty");
      // One survey ran, not two — the second press cost nothing.
      expect(spawnCount).toBe(1);
    } finally {
      cleanup();
    }
  });
});
