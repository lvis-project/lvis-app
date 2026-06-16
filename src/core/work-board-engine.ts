/**
 * WorkBoardEngine — plan → approve → execute orchestration for a single work
 * item.
 *
 * WHY a dedicated engine (and not RoutineEngine reuse): {@link RoutineEngine}
 * `runRoutine` is a SINGLE-shot fire — one `createConversationLoop()` + one
 * `runTurn()` + a 200-codepoint `<summary>` extract sized for the OverlayCard.
 * It has no concept of a two-phase plan→approve→execute handshake, no
 * {@link ApprovalGate} dependency, and its summary cap would truncate a real
 * execution OUTPUT. Forcing a board run through it would mean either gluing two
 * routine fires together with ad-hoc approval code, or branching approval logic
 * into the routine engine — both break the routine engine's single
 * responsibility.
 *
 * Instead the board run REUSES the lower-level {@link SubAgentRunner}, which
 * already does the hard part: an isolated child {@link ConversationLoop} with a
 * fresh history persisted under its own `childSessionId`, a scoped
 * {@link ToolRegistry}, per-profile plan/execute posture + model resolution,
 * the per-tool {@link ApprovalGate} wrapper, and final output capture. The
 * engine OWNS only the sequencing the runner does not: plan→approve→execute
 * ordering, the coarse plan-approval gate, board persistence of the captured
 * plan/output, and the live run-progress events. This mirrors how
 * `agent-spawn.ts` is a thin caller over the same runner.
 *
 * Session isolation: each phase spawns with `originSessionId:
 * "work-board:<itemId>"`, so the runner persists the child under
 * `work-board:<itemId>::<uuid>` — the work-board-namespaced isolated session
 * the design calls for. The execute child's `childSessionId` is stored back on
 * the item (`runSessionId`) for audit/trace linking.
 *
 * Host code: this never touches a plugin-facing HostApi. It writes the board
 * through {@link WorkBoardStore} directly and emits progress to the renderer
 * through the injected `emitProgress` sink (wired to the WORK_BOARD.runProgress
 * channel at boot).
 */
import { randomUUID } from "node:crypto";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import type {
  ApprovalGate,
  ApprovalDecision,
} from "../permissions/approval-gate.js";
import type { LoadedAgentProfile } from "../main/agent-profile-store.js";
import type { WorkBoardStore } from "../main/work-board-store.js";
import type { WorkItem, WorkBoardRunEvent } from "../shared/work-board-types.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("work-board-engine");

/**
 * Read-only tool surface for the PLAN phase. The plan agent investigates the
 * task but must NOT mutate state — so it gets list/search/read tools only. The
 * EXECUTE phase deliberately omits `sourceTools` (passes `undefined`) so the
 * runner grants the FULL parent registry, including other plugins' tools, with
 * only `agent_spawn` stripped. Naming the read-only set explicitly (rather than
 * relying on a posture hint) keeps the no-mutation guarantee enforced at the
 * registry, not just suggested in the prompt.
 */
const PLAN_READONLY_TOOLS: readonly string[] = [
  "read_file",
  "list_files",
  "glob_files",
  "grep_files",
  "knowledge_search",
  "document_list",
  "document_structure",
  "document_page_content",
  "web_search",
  "web_fetch",
];

export interface WorkBoardEngineDeps {
  /** Board persistence — the engine writes plan/output/runStatus through this. */
  store: WorkBoardStore;
  /**
   * Late-bound {@link SubAgentRunner} accessor. Mirrors `agent-spawn.ts`'s
   * `getRunner` closure (the runner is constructed after the parent
   * ConversationLoop exists at boot). `undefined` before that point ⇒ runItem
   * returns `{ status: 'error' }` rather than throwing.
   */
  getRunner: () => SubAgentRunner | undefined;
  /** Live approval gate — the coarse plan-approval modal goes through this. */
  approvalGate: ApprovalGate;
  /**
   * Optional agent-profile resolver. When the caller names an agent, its
   * `model:` frontmatter drives the child model for both phases.
   */
  getAgentProfile?: (name: string) => Promise<LoadedAgentProfile | null>;
  /** Renderer event sink — one {@link WorkBoardRunEvent} per phase transition. */
  emitProgress: (event: WorkBoardRunEvent) => void;
}

export interface RunItemOptions {
  /** Named agent profile — supplies the model for both child phases. */
  agentName?: string;
}

export interface RunItemResult {
  status: "completed" | "denied" | "not_found" | "error";
  /** Captured execution OUTPUT (completed). */
  output?: string;
  /** Captured plan text (completed / denied). */
  plan?: string;
  /** The execute child's session id (completed). */
  runSessionId?: string;
  /** Failure / denial reason (error / denied). */
  reason?: string;
}

export interface WorkBoardEngine {
  /**
   * Run one item through plan → approve → execute. Idempotent only in the sense
   * that re-running overwrites the prior run fields; concurrent runs of the
   * same id are the caller's responsibility (the IPC layer fires-and-forgets).
   */
  runItem(itemId: number, opts?: RunItemOptions): Promise<RunItemResult>;
}

/** Build the PLAN-phase task prompt from the item's title + detail. */
function buildPlanPrompt(item: WorkItem): string {
  const detail = item.detail?.trim();
  return [
    `You are planning how to complete the following work item. Investigate using read-only tools, then produce a concise, concrete, step-by-step PLAN. Do NOT make any changes — this is the planning phase only.`,
    ``,
    `Work item #${item.id}: ${item.title}`,
    ...(detail ? [``, `Details:`, detail] : []),
    ``,
    `Respond with the plan as your final message. Keep it actionable — the user will approve it before execution begins.`,
  ].join("\n");
}

/** Build the EXECUTE-phase task prompt from the item + the approved plan. */
function buildExecutePrompt(item: WorkItem, plan: string): string {
  const detail = item.detail?.trim();
  return [
    `Execute the following work item according to the approved plan below. You have full tools available; each individual tool call is still independently approved by the user.`,
    ``,
    `Work item #${item.id}: ${item.title}`,
    ...(detail ? [``, `Details:`, detail] : []),
    ``,
    `Approved plan:`,
    plan,
    ``,
    `Carry out the plan and report the OUTCOME as your final message.`,
  ].join("\n");
}

/**
 * A decision is a denial when the user rejected the plan or the gate timed out
 * (the gate returns `deny-once` after its 5-minute timeout). Only the explicit
 * allow choices proceed to execution — no implicit pass-through.
 */
function isDenied(decision: ApprovalDecision): boolean {
  return decision.choice.startsWith("deny");
}

export function createWorkBoardEngine(
  deps: WorkBoardEngineDeps,
): WorkBoardEngine {
  const { store, getRunner, approvalGate, getAgentProfile, emitProgress } = deps;

  const emit = (event: Omit<WorkBoardRunEvent, "at">): void => {
    emitProgress({ ...event, at: new Date().toISOString() });
  };

  async function runItem(
    itemId: number,
    opts: RunItemOptions = {},
  ): Promise<RunItemResult> {
    const got = await store.get(itemId);
    if (got.status !== "found") {
      return { status: "not_found" };
    }
    const item = got.item;

    const runner = getRunner();
    if (!runner) {
      // The runner is late-bound after the parent ConversationLoop exists; a
      // call before that point is a wiring error, not an external boundary —
      // surface it as an error rather than papering over with a fallback path.
      await store.setRunResult(itemId, {
        runStatus: "error",
      });
      emit({ itemId, phase: "error", message: "sub-agent runner not available" });
      return { status: "error", reason: "sub-agent runner not available" };
    }

    // Resolve the agent profile (model override) once for both phases. A named
    // profile that does not exist is an explicit error — no silent default.
    let profile: LoadedAgentProfile | null = null;
    if (opts.agentName) {
      profile = (await getAgentProfile?.(opts.agentName)) ?? null;
      if (!profile) {
        await store.setRunResult(itemId, { runStatus: "error" });
        emit({
          itemId,
          phase: "error",
          message: `agent profile not found: ${opts.agentName}`,
        });
        return {
          status: "error",
          reason: `agent profile not found: ${opts.agentName}`,
        };
      }
    }

    const originSessionId = `work-board:${itemId}`;

    try {
      // ── PLAN ───────────────────────────────────────────────────────────
      await store.setRunStatus(itemId, "planning");
      emit({ itemId, phase: "planning" });

      const planResult = await runner.spawn(
        {
          title: `Plan: ${item.title}`,
          instructions: buildPlanPrompt(item),
          sourceTools: [...PLAN_READONLY_TOOLS],
          originSessionId,
          profileMode: "plan",
          profileModel: profile?.model,
        },
        {
          onTurn: (u) =>
            emit({ itemId, phase: "planning", turn: u.turn, text: u.text }),
          onError: (message) => emit({ itemId, phase: "error", message }),
        },
      );
      const plan = planResult.summary;
      await store.setRunResult(itemId, {
        runStatus: "awaiting_approval",
        plan,
        runSessionId: planResult.childSessionId,
      });

      // ── APPROVE ────────────────────────────────────────────────────────
      // `kind: 'agent-action'` + `toolCategory: 'meta'` deliberately skips both
      // the read-only short-circuit and the sandbox-capability injection so the
      // user ALWAYS sees an explicit plan-approval modal (not auto-approved).
      emit({ itemId, phase: "awaiting_approval" });
      const decision = await approvalGate.requestAndWait({
        id: `work-board-run:${itemId}:${randomUUID()}`,
        category: "agent-action",
        kind: "agent-action",
        toolName: "work_board_run",
        toolCategory: "meta",
        reason: `Work item #${itemId} "${item.title}" — approve plan to execute?`,
        args: { plan },
        source: "builtin",
        createdAt: Date.now(),
        trustOrigin: "user-keyboard",
      });

      if (isDenied(decision)) {
        await store.setRunResult(itemId, { runStatus: "denied", plan });
        emit({ itemId, phase: "denied", message: decision.choice });
        return { status: "denied", plan, reason: decision.choice };
      }

      // ── EXECUTE ────────────────────────────────────────────────────────
      // `sourceTools` omitted ⇒ the runner grants the FULL parent registry
      // (incl. plugin tools, `agent_spawn` stripped). Each tool the execute
      // agent calls still hits the SAME ApprovalGate per-tool, so destructive
      // tool use stays independently gated — the plan-approval is the coarse
      // gate, the per-tool gate is the fine one. No double-approval bypass.
      await store.setRunStatus(itemId, "executing");
      emit({ itemId, phase: "executing" });

      const execResult = await runner.spawn(
        {
          title: `Execute: ${item.title}`,
          instructions: buildExecutePrompt(item, plan),
          originSessionId,
          profileMode: "execute",
          profileModel: profile?.model,
        },
        {
          onTurn: (u) =>
            emit({ itemId, phase: "executing", turn: u.turn, text: u.text }),
          onError: (message) => emit({ itemId, phase: "error", message }),
        },
      );
      const output = execResult.summary;

      await store.setRunResult(itemId, {
        runStatus: "completed",
        plan,
        output,
        runSessionId: execResult.childSessionId,
      });
      emit({
        itemId,
        phase: "done",
        runSessionId: execResult.childSessionId,
      });
      return {
        status: "completed",
        plan,
        output,
        runSessionId: execResult.childSessionId,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn("runItem error (id=%d): %s", itemId, reason);
      await store
        .setRunResult(itemId, { runStatus: "error" })
        .catch((persistErr) =>
          log.warn(
            "runItem error-state persist failed (id=%d): %s",
            itemId,
            (persistErr as Error).message,
          ),
        );
      emit({ itemId, phase: "error", message: reason });
      return { status: "error", reason };
    }
  }

  return { runItem };
}
