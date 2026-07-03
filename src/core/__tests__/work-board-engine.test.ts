/**
 * WorkBoardEngine — plan→approve→execute orchestration for one work item.
 *
 * The engine reuses the lower-level SubAgentRunner for both child phases; these
 * tests inject a fake runner (records spawn calls, returns canned summaries) and
 * a fake ApprovalGate (returns a scripted decision) so the plan→approve→execute
 * sequencing, board persistence, and progress events are asserted without a real
 * LLM or a real approval modal. The board is a real {@link WorkBoardStore} over a
 * temp path (the namespace is never touched).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore } from "../../main/work-board-store.js";
import { createWorkBoardEngine } from "../work-board-engine.js";
import type {
  SubAgentRunner,
  SubAgentSpawnCallbacks,
} from "../../engine/subagent-runner.js";
import type {
  ApprovalGate,
  ApprovalDecision,
  ApprovalChoice,
} from "../../permissions/approval-gate.js";
import type { WorkBoardRunEvent } from "../../shared/work-board-types.js";
import type { ChatEntry } from "../../lib/chat-stream-state.js";
import { readRunTranscript } from "../../work-board/run-transcript.js";
import { memTranscriptStorage } from "../../work-board/__tests__/board-test-fixtures.js";

function tempBoard() {
  const dir = mkdtempSync(join(tmpdir(), "lvis-wbe-"));
  const store = new WorkBoardStore(join(dir, "board.json"));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface SpawnCall {
  title: string;
  sourceTools?: string[];
  profileMode?: string;
  originSessionId?: string;
}

/** Fake runner that records each spawn and returns a phase-specific summary. */
function fakeRunner(): { runner: SubAgentRunner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const runner = {
    async spawn(input: {
      title: string;
      sourceTools?: string[];
      profileMode?: string;
      originSessionId?: string;
    }) {
      calls.push({
        title: input.title,
        sourceTools: input.sourceTools,
        profileMode: input.profileMode,
        originSessionId: input.originSessionId,
      });
      const isPlan = input.profileMode === "plan";
      return {
        summary: isPlan ? "PLAN: do A then B" : "OUTPUT: did A then B",
        toolCallCount: 0,
        turnCount: 1,
        childSessionId: `${input.originSessionId}::${isPlan ? "plan" : "exec"}`,
        entries: [],
        ok: true,
      };
    },
  } as unknown as SubAgentRunner;
  return { runner, calls };
}

/** Fake gate that returns a scripted choice and records the request. */
function fakeGate(choice: ApprovalChoice): {
  gate: ApprovalGate;
  requests: unknown[];
} {
  const requests: unknown[] = [];
  const gate = {
    async requestAndWait(req: unknown): Promise<ApprovalDecision> {
      requests.push(req);
      return { requestId: "x", choice };
    },
  } as unknown as ApprovalGate;
  return { gate, requests };
}

describe("WorkBoardEngine — plan→approve→execute", () => {
  it("runs the full sequence on approval and persists plan + output", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "ship feature" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate, requests } = fakeGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      const result = await engine.runItem(id);

      expect(result.status).toBe("completed");
      expect(result.plan).toBe("PLAN: do A then B");
      expect(result.output).toBe("OUTPUT: did A then B");
      expect(result.runSessionId).toBe(`work-board:${id}::exec`);

      // Two spawns: plan (read-only tools) then execute (full registry).
      expect(calls).toHaveLength(2);
      expect(calls[0].profileMode).toBe("plan");
      expect(calls[0].sourceTools).toContain("read_file");
      expect(calls[0].sourceTools).not.toContain("web_fetch_disallowed");
      expect(calls[1].profileMode).toBe("execute");
      // Execute omits sourceTools → full parent registry.
      expect(calls[1].sourceTools).toBeUndefined();
      expect(calls[0].originSessionId).toBe(`work-board:${id}`);

      // Exactly one approval request, carrying the plan + meta category.
      expect(requests).toHaveLength(1);
      const req = requests[0] as Record<string, unknown>;
      expect(req.kind).toBe("agent-action");
      expect(req.toolCategory).toBe("meta");
      expect((req.args as { plan: string }).plan).toBe("PLAN: do A then B");

      // Persisted run fields.
      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("completed");
      expect(got.item.plan).toBe("PLAN: do A then B");
      expect(got.item.output).toBe("OUTPUT: did A then B");
      expect(got.item.runSessionId).toBe(`work-board:${id}::exec`);

      // Progress events covered planning → awaiting_approval → executing → done.
      const phases = events.map((e) => e.phase);
      expect(phases).toContain("planning");
      expect(phases).toContain("awaiting_approval");
      expect(phases).toContain("executing");
      expect(phases[phases.length - 1]).toBe("done");
    } finally {
      cleanup();
    }
  });

  it("stops at denial — no execute spawn, runStatus=denied", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "risky op" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate } = fakeGate("deny-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      const result = await engine.runItem(id);

      expect(result.status).toBe("denied");
      expect(result.plan).toBe("PLAN: do A then B");
      // Only the plan spawn ran — execute never fired.
      expect(calls).toHaveLength(1);
      expect(calls[0].profileMode).toBe("plan");

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("denied");
      expect(got.item.plan).toBe("PLAN: do A then B");
      expect(got.item.output).toBeUndefined();

      expect(events[events.length - 1].phase).toBe("denied");
    } finally {
      cleanup();
    }
  });

  it("returns not_found for an unknown id (no spawn, no approval)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const { runner, calls } = fakeRunner();
      const { gate, requests } = fakeGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(9999);

      expect(result.status).toBe("not_found");
      expect(calls).toHaveLength(0);
      expect(requests).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("returns error when the runner is not yet wired", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "early call" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { gate } = fakeGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => undefined,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(id);
      expect(result.status).toBe("error");

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("error");
    } finally {
      cleanup();
    }
  });

  // ── Activity-flooding regression ─────────────────────────────────────────
  // The sub-agent runner forwards `onActivity` on EVERY child-loop callback
  // (tool_start / tool_end / permission_review / assistant_round) so the
  // sub-agent TAB can live-render the full ChatEntry timeline. The work-board
  // path only wants a coarse per-turn narrative, and `record()` APPENDS to the
  // run transcript. Without a guard, every pre-first-round frame maps to a blank
  // `{turn:0, text:""}` and every extra callback within a round re-emits the
  // SAME `{turn:N, text}` — flooding the live `runProgress` events AND the
  // persisted JSONL with turn:0 blanks + duplicate turn rows. This locks the fix
  // (one event per NEW completed round, no blanks, no dupes).

  // In-memory transcript storage (shared fixture) makes the persisted
  // (recorded) rows assertable — see board-test-fixtures.memTranscriptStorage.

  function assistant(text: string): ChatEntry {
    return { kind: "assistant", text, streaming: false };
  }
  function streamingAssistant(text: string): ChatEntry {
    return { kind: "assistant", text, streaming: true };
  }
  function runningTool(id: string): ChatEntry {
    return {
      kind: "tool_group",
      groupId: id,
      groupIds: [id],
      status: "running",
      tools: [],
    };
  }

  /**
   * Fake runner that drives a REALISTIC child-loop activity sequence per phase:
   * a pre-first-round tool frame (turn 0), a streaming assistant (still turn 0),
   * a finalized round 1, another tool frame WITHIN round 1 (re-emits turn 1),
   * then a finalized round 2. A naive forwarder would produce turn:0 blanks +
   * a duplicate turn:1 row from this.
   */
  function floodingRunner(): SubAgentRunner {
    return {
      async spawn(
        input: { profileMode?: string; originSessionId?: string },
        callbacks?: SubAgentSpawnCallbacks,
      ) {
        const isPlan = input.profileMode === "plan";
        const fire = (entries: ChatEntry[]) =>
          callbacks?.onActivity?.({ entries, toolCallCount: 0 });
        // turn 0: a tool is running, no assistant round has completed yet.
        fire([runningTool("g1")]);
        // still turn 0: assistant text is streaming (not finalized).
        fire([runningTool("g1"), streamingAssistant("thinking…")]);
        // round 1 completes.
        fire([runningTool("g1"), assistant("round one")]);
        // another tool starts WITHIN round 1 — turn count is still 1 (dupe risk).
        fire([runningTool("g1"), assistant("round one"), runningTool("g2")]);
        // round 2 completes.
        fire([
          runningTool("g1"),
          assistant("round one"),
          runningTool("g2"),
          assistant("round two"),
        ]);
        return {
          summary: isPlan ? "PLAN: do A then B" : "OUTPUT: did A then B",
          toolCallCount: 0,
          turnCount: 2,
          childSessionId: `${input.originSessionId}::${isPlan ? "plan" : "exec"}`,
          entries: [],
          ok: true,
        };
      },
    } as unknown as SubAgentRunner;
  }

  it("does not flood: no blank turn:0 and no duplicate turn rows (live events + persisted transcript)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "flooding guard" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const runner = floodingRunner();
      const { gate } = fakeGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const transcriptStorage = memTranscriptStorage();
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
        transcriptStorage,
      });

      const result = await engine.runItem(id);
      expect(result.status).toBe("completed");

      // ── Live progress events ────────────────────────────────────────────
      // Turn events carry a real 1-based turn (never 0) and non-empty text.
      const turnEvents = events.filter((e) => e.turn !== undefined);
      expect(turnEvents.length).toBeGreaterThan(0);
      for (const e of turnEvents) {
        expect(e.turn).toBeGreaterThanOrEqual(1); // no blank turn:0
        expect(e.text ?? "").not.toBe(""); // no empty-text turn frame
      }
      // No duplicate (phase, turn) turn events — each completed round fires once.
      const seen = new Set<string>();
      for (const e of turnEvents) {
        const key = `${e.phase}:${e.turn}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      // Exactly the completed rounds per phase: plan → [1,2], execute → [1,2].
      const planTurns = turnEvents
        .filter((e) => e.phase === "planning")
        .map((e) => e.turn);
      const execTurns = turnEvents
        .filter((e) => e.phase === "executing")
        .map((e) => e.turn);
      expect(planTurns).toEqual([1, 2]);
      expect(execTurns).toEqual([1, 2]);

      // ── Persisted transcript (recorded via record()) ────────────────────
      // Find the run's transcript file and assert the SAME no-blank / no-dupe
      // invariant on the on-disk turn rows.
      const runFile = Object.keys(transcriptStorage.files).find((p) =>
        p.startsWith(`sessions/${id}/`),
      );
      expect(runFile).toBeDefined();
      const runId = runFile!.replace(`sessions/${id}/`, "").replace(/\.jsonl$/, "");
      const recorded = await readRunTranscript(transcriptStorage, id, runId);
      const recordedTurns = recorded.filter((e) => e.kind === "turn");
      expect(recordedTurns.length).toBeGreaterThan(0);
      for (const e of recordedTurns) {
        expect(e.turn ?? 0).toBeGreaterThanOrEqual(1); // no blank turn:0 rows
        expect(e.text ?? "").not.toBe("");
      }
      const recordedKeys = recordedTurns.map((e) => `${e.phase}:${e.turn}`);
      expect(new Set(recordedKeys).size).toBe(recordedKeys.length); // no dupes
    } finally {
      cleanup();
    }
  });
});
