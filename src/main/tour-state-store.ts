/**
 * Tour state store — persists which guided tours the user has completed
 * or dismissed.
 *
 * Storage namespace per feature (project CLAUDE.md): the file lives under
 * `~/.lvis/onboarding/tour-state.json` so the onboarding domain owns its
 * own directory rather than scattering top-level files at `~/.lvis/`.
 *
 *   directory mode: 0o700
 *   file mode:      0o600
 *
 * Error contract: read returns the default on any failure (corrupt JSON,
 * missing file, permission denied). Write throws via `fs.promises.writeFile`
 * — callers handle the rejection.
 *
 * The shape is intentionally minimal:
 *   - `lastSeenScenario`: id of the scenario most recently shown to the
 *     user (regardless of completion). Used by Memory Seed / Discovery
 *     Swipe trigger sites to decide whether to auto-launch.
 *   - `completedScenarios`: scenario ids the user finished by clicking
 *     through to the last step. Triggers should NEVER re-launch a
 *     completed scenario unless the caller explicitly forces it.
 *   - `dismissedAt`: ISO timestamp of the last time the user pressed
 *     ESC / clicked "건너뛰기" anywhere. Used as a global cooldown so
 *     subsequent trigger sites don't spam tours immediately after a
 *     dismissal.
 */
import { promises as fs, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";

export interface TourState {
  lastSeenScenario: string | null;
  completedScenarios: string[];
  dismissedAt: string | null;
}

export const DEFAULT_TOUR_STATE: TourState = {
  lastSeenScenario: null,
  completedScenarios: [],
  dismissedAt: null,
};

function tourStateDir(): string {
  return join(lvisHome(), "onboarding");
}

function tourStatePath(): string {
  return join(tourStateDir(), "tour-state.json");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function normaliseState(raw: unknown): TourState {
  if (!raw || typeof raw !== "object") return DEFAULT_TOUR_STATE;
  const candidate = raw as Record<string, unknown>;
  const lastSeenScenario =
    typeof candidate.lastSeenScenario === "string" ? candidate.lastSeenScenario : null;
  const completedScenarios = isStringArray(candidate.completedScenarios)
    ? // De-dupe defensively: a corrupted manual edit shouldn't grow the
      // list every time the renderer marks the same scenario complete.
      Array.from(new Set(candidate.completedScenarios))
    : [];
  const dismissedAt =
    typeof candidate.dismissedAt === "string" ? candidate.dismissedAt : null;
  return { lastSeenScenario, completedScenarios, dismissedAt };
}

/**
 * Read the persisted tour state. Any read/parse error falls back to the
 * default — this is a user-preference store, not a security boundary, so
 * a missing/corrupt file should never block the host from booting.
 */
export async function readTourState(): Promise<TourState> {
  try {
    const raw = await fs.readFile(tourStatePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return normaliseState(parsed);
  } catch {
    return DEFAULT_TOUR_STATE;
  }
}

/**
 * Persist the tour state to disk. Creates the namespace directory with
 * 0o700 + writes the file with 0o600 to match the Storage Namespace per
 * Feature rule.
 */
export async function writeTourState(next: TourState): Promise<void> {
  const dir = tourStateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort — pre-existing dir may already be 0o755 on some hosts */
  }
  const path = tourStatePath();
  const body = `${JSON.stringify(normaliseState(next), null, 2)}\n`;
  await fs.writeFile(path, body, { mode: 0o600 });
  try {
    await fs.chmod(path, 0o600);
  } catch {
    /* file mode may already be correct; ignore */
  }
}

/**
 * Mark `scenarioId` as completed. Idempotent: re-marking a scenario does
 * not duplicate it in `completedScenarios`. Also updates
 * `lastSeenScenario` because completion implies the user saw it.
 */
export async function markScenarioComplete(scenarioId: string): Promise<TourState> {
  if (!scenarioId || typeof scenarioId !== "string") {
    throw new Error("invalid-scenario-id");
  }
  const current = await readTourState();
  const completed = current.completedScenarios.includes(scenarioId)
    ? current.completedScenarios
    : [...current.completedScenarios, scenarioId];
  const next: TourState = {
    lastSeenScenario: scenarioId,
    completedScenarios: completed,
    dismissedAt: current.dismissedAt,
  };
  await writeTourState(next);
  return next;
}

/**
 * Record a dismissal (ESC / 건너뛰기). Updates `lastSeenScenario` and
 * `dismissedAt` but does NOT add the scenario to `completedScenarios`
 * — the user explicitly chose to abandon mid-tour.
 */
export async function dismissScenario(scenarioId: string): Promise<TourState> {
  if (!scenarioId || typeof scenarioId !== "string") {
    throw new Error("invalid-scenario-id");
  }
  const current = await readTourState();
  const next: TourState = {
    lastSeenScenario: scenarioId,
    completedScenarios: current.completedScenarios,
    dismissedAt: new Date().toISOString(),
  };
  await writeTourState(next);
  return next;
}
