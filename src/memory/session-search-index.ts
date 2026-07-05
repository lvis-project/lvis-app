/**
 * SQLite FTS5 cross-session search index (#1500 / E3).
 *
 * Replaces the JSONL linear-scan `MemoryManager.searchSessions()` used to run
 * (50-file cap, one match per session, whole-file reads on every keystroke).
 * `better-sqlite3` is already a production `dependencies` entry (postinstall
 * runs `electron-rebuild --only better-sqlite3,node-pty`) — this module is
 * its first runtime consumer, so the native module load path is exercised by
 * the packaged-app smoke test (see `scripts/smoke-packaged-app.mjs`).
 *
 * Storage: `<lvisDir>/search/index.db` — resolved from the *same* `lvisDir`
 * the owning `MemoryManager` instance uses (never a global singleton), so
 * the main / side-chat / sub-agent `MemoryManager` instances each get their
 * own isolated index, mirroring how `sessionsDir` is derived. Directory is
 * created 0o700; the DB file is chmod'd 0o600 after `better-sqlite3` opens
 * it (the project's `openFeatureNamespace` atomic-write helpers don't apply
 * to a database file that better-sqlite3 manages itself — POSIX-only, a
 * no-op on win32 like every other mode-bit call in this codebase).
 *
 * Schema: one FTS5 row PER SESSION (not per message) — this preserves the
 * pre-existing "one match per session" search semantics. `content` is the
 * concatenation of every message's searchable text; excerpting for the
 * `matchedMessage` field uses FTS5's `snippet()`.
 *
 * No-Fallback: query()/upsertSession() failures never fall back to a linear
 * scan. Corruption or a missing DB is only ever repaired by `rebuild()` —
 * `MemoryManager.verifyOrRebuildSearchIndex()` is the sole boot-time caller.
 */
import { promises as fsPromises, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createLogger } from "../lib/logger.js";
import type { SessionKind } from "./memory-manager.js";
import type BetterSqlite3 from "better-sqlite3";

const log = createLogger("session-search-index");

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Lazy, cached SYNCHRONOUS load of the native (asarUnpack'd) better-sqlite3
 * addon via `createRequire`. Kept lazy — only invoked from `open()` — so
 * merely importing this module pulls no native addon into contexts that
 * never search (renderer type-checking, most tests); this preserves the same
 * "load on first use" property the old dynamic `import()` had. It is
 * synchronous (better-sqlite3 is a CJS native addon) so `open()` can stay
 * synchronous, which lets the sync read path (`searchSessions`) open the
 * index on demand without forcing every caller onto an async signature.
 */
let _sqliteCtor: typeof BetterSqlite3 | null = null;
function loadSqlite(): typeof BetterSqlite3 {
  if (_sqliteCtor) return _sqliteCtor;
  const require = createRequire(import.meta.url);
  _sqliteCtor = require("better-sqlite3") as typeof BetterSqlite3;
  return _sqliteCtor;
}

export interface IndexedSessionInput {
  sessionId: string;
  content: string;
  timestamp: string;
  sessionKind: SessionKind;
  routineId?: string;
  projectRoot?: string;
  title?: string;
}

export interface SessionSearchIndexQueryOptions {
  kind?: SessionKind | "all";
  routineId?: string;
  projectRoot?: string;
  includeUnscoped?: boolean;
  limit?: number;
}

export interface SessionSearchIndexHit {
  sessionId: string;
  title?: string;
  matchedMessage: string;
  timestamp: string;
  sessionKind: SessionKind;
}

const DEFAULT_LIMIT = 50;
/** FTS5 snippet context size in tokens (approximates the old ±100 char excerpt). */
const SNIPPET_TOKENS = 20;

/**
 * Escapes a raw user query into an FTS5 phrase (`"..."`) so operators like
 * `AND`/`OR`/`NOT`/`NEAR`/`*`/`-` are never parsed as FTS5 syntax — the
 * entire input is always matched as a literal token sequence. Internal
 * double-quotes are doubled per FTS5's own escaping rule.
 */
export function escapeFtsQuery(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

function ensureDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    /* best effort — pre-existing dir may already be 0o755 on some hosts */
  }
}

/**
 * Thin wrapper around a single `sessions_fts` SQLite FTS5 virtual table.
 * One instance per owning `MemoryManager` (keyed by that manager's
 * `lvisDir`), never shared globally.
 */
export class SessionSearchIndex {
  private readonly dbPath: string;
  private readonly dir: string;
  private db: BetterSqlite3.Database | null = null;

  constructor(lvisDir: string) {
    this.dir = join(lvisDir, "search");
    this.dbPath = join(this.dir, "index.db");
  }

  /** Absolute path to the backing `index.db` file (test/diagnostic use). */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Opens (creating if absent) the database and ensures the `sessions_fts`
   * table exists. Synchronous — the native addon loads via `createRequire`
   * (see {@link loadSqlite}) — so the sync `searchSessions` read path and the
   * write path can both open on demand. Directory is created 0o700; the file
   * is chmod'd 0o600 after open (best-effort — POSIX only, matches
   * feature-namespace.ts). Returns `false` when the native module or the file
   * itself is unavailable/corrupt — callers must NOT fall back to a scan; the
   * boot integrity check is the only recovery path.
   */
  open(): boolean {
    if (this.db) return true;
    // Hoisted so the catch can close a handle that opened but then threw on a
    // later PRAGMA/CREATE (better-sqlite3 opens a junk file lazily and only
    // throws "file is not a database" on first use). Leaving it open would
    // leak the handle AND — on Windows — block the corruption-recovery
    // `deleteFile`/`rmSync` with EPERM, defeating the rebuild path.
    let db: BetterSqlite3.Database | null = null;
    try {
      ensureDirSync(this.dir);
      const Database = loadSqlite();
      db = new Database(this.dbPath);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(
        // tokenize='trigram' (not the fts5 default 'unicode61') — the old
        // linear-scan search did a raw `indexOf` substring match with no
        // notion of word boundaries. unicode61 is whole-TOKEN matching, so a
        // literal-phrase MATCH can never find a substring inside a longer
        // unbroken run (e.g. a URL, a code identifier, or a CJK compound) —
        // a real regression relative to the old behavior, not an edge case.
        // Trigram restores substring semantics on the SAME FTS5 engine (no
        // second index, no LIKE-based fallback — see the No-Fallback note
        // above). Case-insensitive by default, matching the old
        // `toLowerCase()` comparison. Trade-off: queries under 3 unicode
        // characters never match any row (SQLite FTS5 trigram floor).
        `CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
          sessionId UNINDEXED,
          content,
          timestamp UNINDEXED,
          sessionKind UNINDEXED,
          routineId UNINDEXED,
          projectRoot UNINDEXED,
          title UNINDEXED,
          tokenize='trigram'
        );`,
      );
      this.db = db;
      try {
        chmodSync(this.dbPath, FILE_MODE);
      } catch {
        /* best effort — Windows ignores mode bits; pre-existing file may already be correct */
      }
      return true;
    } catch (err) {
      log.warn("open failed: %s", (err as Error).message);
      // Close the partially-opened handle so it does not leak / block deletion.
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      this.db = null;
      return false;
    }
  }

  /** Number of rows currently in the FTS table, or -1 if not open. */
  rowCount(): number {
    if (!this.db) return -1;
    try {
      const row = this.db.prepare("SELECT COUNT(*) as c FROM sessions_fts").all()[0] as
        | { c: number }
        | undefined;
      return row?.c ?? 0;
    } catch {
      return -1;
    }
  }

  /**
   * Upserts one session's row (delete-then-insert — sessions are rewritten
   * wholesale on every save, so there is no incremental-append case to
   * optimize for). Swallowed on failure: search-index maintenance must never
   * block session persistence, which remains the source of truth.
   */
  upsertSession(input: IndexedSessionInput): void {
    if (!this.db) return;
    try {
      this.db.prepare("DELETE FROM sessions_fts WHERE sessionId = ?").run(input.sessionId);
      this.db
        .prepare(
          `INSERT INTO sessions_fts (sessionId, content, timestamp, sessionKind, routineId, projectRoot, title)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionId,
          input.content,
          input.timestamp,
          input.sessionKind,
          input.routineId ?? "",
          input.projectRoot ?? "",
          input.title ?? "",
        );
    } catch (err) {
      log.warn("upsertSession failed for %s: %s", input.sessionId, (err as Error).message);
    }
  }

  /** Removes a session's row (extension point — no active caller yet). */
  deleteSession(sessionId: string): void {
    if (!this.db) return;
    try {
      this.db.prepare("DELETE FROM sessions_fts WHERE sessionId = ?").run(sessionId);
    } catch (err) {
      log.warn("deleteSession failed for %s: %s", sessionId, (err as Error).message);
    }
  }

  /** Drops and recreates the FTS table (used by `MemoryManager` rebuild). */
  clear(): void {
    if (!this.db) return;
    try {
      this.db.exec("DELETE FROM sessions_fts;");
    } catch (err) {
      log.warn("clear failed: %s", (err as Error).message);
    }
  }

  /**
   * Runs a MATCH query against the FTS table. `rawQuery` is escaped into a
   * literal FTS5 phrase (see {@link escapeFtsQuery}) so user input can never
   * be interpreted as FTS operators. Scope filters (`kind`/`routineId`/
   * `projectRoot`) are applied as SQL WHERE clauses over the UNINDEXED
   * columns. Returns `[]` (never throws, never scans) on any failure.
   */
  query(rawQuery: string, options: SessionSearchIndexQueryOptions = {}): SessionSearchIndexHit[] {
    if (!this.db) return [];
    try {
      const kind = options.kind ?? "main";
      const limit = options.limit ?? DEFAULT_LIMIT;
      const clauses = ["sessions_fts MATCH ?"];
      const params: unknown[] = [escapeFtsQuery(rawQuery)];
      if (kind !== "all") {
        clauses.push("sessionKind = ?");
        params.push(kind);
      }
      if (options.routineId !== undefined) {
        clauses.push("routineId = ?");
        params.push(options.routineId);
      }
      if (options.projectRoot !== undefined) {
        if (options.includeUnscoped === true) {
          clauses.push("(projectRoot = ? OR projectRoot = ?)");
          params.push(options.projectRoot, "");
        } else {
          clauses.push("projectRoot = ?");
          params.push(options.projectRoot);
        }
      }
      const sql = `
        SELECT sessionId, title, timestamp, sessionKind,
               snippet(sessions_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) as matchedMessage
        FROM sessions_fts
        WHERE ${clauses.join(" AND ")}
        LIMIT ?
      `;
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as Array<{
        sessionId: string;
        title: string;
        timestamp: string;
        sessionKind: SessionKind;
        matchedMessage: string;
      }>;
      return rows.map((row) => ({
        sessionId: row.sessionId,
        ...(row.title ? { title: row.title } : {}),
        matchedMessage: row.matchedMessage,
        timestamp: row.timestamp,
        sessionKind: row.sessionKind,
      }));
    } catch (err) {
      log.warn("query failed: %s", (err as Error).message);
      return [];
    }
  }

  /** Closes the underlying database handle (test cleanup / process shutdown). */
  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      /* ignore close races */
    }
    this.db = null;
  }

  /**
   * Deletes the on-disk database file entirely (used when `open()`
   * indicates corruption so the next `open()` starts from a clean file).
   */
  static async deleteFile(dbPath: string): Promise<void> {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await fsPromises.unlink(`${dbPath}${suffix}`);
      } catch {
        /* missing file is fine */
      }
    }
  }
}
