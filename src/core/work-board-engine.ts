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
 * "work-board:<itemId>"`, so the runner persists the child in the isolated
 * `~/.lvis/subagent/` namespace under a regex-valid `sub-<originTag>-<uuid>` id
 * (where `originTag` is a short hash of the origin id) — the isolated session
 * the design calls for. The execute child's `childSessionId` is stored back on
 * the item (`runSessionId`) for audit/trace linking.
 *
 * Host code: this never touches a plugin-facing HostApi. It writes the board
 * through {@link WorkBoardStore} directly and emits progress to the renderer
 * through the injected `emitProgress` sink (wired to the WORK_BOARD.runProgress
 * channel at boot).
 */
import { randomUUID } from "node:crypto";
import {
  exactToolScope,
  PARENT_ALL_TOOL_SCOPE,
  type SubAgentRunner,
} from "../engine/subagent-runner.js";
import type {
  ApprovalGate,
  ApprovalDecision,
} from "../permissions/approval-gate.js";
import type { LoadedAgentProfile } from "../main/agent-profile-store.js";
import type { WorkBoardStore } from "../main/work-board-store.js";
import type {
  WorkItem,
  WorkItemResolved,
  WorkBoardBriefingKind,
  WorkBoardBriefingResult,
  WorkBoardRunEvent,
  WorkProposalInput,
} from "../shared/work-board-types.js";
import {
  BRIEFING_PROPOSAL_KINDS,
  MAX_PROPOSAL_BLOCKERS,
  MAX_PROPOSAL_EVIDENCE,
  PROPOSAL_KEY_MAX,
  workBoardOriginSessionId,
} from "../shared/work-board-types.js";
import { createLogger } from "../lib/logger.js";
import {
  createRunTranscript,
  type TranscriptStorage,
  type RunTranscriptWriter,
} from "../work-board/run-transcript.js";
import type { SubAgentActivityUpdate } from "../engine/subagent-runner.js";
import { errorMessage } from "../shared/error-message.js";
import { requiredTier } from "../permissions/permission-manager.js";
import type { ToolRegistry } from "../tools/registry.js";

const log = createLogger("work-board-engine");

/**
 * Map a sub-agent activity snapshot to the work-board transcript's per-turn
 * shape (`turn` = 1-based COMPLETED assistant round count, `text` = latest
 * assistant text). The board records a coarse per-turn plan/exec narrative — it
 * does not render the full ChatEntry timeline (that surface is the chat's
 * sub-agent tab), so it consumes the same `onActivity` snapshot but flattens it
 * to the turn text.
 *
 * `turn === 0` means no assistant round has completed yet — the snapshot only
 * holds in-flight tool_start/permission_review/streaming entries. Such a frame
 * carries no board-relevant turn narrative, so the caller drops it (see
 * `makeTurnRecorder`).
 */
function activityToTurn(u: SubAgentActivityUpdate): { turn: number; text: string } {
  let turn = 0;
  let text = "";
  for (const entry of u.entries) {
    if (entry.kind === "assistant" && entry.streaming !== true) {
      turn += 1;
      if (entry.text) text = entry.text;
    }
  }
  return { turn, text };
}

/**
 * Build the per-phase `onActivity` handler that emits + records ONE turn event
 * per newly-completed assistant round.
 *
 * WHY this guard exists: `onActivity` fires on EVERY child-loop callback
 * (tool_start / tool_end / permission_review / assistant_round) so the sub-agent
 * TAB can live-render the full ChatEntry timeline. The board, however, wants
 * only the coarse per-turn narrative. Forwarding raw `activityToTurn` on every
 * callback floods the board two ways: (1) every pre-first-round tool/permission
 * frame maps to a blank `{turn:0, text:""}`, and (2) every extra callback WITHIN
 * a round re-emits the SAME `{turn:N, text}` — and `record()` APPENDS to the
 * JSONL transcript, so the dupes accumulate on disk (and flood the live
 * `runProgress` IPC channel).
 *
 * The guard collapses that back to the pre-transcript-migration semantics: skip
 * `turn === 0` (no completed round) and skip any turn already forwarded — one
 * event per new completed round, no blanks, no dupes. The handler holds its own
 * per-phase `lastTurn` (created fresh for plan and for execute), so each phase's
 * turn count restarts from 1.
 */
function makeTurnRecorder(
  onTurn: (turn: number, text: string) => void,
): (u: SubAgentActivityUpdate) => void {
  let lastTurn = 0;
  return (u) => {
    const { turn, text } = activityToTurn(u);
    // No completed assistant round yet (turn 0), or this round was already
    // forwarded — nothing new to narrate for the board.
    if (turn <= lastTurn) return;
    lastTurn = turn;
    onTurn(turn, text);
  };
}

/**
 * Read-only tool surface for the PLAN phase, DERIVED from the parent registry:
 * every registered tool whose permission category needs no more than the read
 * tier (`requiredTier(category) === "read"`).
 *
 * The plan agent investigates the task but must NOT mutate state. Deriving the
 * set from the registry keeps the no-mutation guarantee enforced where the
 * permission manager itself enforces it, so plan mode and the gate cannot
 * disagree about what "read" means — and it keeps plugin tool names out of host
 * code: a plugin's read tools are granted because of the category they declare,
 * with the host naming no plugin and holding no list to edit when one is
 * installed or removed.
 *
 * The STATIC `category` decides. A tool that carries a `categoryForInput` reads
 * as its declared category here, whatever a particular call's arguments would
 * have made it: a category that depends on the input is not a read-tier tool.
 * `web_fetch` is `network` by that rule and so is absent from plan mode, which
 * is the registry's answer rather than this module's.
 *
 * The EXECUTE phase deliberately asks for `PARENT_ALL_TOOL_SCOPE`, so the
 * runner grants the FULL parent registry, including other plugins' tools, with
 * only `agent_spawn` stripped.
 */
/** Why a run stops when the derivation finds nothing to grant. */
const PLAN_TOOLS_EMPTY = "no read-tier tools are registered";

function planReadOnlyToolNames(registry: ToolRegistry): string[] {
  return registry
    .listAll()
    .filter((tool) => requiredTier(tool.category) === "read")
    .map((tool) => tool.name);
}

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
  /** Live approval gate — the coarse plan-approval prompt goes through this. */
  approvalGate: ApprovalGate;
  /**
   * Optional agent-profile resolver. When the caller names an agent, its
   * `model:` frontmatter drives the child model for both phases.
   */
  getAgentProfile?: (name: string) => Promise<LoadedAgentProfile | null>;
  /** Renderer event sink — one {@link WorkBoardRunEvent} per phase transition. */
  emitProgress: (event: WorkBoardRunEvent) => void;
  /**
   * Optional storage for persisting per-run transcripts under
   * `sessions/<itemId>/<runId>.jsonl`. The engine streams the plan + execute
   * conversation here so a run's context survives restart and accumulates
   * across re-runs (see work-board/run-transcript.ts). Absent ⇒ transcripts are
   * skipped (the run still works) — keeps existing tests deps-light.
   */
  transcriptStorage?: TranscriptStorage;
  /**
   * Optional post-run learning hook (the self-improvement pillar). Called
   * fire-and-forget AFTER a run reaches `completed` and is persisted; a throw
   * here must never fail the already-succeeded run, so the engine swallows
   * rejections. boot wires this to append a one-line learning to the item's
   * project work memory.
   */
  onRunComplete?: (info: { itemId: number; title: string; projectRoot?: string; projectName?: string }) => void | Promise<void>;
}

export interface RunItemOptions {
  /** Named agent profile — supplies the model for both child phases. */
  agentName?: string;
}

export interface RunItemResult {
  status: "completed" | "denied" | "not_found" | "error" | "already_running";
  /** Captured execution OUTPUT (completed). */
  output?: string;
  /** Captured plan text (completed / denied). */
  plan?: string;
  /** The execute child's session id (completed). */
  runSessionId?: string;
  /**
   * Failure / denial reason (error / denied), or the busy explanation when
   * `status === "already_running"` (a concurrent run of the same item is in
   * flight — no second sub-agent was spawned).
   */
  reason?: string;
}

export interface WorkBoardEngine {
  /**
   * Run one item through plan → approve → execute.
   *
   * Concurrency is guaranteed by the engine, not delegated to the caller: a
   * single in-flight run per item id is enforced by an in-process guard plus a
   * persisted-active-status check at the top of {@link runItem}. A second
   * `runItem` for an id whose run is already active (in this process OR per the
   * persisted `runStatus` ∈ {planning, awaiting_approval, executing}) returns
   * `{ status: "already_running" }` WITHOUT spawning a second sub-agent — so
   * two windows, an LLM tool call, and the renderer can never drive two
   * concurrent sub-agents (and never two destructive EXECUTE runs) for the same
   * item. Re-running a *finished* item (completed / denied / error) is allowed
   * and overwrites the prior run fields from a clean record.
   */
  runItem(itemId: number, opts?: RunItemOptions): Promise<RunItemResult>;

  /**
   * Run one briefing: survey the user's work with a read-only sub-agent, then
   * file what it found onto the board as proposals.
   *
   * The opposite direction from the reports surface — a report summarizes the
   * board, a briefing looks outside it and adds to it. There is no plan-approval
   * gate here because the survey cannot mutate anything (its registry is the
   * read-only set) and its output is proposals, which the user reviews on the
   * board card by card. Each individual tool call the survey makes still hits
   * the same per-tool {@link ApprovalGate} the runner wraps.
   *
   * One briefing per window at a time: a second call while one is in flight
   * returns an `error` envelope rather than spawning a second survey.
   */
  runBriefing(
    kind: WorkBoardBriefingKind,
    opts?: BriefingOptions,
  ): Promise<WorkBoardBriefingResult>;
}

interface BriefingOptions {
  /** Workspace root the survey runs in, and the board slice it is shown. */
  projectRoot?: string;
  /** Include items with no project when scoping the board slice. */
  includeUnscoped?: boolean;
}

/**
 * Host-assigned round budget for the PLAN phase. Planning is "investigate
 * briefly → produce a plan", not open-ended work — a bounded budget forces
 * convergence and prevents the runaway loop / context blow-up observed when a
 * plan agent kept re-asking an unanswerable clarifying question (autonomous
 * runs have no answer channel) or retried an erroring tool. The spawn returns
 * its best plan-so-far when the budget is hit, so the run always reaches the
 * approval gate.
 *
 * Set to 20 (was 6): 6 was the source of the "sub-agent stops at 6 rounds"
 * report — investigation of a non-trivial item (a few read-only tool calls +
 * reasoning + writing the plan) legitimately needs more than 6 assistant
 * rounds, so 6 caused premature round-caps that truncated real plans. 20
 * matches the `default`/`execute` standard-work budget while staying well
 * under the 30 ceiling. This is a HOST policy value (a fixed-shape internal
 * phase), passed as `maxRounds` — the LLM cannot influence it (the
 * `agent_spawn` tool no longer exposes a round knob).
 */
const PLAN_ROUND_BUDGET = 20;

/** Build the PLAN-phase task prompt from the item's title + detail. */
function buildPlanPrompt(item: WorkItem): string {
  const detail = item.detail?.trim();
  return [
    `You are planning how to complete the following work item. You are running AUTONOMOUSLY: there is NO human available to answer questions during this run.`,
    ``,
    `Rules:`,
    `- Do NOT ask the user any questions and do NOT request clarification. If the request is ambiguous, pick the most reasonable interpretation, state that assumption explicitly in the plan, and proceed.`,
    `- Investigate briefly with read-only tools only if it materially helps (a few calls at most). If a tool errors, note it and move on — never retry in a loop.`,
    `- Make NO changes — this is the planning phase only.`,
    ``,
    `Work item #${item.id}: ${item.title}`,
    ...(detail ? [``, `Details:`, detail] : []),
    ``,
    `Respond with the PLAN as your final message: a concise, concrete, step-by-step plan with any assumptions called out under an "Assumptions" heading. The user reviews and approves this plan (and your assumptions) before execution — that approval is the only human checkpoint.`,
  ].join("\n");
}

/** Build the EXECUTE-phase task prompt from the item + the approved plan. */
function buildExecutePrompt(item: WorkItem, plan: string): string {
  const detail = item.detail?.trim();
  return [
    `Execute the following work item according to the approved plan below. You are running AUTONOMOUSLY: do NOT ask the user any questions — proceed per the plan, and if something is ambiguous, act on the plan's stated assumptions (or the most reasonable one) and note it in your output. You have full tools available; each individual tool call is still independently approved by the user. If a tool errors, adapt or note it — never retry in a loop.`,
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
 * Host-assigned round budget for a BRIEFING survey. A briefing is "look around,
 * then list what needs doing" — the same fixed shape as the plan phase, and
 * bounded for the same reason: the survey has no answer channel, so an
 * unbounded loop is the failure mode, not the feature. The spawn returns its
 * best answer when the budget is hit, so the run always reaches the parse step.
 */
const BRIEFING_ROUND_BUDGET = 20;

/**
 * Most action items one briefing run may file. A survey that comes back with
 * thirty items has not prioritised, and a board that gains thirty cards from
 * one button press is a board the user stops reading.
 */
const MAX_BRIEFING_ACTION_ITEMS = 8;

/**
 * How long a filed proposal stays open with no further contact. A daily
 * briefing's findings go stale by the next one, so they expire in a day; a
 * weekly's stand for the week.
 */
const BRIEFING_TTL_MS: Record<WorkBoardBriefingKind, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** What the survey is told to look across, per window. */
const BRIEFING_WINDOW: Record<WorkBoardBriefingKind, string> = {
  daily: "today and the next working day",
  weekly: "the past week and the week ahead",
};

/**
 * The stable identity of one surveyed action item: its title, lowercased,
 * stripped of punctuation and collapsed to single spaces.
 *
 * This is what duplicate suppression keys on, because the proposal id is
 * `<source>:<kind>:<hash(key)>` — whatever goes in the key is what decides
 * whether a second run refreshes the existing card or adds another one.
 * Everything else a survey emits moves between runs: the summary gets
 * re-worded, the evidence cites whatever the agent happened to read that pass,
 * and there is no id to borrow because an action item's source is a thread or a
 * file, not a row. The NAME of the thing to do is the one part the user would
 * recognise as "that same item again". Normalising it absorbs the presentation
 * drift that would otherwise file "Reply to the design review" and "Reply to
 * the Design Review!" as two separate cards. A survey that renames the work
 * outright does file a second card — that is the honest outcome, because a
 * different name is a different claim about what needs doing.
 */
function briefingKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, PROPOSAL_KEY_MAX)
    .trim();
}

/** One line of board context handed to the survey so it does not re-propose it. */
function briefingBoardLine(item: WorkItemResolved): string {
  return `- [${item.status_resolved}] ${item.title}`;
}

/**
 * Build the survey prompt. Host-owned: the wording, the bound, and the output
 * contract are all fixed here rather than assembled from anything the model or
 * a plugin supplied.
 *
 * The open board is included so the survey answers "what ELSE needs doing"
 * rather than handing back the items the user already has.
 */
function buildBriefingPrompt(
  kind: WorkBoardBriefingKind,
  openItems: readonly WorkItemResolved[],
): string {
  return [
    `You are running the user's ${kind} work briefing. You are running AUTONOMOUSLY: there is NO human available to answer questions during this run.`,
    ``,
    `Survey what the user is working on across ${BRIEFING_WINDOW[kind]} and report the action items that need their attention.`,
    ``,
    `Rules:`,
    `- Do NOT ask the user any questions and do NOT request clarification. If something is ambiguous, state the assumption inside the item you report and move on.`,
    `- Investigate with read-only tools only. Make NO changes of any kind.`,
    `- If a tool errors, note it and move on — never retry in a loop.`,
    `- Report at most ${MAX_BRIEFING_ACTION_ITEMS} items, highest-consequence first. Fewer is better than padded.`,
    `- Do NOT repeat anything already on the board (listed below).`,
    ``,
    `Already on the board:`,
    openItems.length > 0 ? openItems.map(briefingBoardLine).join("\n") : "- Nothing open.",
    ``,
    `Respond with ONLY a JSON array in a \`\`\`json fenced block, and no prose before or after it. Each element:`,
    `{`,
    `  "title": "one line naming the work",`,
    `  "summary": "one line saying why it needs attention",`,
    `  "state": "where this currently stands",`,
    `  "evidence": [{ "label": "what you looked at", "detail": "what it said" }],`,
    `  "blockers": [{ "reason": "what stops it", "resolution": "what would unblock it" }],`,
    `  "taskBrief": "instructions for an agent that will later carry this out",`,
    `  "priority": "high" | "medium" | "low"`,
    `}`,
    ``,
    `"evidence" and "blockers" may be empty arrays. If nothing needs the user's attention, respond with an empty array.`,
  ].join("\n");
}

/**
 * Outcome of reading a survey's final message. `ok` with an empty list means
 * the survey ran and found nothing; `ok: false` means the message was not a
 * survey answer at all, which is a run failure the user should see rather than
 * a quiet "nothing to do".
 */
type BriefingParse =
  | { ok: true; items: WorkProposalInput[] }
  | { ok: false; reason: string };

/** Pull the JSON array out of a final message, fenced or bare. */
function extractJsonArray(text: string): unknown[] | null {
  const fenced = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text);
  const candidate = fenced?.[1] ?? /\[[\s\S]*\]/.exec(text)?.[0];
  if (candidate === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedRows<T>(value: unknown, max: number, map: (row: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const rows: T[] = [];
  for (const raw of value.slice(0, max)) {
    if (!raw || typeof raw !== "object") continue;
    const mapped = map(raw as Record<string, unknown>);
    if (mapped !== null) rows.push(mapped);
  }
  return rows;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Turn a survey's final message into proposal inputs.
 *
 * A row missing any of the four fields the board renders is dropped rather than
 * filled in: the host inventing a "state" for an item it did not survey would
 * be attributing text to the briefing that the briefing never produced. The
 * store applies the real length caps — this only decides which rows are
 * action items at all.
 */
function parseBriefingActionItems(
  kind: WorkBoardBriefingKind,
  text: string,
): BriefingParse {
  const rows = extractJsonArray(text);
  if (rows === null) {
    return { ok: false, reason: "briefing output did not contain a JSON action-item array" };
  }

  const items: WorkProposalInput[] = [];
  for (const raw of rows.slice(0, MAX_BRIEFING_ACTION_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const title = nonEmptyString(row.title);
    const summary = nonEmptyString(row.summary);
    const state = nonEmptyString(row.state);
    const taskBrief = nonEmptyString(row.taskBrief);
    if (title === null || summary === null || state === null || taskBrief === null) {
      log.warn("briefing action item dropped — missing a required field");
      continue;
    }
    const key = briefingKey(title);
    if (key.length === 0) continue;
    // An unrecognised priority is omitted rather than mapped here, so the
    // default lives only in `normalizeProposalInput` — two copies of "what an
    // unstated priority means" is one copy too many.
    const priority =
      row.priority === "high" || row.priority === "medium" || row.priority === "low"
        ? row.priority
        : undefined;
    items.push({
      kind: BRIEFING_PROPOSAL_KINDS[kind],
      key,
      title,
      summary,
      state,
      evidence: boundedRows(row.evidence, MAX_PROPOSAL_EVIDENCE, (e) => {
        const label = nonEmptyString(e.label);
        const detail = nonEmptyString(e.detail);
        return label !== null && detail !== null ? { label, detail } : null;
      }),
      blockers: boundedRows(row.blockers, MAX_PROPOSAL_BLOCKERS, (b) => {
        const reason = nonEmptyString(b.reason);
        if (reason === null) return null;
        const resolution = nonEmptyString(b.resolution);
        return resolution !== null ? { reason, resolution } : { reason };
      }),
      taskBrief,
      ...(priority !== undefined ? { priority } : {}),
      ttlMs: BRIEFING_TTL_MS[kind],
    });
  }
  return { ok: true, items };
}

/**
 * A decision is a denial when the user rejected the plan or the gate timed out
 * (the gate returns `deny-once` after its 5-minute timeout). Only the explicit
 * allow choices proceed to execution — no implicit pass-through.
 */
function isDenied(decision: ApprovalDecision): boolean {
  return decision.choice.startsWith("deny");
}

/**
 * Clamp a plan-approval decision so the durable choices (allow-always /
 * allow-session) are treated as allow-ONCE for THIS run, and the
 * `rememberPattern` is dropped.
 *
 * Why: the plan-approval gate is a coarse "approve this run's plan before it
 * executes" decision, not a standing tool grant. If a durable choice were
 * honored, its remember pattern (defaulting to the gate's `toolName`,
 * `work_board_run`) would persist into the user-approval cache and one
 * "allow always" click would permanently disable the §8 plan-approval gate
 * for EVERY future run of EVERY item. Downgrading here guarantees each run
 * gets a genuine fresh decision — the user always re-approves a plan before it
 * executes. The per-run gate `id` is already unique (a fresh UUID), so no
 * cache key can match across runs either; this clamp is the engine-owned
 * second layer that also strips the remember intent the renderer attached.
 */
function clampToOnceForRun(decision: ApprovalDecision): ApprovalDecision {
  if (decision.choice === "allow-always" || decision.choice === "allow-session") {
    return { ...decision, choice: "allow-once", rememberPattern: undefined };
  }
  return decision;
}

/**
 * Run-status values that mean a run is ACTIVE (mid-flight). A persisted item in
 * one of these is being driven by a live `runItem` call — re-entering returns
 * the busy envelope rather than spawning a second sub-agent. The terminal
 * states (completed / denied / error) and `idle` are NOT active, so a finished
 * item can be re-run.
 */
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set<string>([
  "planning",
  "awaiting_approval",
  "executing",
]);

export function createWorkBoardEngine(
  deps: WorkBoardEngineDeps,
): WorkBoardEngine {
  const { store, getRunner, approvalGate, getAgentProfile, emitProgress, onRunComplete, transcriptStorage } =
    deps;

  /**
   * In-process single-flight guard. Holds the ids whose run is currently in
   * flight inside THIS engine instance. Combined with the persisted
   * `runStatus` check, it rejects a concurrent run that another caller (window,
   * LLM tool, renderer) started before the persisted status has been written —
   * the synchronous `inFlight.has` check closes the await-gap race that a
   * disk-status check alone would leave open.
   */
  const inFlight = new Set<number>();

  /**
   * Same single-flight discipline as `inFlight`, one slot per briefing window.
   * Two clicks on Daily briefing must survey once, not twice — the second
   * survey would file the same keys and read as a no-op while costing a full
   * agent run.
   */
  const briefingInFlight = new Set<WorkBoardBriefingKind>();

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

    // ── Single-flight guard ──────────────────────────────────────────────
    // Reject a concurrent run BEFORE spawning anything: an in-process run for
    // this id, or a persisted run that is mid-flight (planning /
    // awaiting_approval / executing) per the board. Either way we return the
    // busy envelope without touching the runner — no second sub-agent, no
    // clobbered run fields, no risk of two destructive EXECUTE runs.
    if (inFlight.has(itemId) || ACTIVE_RUN_STATUSES.has(item.runStatus ?? "idle")) {
      return {
        status: "already_running",
        reason: `Work item #${itemId} is already running (runStatus=${item.runStatus ?? "idle"}).`,
      };
    }
    inFlight.add(itemId);
    try {
      return await runItemGuarded(itemId, item, opts);
    } finally {
      inFlight.delete(itemId);
    }
  }

  async function runItemGuarded(
    itemId: number,
    item: WorkItem,
    opts: RunItemOptions,
  ): Promise<RunItemResult> {
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

    // A derivation that finds nothing stops the run. `exactToolScope` would
    // throw on the empty list rather than widen — the type has no inhabitant
    // that means "nothing, so everything" — but the plan agent still needs to
    // fail as a run result the board can show, not as an exception.
    const planTools = planReadOnlyToolNames(runner.parentToolRegistry());
    if (planTools.length === 0) {
      await store.setRunResult(itemId, { runStatus: "error" });
      emit({ itemId, phase: "error", message: PLAN_TOOLS_EMPTY });
      return { status: "error", reason: PLAN_TOOLS_EMPTY };
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

    const originSessionId = workBoardOriginSessionId(itemId);
    const runId = randomUUID();
    const startedAt = new Date(Date.now()).toISOString();

    // Stream the run's conversation to a persisted transcript. Appends are
    // serialized on a chain and error-swallowed so a transcript write can
    // neither slow nor fail the run; `flushTranscript()` drains it before a
    // terminal return. Declared OUTSIDE the try so the catch path can also
    // record + flush the failure (block-scoped consts would be invisible there).
    const transcript: RunTranscriptWriter | null = transcriptStorage
      ? createRunTranscript(transcriptStorage, itemId, runId)
      : null;
    let transcriptChain: Promise<void> = Promise.resolve();
    const record = (e: Parameters<RunTranscriptWriter["append"]>[0]): void => {
      if (!transcript) return;
      transcriptChain = transcriptChain
        .then(() => transcript.append(e))
        .catch((err) =>
          log.warn("runItem transcript append failed (id=%d): %s", itemId, (err as Error).message),
        );
    };
    const flushTranscript = (): Promise<void> => transcriptChain;

    try {
      // ── PLAN ───────────────────────────────────────────────────────────
      // Open a NEW run: `beginRun` archives the prior run into `runHistory`
      // (never overwriting it) and resets the latest plan/output for a clean
      // slate, so a re-run that later denies/errors can't show a stale green
      // output. Re-running preserves prior runs AND their on-disk transcripts
      // — the user's continuity requirement.
      await store.beginRun(itemId, runId, startedAt);

      emit({ itemId, phase: "planning" });

      const planResult = await runner.spawn(
        {
          title: `Plan: ${item.title}`,
          instructions: buildPlanPrompt(item),
          toolScope: exactToolScope(planTools),
          originSessionId,
          ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
          profileMode: "plan",
          profileModel: profile?.model,
          maxRounds: PLAN_ROUND_BUDGET,
        },
        {
          onActivity: makeTurnRecorder((turn, text) => {
            emit({ itemId, phase: "planning", turn, text });
            record({ phase: "planning", kind: "turn", turn, text });
          }),
          onError: (message) => emit({ itemId, phase: "error", message }),
        },
      );
      const plan = planResult.summary;
      record({ phase: "awaiting_approval", kind: "plan", text: plan });
      await store.setRunResult(itemId, {
        runStatus: "awaiting_approval",
        plan,
        runSessionId: planResult.childSessionId,
      });

      // ── APPROVE ────────────────────────────────────────────────────────
      // `kind: 'agent-action'` + `toolCategory: 'meta'` deliberately skips both
      // the read-only short-circuit and the sandbox-capability injection so the
      // user ALWAYS sees an explicit plan-approval prompt (not auto-approved).
      //
      // The request `id` carries a fresh per-run UUID so no cache key can match
      // across runs, and the returned decision is clamped to allow-once
      // (`clampToOnceForRun`) so a durable "allow always" / "allow session"
      // choice cannot persist a remembered bypass of this plan-approval gate.
      // Together these guarantee every run gets a genuine fresh §8 decision —
      // the plan-approval gate can never be permanently disabled by one click.
      emit({ itemId, phase: "awaiting_approval" });
      const rawDecision = await approvalGate.requestAndWait({
        id: `work-board-run:${itemId}:${randomUUID()}`,
        category: "agent-action",
        kind: "agent-action",
        allowedChoices: ["allow-once", "deny-once"],
        durableApprovalRecordAllowed: false,
        toolName: "work_board_run",
        toolCategory: "meta",
        reason: `Work item #${itemId} "${item.title}" — approve plan to execute?`,
        args: { plan },
        source: "builtin",
        createdAt: Date.now(),
        trustOrigin: "user-keyboard",
      });
      const decision = clampToOnceForRun(rawDecision);

      if (isDenied(decision)) {
        await store.setRunResult(itemId, { runStatus: "denied", plan });
        record({ phase: "denied", kind: "decision", message: decision.choice });
        emit({ itemId, phase: "denied", message: decision.choice });
        await flushTranscript();
        return { status: "denied", plan, reason: decision.choice };
      }

      // ── EXECUTE ────────────────────────────────────────────────────────
      // `PARENT_ALL_TOOL_SCOPE` ⇒ the runner grants the FULL parent registry
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
          toolScope: PARENT_ALL_TOOL_SCOPE,
          originSessionId,
          ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
          profileMode: "execute",
          profileModel: profile?.model,
        },
        {
          onActivity: makeTurnRecorder((turn, text) => {
            emit({ itemId, phase: "executing", turn, text });
            record({ phase: "executing", kind: "turn", turn, text });
          }),
          onError: (message) => emit({ itemId, phase: "error", message }),
        },
      );
      // A sub-agent that could not run (LLM provider unconfigured, child loop
      // threw, aborted) returns `ok: false` with the error text as `summary`.
      // Recording that as `completed` would show a green "done" output on a
      // failed run — so branch on the structural signal and land the item in
      // `error` instead, mirroring the catch path. We never treat the error
      // text as a captured OUTPUT.
      if (execResult.ok === false) {
        const reason = execResult.error ?? execResult.summary;
        log.warn("runItem execute failed (id=%d): %s", itemId, reason);
        await store.setRunResult(itemId, { runStatus: "error" });
        record({ phase: "error", kind: "error", message: reason });
        emit({ itemId, phase: "error", message: reason });
        await flushTranscript();
        return { status: "error", reason };
      }

      const output = execResult.summary;

      await store.setRunResult(itemId, {
        runStatus: "completed",
        plan,
        output,
        runSessionId: execResult.childSessionId,
      });
      record({ phase: "done", kind: "output", text: output });
      emit({
        itemId,
        phase: "done",
        runSessionId: execResult.childSessionId,
      });
      await flushTranscript();
      // Self-improvement: record a one-line learning AFTER the run has already
      // succeeded + persisted. Fire-and-forget with a swallow so a memory
      // append failure can never turn a completed run into an error.
      if (onRunComplete) {
        // `.then(() => hook(...))` so even a SYNCHRONOUS throw from the hook is
        // captured by the promise chain (not just an async rejection) — the
        // swallow guarantee must hold for any hook implementation.
        void Promise.resolve()
          .then(() =>
            onRunComplete({
              itemId,
              title: item.title,
              ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
              ...(item.projectName ? { projectName: item.projectName } : {}),
            }),
          )
          .catch((e) =>
            log.warn("runItem onRunComplete failed (id=%d): %s", itemId, (e as Error).message),
          );
      }
      return {
        status: "completed",
        plan,
        output,
        runSessionId: execResult.childSessionId,
      };
    } catch (err) {
      const reason = errorMessage(err);
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
      record({ phase: "error", kind: "error", message: reason });
      emit({ itemId, phase: "error", message: reason });
      await flushTranscript();
      return { status: "error", reason };
    }
  }

  async function runBriefing(
    kind: WorkBoardBriefingKind,
    opts: BriefingOptions = {},
  ): Promise<WorkBoardBriefingResult> {
    if (briefingInFlight.has(kind)) {
      return { status: "error", kind, reason: `the ${kind} briefing is already running` };
    }
    briefingInFlight.add(kind);
    try {
      const runner = getRunner();
      if (!runner) {
        return { status: "error", kind, reason: "sub-agent runner not available" };
      }
      const surveyTools = planReadOnlyToolNames(runner.parentToolRegistry());
      if (surveyTools.length === 0) {
        return { status: "error", kind, reason: PLAN_TOOLS_EMPTY };
      }

      const listed = await store.list(
        opts.projectRoot
          ? { projectRoot: opts.projectRoot, includeUnscoped: opts.includeUnscoped === true }
          : undefined,
      );
      const openItems =
        listed.status === "ok"
          ? listed.items.filter((item) => item.status_resolved !== "completed")
          : [];

      const survey = await runner.spawn({
        title: `Briefing: ${kind}`,
        instructions: buildBriefingPrompt(kind, openItems),
        // The read-only registry is what makes "make NO changes" a guarantee
        // rather than a request in the prompt — the same derivation the plan
        // phase runs.
        toolScope: exactToolScope(surveyTools),
        originSessionId: `work-board-briefing:${kind}`,
        ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
        profileMode: "plan",
        maxRounds: BRIEFING_ROUND_BUDGET,
      });
      if (survey.ok === false) {
        const reason = survey.error ?? survey.summary;
        log.warn("runBriefing survey failed (kind=%s): %s", kind, reason);
        return { status: "error", kind, reason };
      }

      const parsed = parseBriefingActionItems(kind, survey.summary);
      if (!parsed.ok) {
        log.warn("runBriefing parse failed (kind=%s): %s", kind, parsed.reason);
        return { status: "error", kind, reason: parsed.reason };
      }
      if (parsed.items.length === 0) {
        return { status: "empty", kind, reason: "the survey found nothing that needs attention" };
      }

      const { filed, refreshed } = await store.fileBriefingProposals(parsed.items);
      return { status: "ok", kind, filed, refreshed };
    } catch (err) {
      const reason = errorMessage(err);
      log.warn("runBriefing error (kind=%s): %s", kind, reason);
      return { status: "error", kind, reason };
    } finally {
      briefingInFlight.delete(kind);
    }
  }

  return { runItem, runBriefing };
}
