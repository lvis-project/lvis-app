/**
 * One-shot, idempotent migration of a legacy plugin-owned board into the
 * host-owned `work-board` feature namespace.
 *
 * Before the work-board host domain existed, the board lived under a plugin's
 * own namespace at `~/.lvis/plugins/<pluginId>/data/board.json`. The host now owns
 * this state under `~/.lvis/work-board/board.json` (see {@link WorkBoardStore}
 * and the storage-namespace rule in CLAUDE.md).
 *
 * The host stays plugin-agnostic: rather than hard-coding a specific plugin id
 * (which would couple app runtime to a concrete plugin — see the
 * app-plugin-decoupling audit), this step SCANS `~/.lvis/plugins/&#42;/board.json`
 * (each plugin's `data/board.json`) and adopts the single legacy board it finds. Naming the source by directory
 * discovery, not by literal, keeps the migration generic.
 *
 * Migration policy:
 *   - Runs only when the destination `work-board/board.json` is ABSENT *and*
 *     exactly one legacy `plugins/&#42;/board.json` is PRESENT. The presence of a
 *     destination file is the idempotency marker — once the host board exists
 *     (whether created here, by the first `WorkBoardStore` write, or a prior
 *     migration), this step is a no-op forever.
 *   - When more than one legacy board is found the migration is skipped (the
 *     host cannot disambiguate which plugin owned the canonical board) and the
 *     ambiguity is logged.
 *   - The legacy file is COPIED (not moved) so there is zero data loss: a
 *     failed/aborted boot can re-attempt, and the plugin's own copy is left
 *     untouched for forensic comparison.
 *   - Any failure is non-fatal — it logs and returns so boot continues. The
 *     host store falls back to an empty board, never a broken one.
 *
 * The destination write goes through {@link openFeatureNamespace} so the
 * `0o700` dir / `0o600` file / atomic tmpfile+rename contract is enforced by
 * the storage SOT helper — this step never hand-rolls `fs` writes.
 */
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { lvisHome } from "../../shared/lvis-home.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("lvis");

const BOARD_FILE = "board.json";

/**
 * Minimal structural check that a parsed legacy value is actually a board: a
 * non-null object carrying an `items` array. Rejects parseable-but-wrong-shape
 * JSON (`[]`, `"x"`, `42`, `null`, `{ items: "x" }`) so it is never adopted as
 * the host board — the store would otherwise back it up and seed empty on the
 * next read, masking the bad migration behind a "success" log line.
 */
function isBoardShape(value: unknown): value is { items: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

/**
 * Discover every `~/.lvis/plugins/<id>/data/board.json` that exists on disk.
 * Returns absolute paths. A missing plugins root yields an empty list (nothing
 * to migrate). Probes each candidate with a read rather than a stat→read pair
 * so there is no TOCTOU window.
 */
async function findLegacyPluginBoards(pluginsRoot: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(pluginsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Plugins persist via the host PluginStorage API, which resolves to the
    // plugin's `data/` subdir — so the legacy board lives at
    // `plugins/<id>/data/board.json`, not at the plugin-dir root.
    const candidate = join(pluginsRoot, entry.name, "data", BOARD_FILE);
    try {
      await readFile(candidate, "utf-8");
      found.push(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // No board.json in this plugin dir — skip.
    }
  }
  return found.sort();
}

/**
 * Migrate a legacy plugin board into the work-board namespace exactly once.
 * Idempotent and non-fatal. Returns `true` when a migration copy was performed
 * this call, `false` otherwise (already migrated, no/ambiguous legacy board,
 * or an error swallowed for boot continuity).
 */
export async function migrateAgentHubBoardToWorkBoard(): Promise<boolean> {
  const ns = openFeatureNamespace("work-board");
  const destPath = join(ns.dir, BOARD_FILE);
  const pluginsRoot = join(lvisHome(), "plugins");

  try {
    // Idempotency guard — if the host board already exists we never touch it.
    // try-read instead of existsSync to avoid a TOCTOU stat→read race.
    try {
      await readFile(destPath, "utf-8");
      // Destination present → already migrated (or host already wrote one).
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // ENOENT — destination absent, proceed to scan for a legacy source.
    }

    const legacyBoards = await findLegacyPluginBoards(pluginsRoot);
    if (legacyBoards.length === 0) {
      // No legacy plugin board to migrate — nothing to do.
      return false;
    }
    if (legacyBoards.length > 1) {
      log.warn(
        "boot: work-board migration skipped — multiple legacy plugin boards found (%s); cannot disambiguate the canonical source",
        legacyBoards.join(", "),
      );
      return false;
    }

    const legacyPath = legacyBoards[0];
    const legacyRaw = await readFile(legacyPath, "utf-8");

    // Parse to validate it is well-formed JSON before adopting it as the host
    // board. A corrupt legacy file is treated as "nothing to migrate" rather
    // than copied verbatim (the host store would otherwise back it up + reset
    // on first read). Re-serialized through writeJson so the destination is
    // written with the namespace permission + atomic-write contract.
    let parsed: unknown;
    try {
      parsed = JSON.parse(legacyRaw);
    } catch {
      log.warn(
        "boot: work-board migration skipped — legacy plugin board.json (%s) is not valid JSON",
        legacyPath,
      );
      return false;
    }

    // Shape-validate before adopting. Parseable-but-wrong-shape values
    // (`[]`, `"x"`, `42`, `{ items: "x" }`) would otherwise be written
    // verbatim and then silently seed an empty board on the store's next
    // read while this step logged success. A board is an object with an
    // `items` array; anything else is treated as "nothing to migrate".
    if (
      !isBoardShape(parsed)
    ) {
      log.warn(
        "boot: work-board migration skipped — legacy plugin board.json (%s) is not a board (expected an object with an items array)",
        legacyPath,
      );
      return false;
    }

    await ns.writeJson(BOARD_FILE, parsed);
    log.info(
      "boot: migrated legacy plugin board → work-board namespace (%s → %s)",
      legacyPath,
      destPath,
    );
    return true;
  } catch (err) {
    log.warn(
      "boot: work-board migration failed (non-fatal): %s",
      (err as Error).message,
    );
    return false;
  }
}
