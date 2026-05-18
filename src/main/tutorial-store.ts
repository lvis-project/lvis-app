/**
 * Tutorial Preferences store — persists the Discovery Swipe outcome.
 *
 * Storage namespace per feature (project CLAUDE.md): the file lives under
 * `~/.lvis/tutorial/preferences.json` so the tutorial domain owns its
 * own directory rather than scattering a top-level file at `~/.lvis/`.
 *
 *   directory mode: 0o700
 *   file mode:      0o600
 *
 * The store tracks three fields:
 *   - `liked[]`     — scenario ids the user swiped right (preferred)
 *   - `disliked[]`  — scenario ids the user swiped left (rejected)
 *   - `lastShownAt` — ISO timestamp of the last open, used so the renderer
 *                     can decide whether to re-prompt on a new boot. The
 *                     menu trigger always opens the dialog regardless.
 *
 * Error contract: read returns the default on any failure (corrupt JSON,
 * missing file, permission denied). Write throws via `fs.promises.writeFile`
 * — callers handle the rejection.
 */
import { promises as fs, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";

export const TUTORIAL_ACTIONS = ["liked", "disliked", "skipped", "undone"] as const;
export type TutorialAction = (typeof TUTORIAL_ACTIONS)[number];

export interface TutorialPreferences {
  liked: string[];
  disliked: string[];
  lastShownAt: string;
}

export const DEFAULT_TUTORIAL_PREFERENCES: TutorialPreferences = {
  liked: [],
  disliked: [],
  lastShownAt: "",
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTutorialPreferences(value: unknown): value is TutorialPreferences {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isStringArray(candidate.liked) &&
    isStringArray(candidate.disliked) &&
    typeof candidate.lastShownAt === "string"
  );
}

function tutorialDir(): string {
  return join(lvisHome(), "tutorial");
}

function tutorialPath(): string {
  return join(tutorialDir(), "preferences.json");
}

/**
 * Read persisted preferences. Any read/parse error falls back to the
 * default — this is a UX-preference probe, not a security boundary, so
 * a missing/corrupt file should never block the host from booting.
 */
export async function readTutorialPreferences(): Promise<TutorialPreferences> {
  try {
    const raw = await fs.readFile(tutorialPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isTutorialPreferences(parsed)) {
      return {
        liked: [...parsed.liked],
        disliked: [...parsed.disliked],
        lastShownAt: parsed.lastShownAt,
      };
    }
    return { ...DEFAULT_TUTORIAL_PREFERENCES };
  } catch {
    return { ...DEFAULT_TUTORIAL_PREFERENCES };
  }
}

/**
 * Persist preferences to disk. Creates the namespace directory with
 * 0o700 + writes the file with 0o600 to match the Storage Namespace per
 * Feature rule.
 */
export async function writeTutorialPreferences(
  next: TutorialPreferences,
): Promise<void> {
  if (!isTutorialPreferences(next)) {
    throw new Error("invalid-tutorial-preferences");
  }
  const dir = tutorialDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort — pre-existing dir may already be 0o755 on some hosts */
  }
  const path = tutorialPath();
  await fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.chmod(path, 0o600);
  } catch {
    /* file mode may already be correct; ignore */
  }
}

/**
 * Apply a single user action atomically. Re-reads → merges → writes so
 * concurrent IPC calls from multiple windows do not blindly overwrite
 * each other. The merge rules:
 *   - liked:    push if absent in liked; remove from disliked.
 *   - disliked: push if absent in disliked; remove from liked.
 *   - skipped:  no-op for liked/disliked but updates lastShownAt.
 *   - undone:   remove from both liked and disliked.
 */
export async function applyTutorialAction(
  cardId: string,
  action: TutorialAction,
  now: () => string = () => new Date().toISOString(),
): Promise<TutorialPreferences> {
  if (typeof cardId !== "string" || cardId.length === 0) {
    throw new Error("invalid-card-id");
  }
  if (!(TUTORIAL_ACTIONS as readonly string[]).includes(action)) {
    throw new Error("invalid-action");
  }
  const current = await readTutorialPreferences();
  const liked = new Set(current.liked);
  const disliked = new Set(current.disliked);
  if (action === "liked") {
    liked.add(cardId);
    disliked.delete(cardId);
  } else if (action === "disliked") {
    disliked.add(cardId);
    liked.delete(cardId);
  } else if (action === "undone") {
    liked.delete(cardId);
    disliked.delete(cardId);
  }
  const next: TutorialPreferences = {
    liked: Array.from(liked),
    disliked: Array.from(disliked),
    lastShownAt: now(),
  };
  await writeTutorialPreferences(next);
  return next;
}
