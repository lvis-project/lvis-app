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
import type { SubAgentRunner } from "../../engine/subagent-runner.js";
import type {
  ApprovalGate,
  ApprovalDecision,
  ApprovalChoice,
} from "../../permissions/approval-gate.js";
import type { WorkBoardRunEvent } from "../../shared/work-board-types.js";

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
});
