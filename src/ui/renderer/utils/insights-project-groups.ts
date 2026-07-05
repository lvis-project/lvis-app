import type { SessionSummary } from "../hooks/use-sessions.js";

/**
 * Pure aggregation for the Insights "프로젝트별 대화" (conversations-by-project)
 * panel. Extracted from StarredView so the group-by join can be unit-tested
 * without rendering the view.
 *
 * A session is grouped by its project label — `projectName` when present, else
 * the basename of `projectRoot`. Sessions that carry neither fall through to the
 * caller-supplied `fallbackLabel` (e.g. "프로젝트 없음"). The regression this
 * guards (2026-07): new main sessions under the default/base-directory project
 * were not persisting their project identity, so every conversation collapsed
 * into the fallback bucket even though an active project existed.
 */

export interface ProjectSessionGroup {
  name: string;
  sessions: SessionSummary[];
}

export function pathBasename(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  if (!cleaned) return undefined;
  const parts = cleaned.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? cleaned;
}

/**
 * Resolve the project label for a single session. `projectName` wins; a bare
 * `projectRoot` falls back to its basename. Returns `undefined` only when the
 * session has neither — the caller substitutes its localized fallback.
 */
export function projectLabelForSession(session: SessionSummary): string | undefined {
  return session.projectName?.trim() || pathBasename(session.projectRoot);
}

/**
 * Group the given sessions by project label, most-recent session first within
 * each group. Insertion order of groups follows first-seen order across the
 * recency-sorted session list, so the group holding the newest conversation
 * appears first. Sessions missing a project identity are bucketed under
 * `fallbackLabel`.
 */
export function groupSessionsByProject(
  sessions: readonly SessionSummary[],
  fallbackLabel: string,
): ProjectSessionGroup[] {
  const groups = new Map<string, SessionSummary[]>();
  const sorted = [...sessions].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  for (const session of sorted) {
    const label = projectLabelForSession(session) ?? fallbackLabel;
    const list = groups.get(label) ?? [];
    list.push(session);
    groups.set(label, list);
  }
  return Array.from(groups.entries()).map(([name, groupedSessions]) => ({
    name,
    sessions: groupedSessions,
  }));
}
