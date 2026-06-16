/**
 * Work-board storage seam.
 *
 * The domain modules (work-board-store, activity-log, due-soon, work-memory)
 * were originally written against a plugin's injected `PluginStorage` handle.
 * In the host they persist through the `~/.lvis/work-board/` feature namespace
 * — the single source of truth for the 0o700-dir / 0o600-file / atomic-write
 * contract (see {@link openFeatureNamespace}). This module defines the narrow
 * read/write surface those modules depend on and a namespace-backed
 * implementation, so the domain logic keeps its in-memory-fake testability seam
 * while never hand-rolling `fs`.
 *
 * All relative paths are single- or two-segment names under the feature dir
 * (`board.json`, `activity.jsonl`, `due-soon-notified.json`,
 * `memories/USER.md`). JSON files round-trip through the namespace helper's
 * atomic writer; text/JSONL files round-trip through the same path-level atomic
 * writer so a crash mid-write never leaves a half-written file.
 */
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import {
  openFeatureNamespace,
  writeFileAtomicAtPath,
} from "../main/storage/feature-namespace.js";

/** Feature id owning `~/.lvis/work-board/`. */
export const WORK_BOARD_FEATURE = "work-board";

/**
 * Narrow storage surface the work-board domain modules consume. Each method
 * takes a path relative to the feature directory. JSON helpers seed `null` on
 * an absent file (the contract's "first run" signal — never a corrupt-read
 * fallback); text helpers return `""`. `exists` gates first reads.
 */
export interface WorkBoardStorage {
  readJson<T = unknown>(relPath: string): Promise<T | null>;
  writeJson<T>(relPath: string, value: T, indent?: number): Promise<void>;
  readText(relPath: string): Promise<string>;
  write(relPath: string, data: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  mkdir(relPath: string): Promise<void>;
}

/** Absolute path of `<feature-dir>/<relPath>`. Resolved lazily per call so a
 *  later `LVIS_HOME` override (e2e fixtures) is always honoured. */
function abs(relPath: string): string {
  return join(openFeatureNamespace(WORK_BOARD_FEATURE).dir, relPath);
}

/**
 * Feature-namespace-backed implementation of {@link WorkBoardStorage}. Every
 * write composes the SOT atomic-write contract (0o700 dir, 0o600 file, tmpfile
 * + rename). There is no remote and no fallback path.
 */
export const featureNamespaceStorage: WorkBoardStorage = {
  async readJson<T = unknown>(relPath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(abs(relPath), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      // Absent file → first run. JSON.parse on a present-but-corrupt file is a
      // genuine error, but the upstream domain contract treats "no usable
      // file" uniformly as "absent" (seed empty) — matching the original
      // PluginStorage.readJson behaviour the modules were written against.
      return null;
    }
  },
  async writeJson<T>(relPath: string, value: T, indent = 2): Promise<void> {
    await writeFileAtomicAtPath(abs(relPath), `${JSON.stringify(value, null, indent)}\n`);
  },
  async readText(relPath: string): Promise<string> {
    try {
      return await fs.readFile(abs(relPath), "utf-8");
    } catch {
      return "";
    }
  },
  async write(relPath: string, data: string): Promise<void> {
    await writeFileAtomicAtPath(abs(relPath), data);
  },
  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(abs(relPath));
      return true;
    } catch {
      return false;
    }
  },
  async mkdir(relPath: string): Promise<void> {
    await fs.mkdir(abs(relPath), { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(abs(relPath), 0o700);
    } catch {
      /* pre-existing dir may already be wider on some hosts */
    }
  },
};

/**
 * Build a {@link WorkBoardStorage} rooted at an arbitrary absolute directory.
 * Used by tests to inject a temp dir without touching `~/.lvis`. Still routes
 * every write through {@link writeFileAtomicAtPath} so the 0o700/0o600 contract
 * holds for the injected location too.
 */
export function createDirStorage(rootDir: string): WorkBoardStorage {
  const at = (relPath: string): string => join(rootDir, relPath);
  return {
    async readJson<T = unknown>(relPath: string): Promise<T | null> {
      try {
        return JSON.parse(await fs.readFile(at(relPath), "utf-8")) as T;
      } catch {
        return null;
      }
    },
    async writeJson<T>(relPath: string, value: T, indent = 2): Promise<void> {
      await writeFileAtomicAtPath(at(relPath), `${JSON.stringify(value, null, indent)}\n`);
    },
    async readText(relPath: string): Promise<string> {
      try {
        return await fs.readFile(at(relPath), "utf-8");
      } catch {
        return "";
      }
    },
    async write(relPath: string, data: string): Promise<void> {
      await fs.mkdir(dirname(at(relPath)), { recursive: true, mode: 0o700 });
      await writeFileAtomicAtPath(at(relPath), data);
    },
    async exists(relPath: string): Promise<boolean> {
      try {
        await fs.access(at(relPath));
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(relPath: string): Promise<void> {
      await fs.mkdir(at(relPath), { recursive: true, mode: 0o700 });
    },
  };
}
