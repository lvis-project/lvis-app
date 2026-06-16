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
 * Fake runner. Records each spawn; returns a phase-specific canned summary
 * matching the real {@link SubAgentRunner} result shape (incl. the `ok`
 * success signal).
 *   - `onExecute` lets a test make the EXECUTE phase THROW (exercises the
 *     engine's catch path) without coupling to a real ConversationLoop.
 *   - `execFails` makes the EXECUTE phase RETURN `{ ok: false }` (the way the
 *     real runner signals a provider-missing / aborted / inner-throw run) so
 *     a failed run is not recorded as success.
 *   - `holdPlan` is a gate promise the PLAN phase awaits before resolving,
 *     letting a test keep a run in-flight to assert the single-flight guard.
 */
function fakeRunner(opts?: {
  onExecute?: () => void;
  execFails?: boolean;
  holdPlan?: Promise<void>;
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
      if (isPlan && opts?.holdPlan) await opts.holdPlan;
      if (!isPlan) opts?.onExecute?.();
      if (!isPlan && opts?.execFails) {
        return {
          summary: "sub-agent: LLM provider not configured",
          toolCallCount: 0,
          turnCount: 0,
          childSessionId: `${input.originSessionId}::exec`,
          ok: false,
          error: "sub-agent: LLM provider not configured",
        };
      }
      return {
        summary: isPlan ? "PLAN: step 1; step 2" : "OUTPUT: completed step 1; step 2",
        toolCallCount: 0,
        turnCount: 1,
        childSessionId: `${input.originSessionId}::${isPlan ? "plan" : "exec"}`,
        ok: true,
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

  it("lands runStatus=error when the EXECUTE sub-agent signals failure (ok:false, not a thrown error)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "execute fails" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      // The real SubAgentRunner does NOT throw on a provider-missing / aborted
      // run — it returns { ok: false } with the error text as `summary`. The
      // engine must branch on that signal and land `error`, never recording the
      // error text as a green `completed` output.
      const { runner, calls } = fakeRunner({ execFails: true });
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
      expect(result.reason).toContain("provider not configured");
      // Plan + execute both ran (execute returned ok:false rather than throwing).
      expect(calls).toHaveLength(2);
      expect(calls[1].profileMode).toBe("execute");

      // No terminal `done`; an `error` event is emitted instead.
      const phases = events.map((e) => e.phase);
      expect(phases).not.toContain("done");
      expect(phases).toContain("error");

      // Persisted run status is `error`; the error text is NOT recorded as output.
      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("error");
      expect(got.item.output).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("rejects a concurrent run of the same item (busy) and does NOT spawn a second agent", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "single flight" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      // Gate the PLAN phase so the first run stays in flight while we fire a
      // second concurrent run at the same id.
      let releasePlan!: () => void;
      const holdPlan = new Promise<void>((resolve) => {
        releasePlan = resolve;
      });
      const { runner, calls } = fakeRunner({ holdPlan });
      const { gate } = fakeGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      // First run: starts, enters PLAN, blocks on holdPlan (still in flight).
      const firstRun = engine.runItem(id);
      // Deterministically wait until the first run has entered the PLAN spawn
      // (the runner recorded its call) before racing a second run at it — this
      // proves the first run is genuinely in flight, not merely scheduled.
      while (calls.length === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }

      // Second concurrent run for the SAME id → busy, no spawn.
      const busy = await engine.runItem(id);
      expect(busy.status).toBe("already_running");
      // Only the first run's PLAN spawn exists; the busy run spawned nothing.
      expect(calls).toHaveLength(1);

      // Let the first run finish cleanly.
      releasePlan();
      const first = await firstRun;
      expect(first.status).toBe("completed");
      // Exactly the first run's plan + execute spawns — never a second agent.
      expect(calls).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("rejects a run when the persisted runStatus is already active (executing)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "persisted active" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      // Simulate a run left mid-flight (e.g. another process / a crash-recovered
      // record) by persisting an active run phase directly.
      await store.setRunStatus(id, "executing");

      const { runner, calls } = fakeRunner();
      const { gate, requests } = fakeGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(id);
      expect(result.status).toBe("already_running");
      // No spawn, no approval — the busy guard short-circuits before either.
      expect(calls).toHaveLength(0);
      expect(requests).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("clears stale run fields at run START: completed → re-run → deny leaves no residual output/runSessionId", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "stale fields" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      // First run: completes, persisting plan + output + runSessionId.
      {
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
      }
      const afterComplete = await store.get(id);
      if (afterComplete.status !== "found") throw new Error("missing item");
      expect(afterComplete.item.runStatus).toBe("completed");
      expect(afterComplete.item.output).toBe("OUTPUT: completed step 1; step 2");
      const completedSession = afterComplete.item.runSessionId;
      expect(completedSession).toBeDefined();

      // Second run on the SAME item: the user DENIES the plan this time.
      {
        const { runner } = fakeRunner();
        const { gate } = fakeGate("deny-once");
        const engine = createWorkBoardEngine({
          store,
          getRunner: () => runner,
          approvalGate: gate,
          emitProgress: () => {},
        });
        const result = await engine.runItem(id);
        expect(result.status).toBe("denied");
      }

      // No residual from the prior COMPLETED run: the success output is gone and
      // the runSessionId is no longer the completed run's execute session.
      const afterDeny = await store.get(id);
      if (afterDeny.status !== "found") throw new Error("missing item");
      expect(afterDeny.item.runStatus).toBe("denied");
      expect(afterDeny.item.output).toBeUndefined();
      expect(afterDeny.item.runSessionId).not.toBe(completedSession);
    } finally {
      cleanup();
    }
  });

  it("requires a fresh plan approval every run — an 'allow always' choice cannot remember a bypass", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "no remembered bypass" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      // The user clicks "allow always" on the very first run's plan.
      const { runner } = fakeRunner();
      const { gate, requests } = fakeGate("allow-always");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const first = await engine.runItem(id);
      expect(first.status).toBe("completed");
      // A second run of the same finished item must STILL hit the gate — the
      // durable choice did not persist a bypass.
      const second = await engine.runItem(id);
      expect(second.status).toBe("completed");

      // The gate was consulted on BOTH runs (no short-circuit / remembered allow).
      expect(requests).toHaveLength(2);
      // Each request carried a UNIQUE per-run id (fresh §8 decision; no cache
      // key can match across runs).
      const ids = requests.map((r) => (r as { id: string }).id);
      expect(ids[0]).not.toBe(ids[1]);
      // The gate identity is the agent-action plan gate, not an executable tool.
      for (const r of requests) {
        expect((r as { toolName: string }).toolName).toBe("work_board_run");
        expect((r as { kind: string }).kind).toBe("agent-action");
      }
    } finally {
      cleanup();
    }
  });
});
