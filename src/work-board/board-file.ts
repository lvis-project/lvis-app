/**
 * The `board.json` file: its on-disk shape, its schema version, and the
 * read-time projection applied to every item loaded from it.
 *
 * Pure and side-effect-free — the CRUD implementation that reads and writes
 * the file lives in `src/main/work-board-store.ts`. Keeping the shape and the
 * projection rule here (rather than re-deriving them per consumer) means
 * `status_resolved` has exactly one definition.
 *
 * `status_resolved` (the `overdue` projection) is computed on every read so
 * consumers never re-derive it: an item is `overdue` when its stored status is
 * `planned` or `in_progress` AND its `due_at` is strictly in the past. It is a
 * read-time projection only — `overdue` is never persisted.
 */
import { createHash } from "node:crypto";
import type {
  WorkItem,
  WorkItemCreateInput,
  WorkItemPriority,
  WorkItemStatusResolved,
  WorkProposal,
  WorkProposalBlocker,
  WorkProposalEvidence,
  WorkProposalInput,
  WorkProposalUntrustedText,
} from "../shared/work-board-types.js";
import {
  MAX_PROPOSAL_BLOCKERS,
  MAX_PROPOSAL_EVIDENCE,
  PROPOSAL_KEY_MAX,
  PROPOSAL_KIND_PATTERN,
  PROPOSAL_LINE_MAX,
  PROPOSAL_STATE_MAX,
  PROPOSAL_SUMMARY_MAX,
  PROPOSAL_TASK_BRIEF_MAX,
  PROPOSAL_TITLE_MAX,
  PROPOSAL_TTL_DEFAULT_MS,
  PROPOSAL_TTL_MAX_MS,
  PROPOSAL_TTL_MIN_MS,
} from "../shared/work-board-types.js";
import { localDayStart, utcDateKey } from "../shared/local-date.js";

/** On-disk shape of `board.json`. */
export interface BoardFile {
  version: number;
  nextId: number;
  items: WorkItem[];
}

/** Current `board.json` schema version. */
export const BOARD_VERSION = 1;

/**
 * Compute the resolved status for a single item against a reference instant.
 * `overdue` applies only to not-yet-completed items with a past `due_at`.
 */
export function resolveWorkItemStatus(
  item: WorkItem,
  nowMs: number,
): WorkItemStatusResolved {
  if (
    (item.status === "planned" || item.status === "in_progress") &&
    item.due_at !== undefined &&
    Date.parse(item.due_at) < nowMs
  ) {
    return "overdue";
  }
  return item.status;
}

/** `Z` or `±HH:MM` at the end of an ISO instant, in minutes. `null` if absent. */
function explicitOffsetMinutes(iso: string): number | null {
  const match = /(?:(Z)|([+-])(\d{2}):(\d{2}))$/.exec(iso);
  if (!match) return null;
  if (match[1]) return 0;
  const magnitude = Number(match[3]) * 60 + Number(match[4]);
  return match[2] === "-" ? -magnitude : magnitude;
}

/**
 * Re-anchor a due date that was stamped as midnight in some other zone.
 *
 * Until the board moved to the host calendar, the panel wrote a picked day as
 * `${day}T00:00:00+09:00` — midnight in Seoul. That is an absolute instant, so
 * its meaning did not change, but the day it now DISPLAYS under is the host's
 * day for that instant: on any host west of Seoul, an item the user set for the
 * 16th reads as the 15th. The user picked a day, not a moment, so the day is
 * what has to survive.
 *
 * Only a value that is unambiguously "midnight somewhere else" is touched:
 *
 *   - it must carry an explicit offset (no offset means we cannot tell what the
 *     writer meant, so we leave it alone);
 *   - that offset must not be `Z`, which is this code's own output rather than
 *     the legacy stamp;
 *   - that offset must differ from the host's offset at that instant (otherwise
 *     it is already host-local midnight, or a value we have already converted);
 *   - and its time of day IN ITS OWN OFFSET must be exactly 00:00:00.000.
 *
 * A due date with a real time on it was never a day-picker value and keeps its
 * instant exactly.
 *
 * Idempotent, and stable across hosts rather than merely across repeat loads on
 * one host: what it writes back is serialized with a `Z`, which the second rule
 * above excludes from ever being touched again — by this host or any other.
 */
export function normalizeDueAt(dueAt: string): string {
  const offsetMinutes = explicitOffsetMinutes(dueAt);
  if (offsetMinutes === null) return dueAt;
  // `Z` is what THIS code writes (`localDayStart(day).toISOString()`), never the
  // legacy `+09:00` stamp — so a `Z` value is already anchored to the day its
  // author picked and has nothing to migrate. Re-anchoring it would make the
  // value follow whichever host opened the board last: written on a UTC host as
  // the 16th, re-stamped by a Seoul host, it reads as the 15th back on the
  // original host. A one-time fix-up of historical data must not become a
  // rewrite that ping-pongs between machines.
  if (offsetMinutes === 0) return dueAt;

  const instant = new Date(dueAt);
  if (Number.isNaN(instant.getTime())) return dueAt;

  if (offsetMinutes === -instant.getTimezoneOffset()) return dueAt;

  // Read the wall clock the writer saw, by shifting into their offset and using
  // the UTC getters as a plain calendar reader.
  const asWritten = new Date(instant.getTime() + offsetMinutes * 60_000);
  const isMidnightThere =
    asWritten.getUTCHours() === 0
    && asWritten.getUTCMinutes() === 0
    && asWritten.getUTCSeconds() === 0
    && asWritten.getUTCMilliseconds() === 0;
  if (!isMidnightThere) return dueAt;

  const pickedDay = utcDateKey(asWritten);
  return localDayStart(pickedDay)?.toISOString() ?? dueAt;
}

/**
 * Apply {@link normalizeDueAt} across a board, reporting whether anything moved
 * so the caller can say so once instead of per item.
 */
export function normalizeBoardDueDates(
  items: readonly WorkItem[],
): { items: WorkItem[]; changed: number } {
  let changed = 0;
  const next = items.map((item) => {
    if (item.due_at === undefined) return item;
    const due_at = normalizeDueAt(item.due_at);
    if (due_at === item.due_at) return item;
    changed += 1;
    return { ...item, due_at };
  });
  return { items: next, changed };
}

// ── `proposals.json` — the recommended-work file ─────────────────────────────
//
// Proposals sit BESIDE `board.json` in the same `~/.lvis/work-board/` feature
// directory rather than inside it. They are machine-authored and
// author-revocable; work items are user-owned and never silently deleted. One
// file per ownership model keeps the plugin write path off the rows the user
// owns, and keeps machine rows out of the user's MAX_ITEMS budget.

/** File name of the proposals file, relative to the work-board feature dir. */
export const PROPOSALS_FILE = "proposals.json";

/** On-disk shape of `proposals.json`. */
export interface ProposalsFile {
  version: number;
  proposals: WorkProposal[];
}

/** Current `proposals.json` schema version. */
export const PROPOSALS_VERSION = 1;

/**
 * The host-derived proposal id: `<pluginId>:<kind>:<sha256(key)[0..15]>`.
 *
 * The key is hashed rather than embedded so an arbitrary plugin-authored
 * string never becomes part of an identifier the host compares, logs, or puts
 * in a DOM attribute. The `pluginId` prefix is what makes one plugin's
 * proposals unreachable from another — the same prefix-scoping
 * `hasRoutineBySource` uses.
 */
export function proposalId(pluginId: string, kind: string, key: string): string {
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return `${pluginId}:${kind}:${digest.slice(0, 16)}`;
}

/**
 * Is this proposal still showable at `nowMs`? A dismissed or expired proposal
 * stays on disk (dismissal is sticky per id, and a re-post must not resurrect
 * a card the user closed) but never renders.
 */
export function isLiveProposal(proposal: WorkProposal, nowMs: number): boolean {
  if (proposal.dismissedAt !== undefined) return false;
  if (proposal.acceptedItemId !== undefined) return false;
  const expiry = Date.parse(proposal.expiresAt);
  return Number.isNaN(expiry) ? false : expiry > nowMs;
}

/** Trim a plugin-authored string to its cap. Returns null when unusable. */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/**
 * Outcome of {@link normalizeProposalInput}: either the normalized untrusted
 * envelope plus its scheduling fields, or the NAME OF THE FIELD that failed.
 *
 * A rejected proposal is refused with that field name — never coerced into a
 * default. A default here would be the host inventing text and attributing it
 * to a plugin, and the user reading it as the plugin's claim.
 */
export type NormalizedProposal =
  | {
      ok: true;
      text: WorkProposalUntrustedText;
      priority: WorkItemPriority;
      dueAt?: string;
      ttlMs: number;
    }
  | { ok: false; field: string };

const VALID_PROPOSAL_PRIORITIES: readonly WorkItemPriority[] = ["high", "medium", "low"];

/**
 * Validate and bound one `proposeWork` payload.
 *
 * Pure: it decides nothing about authorization or slots, so the store and its
 * tests share exactly this definition of "a well-formed proposal".
 */
export function normalizeProposalInput(input: WorkProposalInput): NormalizedProposal {
  if (typeof input?.kind !== "string" || !PROPOSAL_KIND_PATTERN.test(input.kind)) {
    return { ok: false, field: "kind" };
  }
  const key = boundedText(input.key, PROPOSAL_KEY_MAX);
  if (key === null || key.length !== (input.key as string).trim().length) {
    return { ok: false, field: "key" };
  }
  const title = boundedText(input.title, PROPOSAL_TITLE_MAX);
  if (title === null) return { ok: false, field: "title" };
  const summary = boundedText(input.summary, PROPOSAL_SUMMARY_MAX);
  if (summary === null) return { ok: false, field: "summary" };
  const state = boundedText(input.state, PROPOSAL_STATE_MAX);
  if (state === null) return { ok: false, field: "state" };
  const taskBrief = boundedText(input.taskBrief, PROPOSAL_TASK_BRIEF_MAX);
  if (taskBrief === null) return { ok: false, field: "taskBrief" };

  const rawEvidence = input.evidence ?? [];
  if (!Array.isArray(rawEvidence) || rawEvidence.length > MAX_PROPOSAL_EVIDENCE) {
    return { ok: false, field: "evidence" };
  }
  const evidence: WorkProposalEvidence[] = [];
  for (const row of rawEvidence) {
    const label = boundedText(row?.label, PROPOSAL_LINE_MAX);
    const detail = boundedText(row?.detail, PROPOSAL_LINE_MAX);
    if (label === null || detail === null) return { ok: false, field: "evidence" };
    evidence.push({ label, detail });
  }

  const rawBlockers = input.blockers ?? [];
  if (!Array.isArray(rawBlockers) || rawBlockers.length > MAX_PROPOSAL_BLOCKERS) {
    return { ok: false, field: "blockers" };
  }
  const blockers: WorkProposalBlocker[] = [];
  for (const row of rawBlockers) {
    const reason = boundedText(row?.reason, PROPOSAL_LINE_MAX);
    if (reason === null) return { ok: false, field: "blockers" };
    const resolution = row?.resolution === undefined
      ? undefined
      : boundedText(row.resolution, PROPOSAL_LINE_MAX);
    if (row?.resolution !== undefined && resolution === null) {
      return { ok: false, field: "blockers" };
    }
    blockers.push({ reason, ...(resolution ? { resolution } : {}) });
  }

  if (input.priority !== undefined && !VALID_PROPOSAL_PRIORITIES.includes(input.priority)) {
    return { ok: false, field: "priority" };
  }
  let dueAt: string | undefined;
  if (input.dueAt !== undefined) {
    if (typeof input.dueAt !== "string" || Number.isNaN(Date.parse(input.dueAt))) {
      return { ok: false, field: "dueAt" };
    }
    dueAt = normalizeDueAt(input.dueAt);
  }
  if (input.ttlMs !== undefined && (typeof input.ttlMs !== "number" || !Number.isFinite(input.ttlMs))) {
    return { ok: false, field: "ttlMs" };
  }
  const ttlMs = input.ttlMs === undefined
    ? PROPOSAL_TTL_DEFAULT_MS
    : Math.min(PROPOSAL_TTL_MAX_MS, Math.max(PROPOSAL_TTL_MIN_MS, input.ttlMs));

  return {
    ok: true,
    text: { title, summary, state, evidence, blockers, taskBrief },
    priority: input.priority ?? "medium",
    ...(dueAt !== undefined ? { dueAt } : {}),
    ttlMs,
  };
}

/**
 * Compose the work item a proposal becomes when the user accepts it.
 *
 * The HOST writes the detail — `state`, then the evidence rows, then the
 * blockers — so the shape of an accepted item does not depend on how each
 * plugin happened to lay its text out. `taskBrief` is deliberately NOT part of
 * the detail: it is instruction text for the run, not something to render.
 */
export function proposalToWorkItemInput(
  proposal: WorkProposal,
  project?: { projectRoot?: string; projectName?: string },
): WorkItemCreateInput {
  const sections: string[] = [proposal.summary, "", proposal.state];
  if (proposal.evidence.length > 0) {
    sections.push("", ...proposal.evidence.map((e) => `- ${e.label}: ${e.detail}`));
  }
  if (proposal.blockers.length > 0) {
    sections.push(
      "",
      ...proposal.blockers.map((b) =>
        b.resolution ? `- ${b.reason} → ${b.resolution}` : `- ${b.reason}`,
      ),
    );
  }
  return {
    title: proposal.title,
    detail: sections.join("\n"),
    priority: proposal.priority,
    ...(proposal.dueAt !== undefined ? { due_at: proposal.dueAt } : {}),
    ...(project?.projectRoot ? { projectRoot: project.projectRoot } : {}),
    ...(project?.projectName ? { projectName: project.projectName } : {}),
  };
}
