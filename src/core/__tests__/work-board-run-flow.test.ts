/**
 * WorkBoardEngine run-flow contracts (P2 agent orchestration).
 *
 * Companion to `work-board-engine.test.ts`: that file proves the coarse
 * plan→approve→execute / deny / not_found / unwired-runner shapes. This file
 * pins the run-flow CONTRACTS the orchestration layer must keep regardless of
 * the canned summaries:
 *
 *   - the PLAN phase is handed a scoped (read-only) registry while the EXECUTE
 *     phase is deliberately handed the FULL parent registry (sourceTools
 *     omitted) — the two-tier tool-scoping guarantee;
 *   - progress events fire in the exact lifecycle ORDER (not merely "present"),
 *     on both the approve and the deny branch;
 *   - the run session id is PERSISTED to the board and survives a fresh store
 *     re-read (proving it is on disk, not just in the in-memory return);
 *   - a named agent profile's `model:` frontmatter drives BOTH child phases;
 *   - an execute-phase throw lands the item in `runStatus='error'` (no `done`).
 *
 * All LLM / approval-modal dependencies are faked; the board is a real
 * {@link WorkBoardStore} over an OS temp dir (the ~/.lvis namespace is never
 * touched).
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
import type { LoadedAgentProfile } from "../../main/agent-profile-store.js";
import type { WorkBoardRunEvent } from "../../shared/work-board-types.js";

function tempBoard(): { store: WorkBoardStore; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lvis-wbrf-"));
  const path = join(dir, "board.json");
  return {
    store: new WorkBoardStore(path),
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface SpawnCall {
  title: string;
  sourceTools?: string[];
  profileMode?: string;
  profileModel?: string;
  originSessionId?: string;
}

/**
 * Fake runner. Records each spawn; returns a phase-specific canned summary.
 * `onExecute` lets a test make the EXECUTE phase throw to exercise the error
 * branch without coupling to a real ConversationLoop.
 */
function fakeRunner(opts?: {
  onExecute?: () => void;
}): { runner: SubAgentRunner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const runner = {
    async spawn(input: {
      title: string;
      instructions: string;
      sourceTools?: string[];
      profileMode?: string;
      profileModel?: string;
      originSessionId?: string;
    }) {
      calls.push({
        title: input.title,
        sourceTools: input.sourceTools,
        profileMode: input.profileMode,
        profileModel: input.profileModel,
        originSessionId: input.originSessionId,
      });
      const isPlan = input.profileMode === "plan";
      if (!isPlan) opts?.onExecute?.();
      return {
        summary: isPlan ? "PLAN: step 1; step 2" : "OUTPUT: completed step 1; step 2",
        toolCallCount: 0,
        turnCount: 1,
        childSessionId: `${input.originSessionId}::${isPlan ? "plan" : "exec"}`,
      };
    },
  } as unknown as SubAgentRunner;
  return { runner, calls };
}

/** Fake gate returning a scripted choice; records the requests it received. */
function fakeGate(choice: ApprovalChoice): {
  gate: ApprovalGate;
  requests: unknown[];
} {
  const requests: unknown[] = [];
  const gate = {
    async requestAndWait(req: unknown): Promise<ApprovalDecision> {
      requests.push(req);
      return { requestId: "fake", choice };
    },
  } as unknown as ApprovalGate;
  return { gate, requests };
}

/** Fake profile resolver — returns a profile carrying the given model id. */
function profileResolver(
  name: string,
  model: string,
): (n: string) => Promise<LoadedAgentProfile | null> {
  return async (requested) =>
    requested === name
      ? {
          name,
          description: "",
          sourceTools: [],
          triggers: [],
          model,
          body: "",
          filePath: `/fake/${name}.md`,
        }
      : null;
}

describe("WorkBoardEngine — run-flow contracts", () => {
  it("scopes the PLAN registry read-only and grants EXECUTE the full registry", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "scoping check" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate } = fakeGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(id);
      expect(result.status).toBe("completed");
      expect(calls).toHaveLength(2);

      // PLAN phase: scoped to a non-empty read-only allowlist (the SubAgentRunner
      // turns this into a scoped ToolRegistry view). It must contain reads and
      // exclude any write/mutating tool surface.
      const planCall = calls[0];
      expect(planCall.profileMode).toBe("plan");
      expect(planCall.sourceTools).toBeDefined();
      expect(planCall.sourceTools!.length).toBeGreaterThan(0);
      expect(planCall.sourceTools).toContain("read_file");
      expect(planCall.sourceTools).toContain("knowledge_search");
      // No write/mutation tools leak into the plan allowlist.
      for (const forbidden of [
        "write_file",
        "edit_file",
        "delete_file",
        "run_shell",
        "agent_spawn",
      ]) {
        expect(planCall.sourceTools).not.toContain(forbidden);
      }

      // EXECUTE phase: sourceTools OMITTED ⇒ the runner grants the full parent
      // registry (agent_spawn stripped by the runner itself). This is the
      // deliberate asymmetry — execute is not boxed to the plan allowlist.
      const execCall = calls[1];
      expect(execCall.profileMode).toBe("execute");
      expect(execCall.sourceTools).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("emits progress events in lifecycle order on the approve path", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "ordered events" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner } = fakeRunner();
      const { gate } = fakeGate("allow-session");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      await engine.runItem(id);

      // First occurrence of each phase, in the order it first appears. The
      // engine may emit extra `planning`/`executing` turn updates, but the
      // phase ENTRY order must be exactly this sequence.
      const order: WorkBoardRunEvent["phase"][] = [];
      for (const e of events) {
        if (!order.includes(e.phase)) order.push(e.phase);
      }
      expect(order).toEqual([
        "planning",
        "awaiting_approval",
        "executing",
        "done",
      ]);

      // `awaiting_approval` precedes `executing` — approval gates execution.
      const approvalIdx = events.findIndex((e) => e.phase === "awaiting_approval");
      const executingIdx = events.findIndex((e) => e.phase === "executing");
      expect(approvalIdx).toBeGreaterThanOrEqual(0);
      expect(executingIdx).toBeGreaterThan(approvalIdx);

      // Terminal `done` event carries the execute session id.
      const done = events[events.length - 1];
      expect(done.phase).toBe("done");
      expect(done.runSessionId).toBe(`work-board:${id}::exec`);
    } finally {
      cleanup();
    }
  });

  it("on reject: runStatus=denied, no execute spawn, no executing event", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "rejected run" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate, requests } = fakeGate("deny-always");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      const result = await engine.runItem(id);

      expect(result.status).toBe("denied");
      // Plan ran, approval was requested, execute never fired.
      expect(calls).toHaveLength(1);
      expect(calls[0].profileMode).toBe("plan");
      expect(requests).toHaveLength(1);

      // No `executing` or `done` event on the deny branch.
      const phases = events.map((e) => e.phase);
      expect(phases).not.toContain("executing");
      expect(phases).not.toContain("done");
      expect(phases[phases.length - 1]).toBe("denied");

      // Persisted status reflects the rejection; output stays unset.
      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("denied");
      expect(got.item.output).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("persists the run session id durably (survives a fresh store re-read)", async () => {
    const { store, path, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "persist session" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner } = fakeRunner();
      const { gate } = fakeGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(id);
      expect(result.status).toBe("completed");
      const expectedSession = `work-board:${id}::exec`;
      expect(result.runSessionId).toBe(expectedSession);

      // Re-read through a SECOND store instance over the same file → proves the
      // run fields are on disk, not merely cached on the writing instance.
      const reloaded = new WorkBoardStore(path);
      const got = await reloaded.get(id);
      if (got.status !== "found") throw new Error("missing item after reload");
      expect(got.item.runStatus).toBe("completed");
      expect(got.item.runSessionId).toBe(expectedSession);
      expect(got.item.plan).toBe("PLAN: step 1; step 2");
      expect(got.item.output).toBe("OUTPUT: completed step 1; step 2");
      expect(got.item.runUpdatedAt).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("threads a named agent profile's model into both child phases", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "profile model" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate } = fakeGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        getAgentProfile: profileResolver("researcher", "high"),
        emitProgress: () => {},
      });

      const result = await engine.runItem(id, { agentName: "researcher" });
      expect(result.status).toBe("completed");

      expect(calls).toHaveLength(2);
      // Both phases carry the resolved profile model.
      expect(calls[0].profileModel).toBe("high");
      expect(calls[1].profileModel).toBe("high");
    } finally {
      cleanup();
    }
  });

  it("errors when a named profile cannot be resolved (no spawn, no approval)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "missing profile" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate, requests } = fakeGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        getAgentProfile: profileResolver("known", "high"),
        emitProgress: () => {},
      });

      const result = await engine.runItem(id, { agentName: "does-not-exist" });

      expect(result.status).toBe("error");
      expect(calls).toHaveLength(0);
      expect(requests).toHaveLength(0);

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("error");
    } finally {
      cleanup();
    }
  });

  it("lands runStatus=error when the EXECUTE phase throws (no done event)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "execute throws" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner({
        onExecute: () => {
          throw new Error("boom in execute");
        },
      });
      const { gate } = fakeGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      const result = await engine.runItem(id);

      expect(result.status).toBe("error");
      expect(result.reason).toContain("boom in execute");
      // Plan + execute were both attempted; execute threw.
      expect(calls).toHaveLength(2);
      expect(calls[1].profileMode).toBe("execute");

      // No terminal `done`; an `error` event is emitted instead.
      const phases = events.map((e) => e.phase);
      expect(phases).not.toContain("done");
      expect(phases).toContain("error");

      // Persisted run status is `error`; no output was captured.
      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("error");
      expect(got.item.output).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
