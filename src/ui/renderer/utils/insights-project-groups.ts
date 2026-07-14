import type { SessionSummary } from "../hooks/use-sessions.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import { findWorkspaceProject } from "../../../shared/project-identity.js";

/**
 * Pure aggregation for the Insights "프로젝트별 대화" (conversations-by-project)
 * panel. Extracted from StarredView so the group-by join can be unit-tested
 * without rendering the view.
 *
 * A session is grouped by its current registry label when available; legacy
 * callers without a registry fall back to `projectName` or the root basename.
 * Sessions that carry no current named-project identity fall through to the
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
 * Resolve the current project label for a single session. When the project
 * registry is available, its canonical root match is authoritative so stale
 * persisted names cannot bypass duplicate-basename disambiguation. A missing,
 * default, or removed root remains a general conversation.
 */
export function projectLabelForSession(
  session: SessionSummary,
  workspaceProjects?: readonly ProjectIdentity[],
): string | undefined {
  if (workspaceProjects) {
    const currentProject = findWorkspaceProject(workspaceProjects, session.projectRoot);
    return currentProject && !currentProject.isDefault ? currentProject.projectName : undefined;
  }
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
  workspaceProjects?: readonly ProjectIdentity[],
): ProjectSessionGroup[] {
  const groups = new Map<string, SessionSummary[]>();
  const sorted = [...sessions].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  for (const session of sorted) {
    const label = projectLabelForSession(session, workspaceProjects) ?? fallbackLabel;
    const list = groups.get(label) ?? [];
    list.push(session);
    groups.set(label, list);
  }
  return Array.from(groups.entries()).map(([name, groupedSessions]) => ({
    name,
    sessions: groupedSessions,
  }));
}
