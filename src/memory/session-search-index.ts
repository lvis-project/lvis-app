/**
 * SQLite FTS5 cross-session search index (#1500 / E3).
 *
 * Replaces the JSONL linear-scan `MemoryManager.searchSessions()` used to run
 * (50-file cap, one match per session, whole-file reads on every keystroke).
 * `better-sqlite3` is already a production `dependencies` entry (v13 is N-API
 * and ships a per-platform prebuild — `prebuilds/<platform>-<arch>.node` — so
 * no per-Electron-ABI `electron-rebuild` step is needed) — this module is its
 * first runtime consumer, so the native module load path is exercised by the
 * packaged-app smoke test (see `scripts/smoke-packaged-app.mjs`).
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

/** True only under the vitest test runner (VITEST is injected by vitest). */
const IS_TEST_ENV = process.env.VITEST !== undefined;

/**
 * A native-addon load failure (e.g. an ABI/NODE_MODULE_VERSION mismatch — the
 * better-sqlite3 binary compiled for Electron but loaded under node/bun) throws
 * from `require("better-sqlite3")` inside {@link loadSqlite}. In production that
 * is caught by {@link SessionSearchIndex.open} and degraded fail-closed to a
 * `[]`-returning index (No-Fallback: never a linear scan). But in TESTS that
 * same swallow turns a real "the native module can't even load" defect into a
 * whole search suite that silently 0-hits — signal loss that once let an
 * Electron-ABI CI binary pass local review. So we distinguish a *native-load*
 * failure (module never loaded) from a *runtime* failure (a bad file / PRAGMA
 * on an already-loaded module): the former re-throws under VITEST so the suite
 * fails LOUDLY at the binding, while the latter stays swallowed so the
 * corruption-recovery (`deleteFile` → `rebuild`) path is still exercised by its
 * own tests. Heuristic: the addon is considered "loaded" once {@link loadSqlite}
 * has cached the constructor.
 */
function isNativeLoadFailure(err: unknown): boolean {
  if (_sqliteCtor) return false; // constructor already cached ⇒ not a load failure
  const msg = (err as Error)?.message ?? "";
  return (
    /NODE_MODULE_VERSION|was compiled against|different Node\.js|\.node|Cannot find module 'better-sqlite3'|invalid ELF|dlopen|not a valid Win32/i.test(
      msg,
    )
  );
}

export interface IndexedSessionInput {
  sessionId: string;
  content: string;
  /**
   * The session's actual last-modified time (ISO 8601), sourced by the caller
   * from the session JSONL's on-disk mtime — NOT the index-write wall clock.
   * The search UI renders this as the conversation's timestamp, so index-time
   * would wrongly show old sessions as "just now" after a reindex/rebuild.
   */
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
 * SQLite FTS5's trigram tokenizer physically cannot MATCH a query of fewer than
 * 3 Unicode code points (a trigram is 3 code points). This is the floor at
 * which the fast index path stops working. A query of exactly 2 code points —
 * which for a CJK-first product is the single most common query shape (`매출`,
 * `분기`, `회의`) — is served by the LIKE fallback below instead.
 */
const TRIGRAM_MIN_CODEPOINTS = 3;
/** ESCAPE character for the LIKE fallback so a query's own `%`/`_` stay literal. */
const LIKE_ESCAPE = "\\";

/** Counts Unicode CODE POINTS (not UTF-16 units) — a Korean syllable is 1. */
export function codePointLength(s: string): number {
  return [...s].length;
}

/**
 * Escapes a raw user query into an FTS5 phrase (`"..."`) so operators like
 * `AND`/`OR`/`NOT`/`NEAR`/`*`/`-` are never parsed as FTS5 syntax — the
 * entire input is always matched as a literal token sequence. Internal
 * double-quotes are doubled per FTS5's own escaping rule.
 */
export function escapeFtsQuery(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

/** ± context chars for the LIKE-branch excerpt (mirrors the old ±100 scan window). */
const LIKE_EXCERPT_RADIUS = 100;

/**
 * Builds a ±{@link LIKE_EXCERPT_RADIUS}-char excerpt of `content` centred on the
 * first case-insensitive occurrence of `needle` (LIKE branch — `snippet()` is
 * MATCH-only so it can't be used here). Mirrors the old linear-scan excerpt.
 * Falls back to a head slice when the needle isn't located (shouldn't happen —
 * the row already matched the LIKE — but keeps the return bounded).
 */
export function excerptAroundMatch(content: string, needle: string): string {
  const idx = content.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return content.slice(0, LIKE_EXCERPT_RADIUS * 2);
  const start = Math.max(0, idx - LIKE_EXCERPT_RADIUS);
  const end = Math.min(content.length, idx + needle.length + LIKE_EXCERPT_RADIUS);
  const core = content.slice(start, end);
  return `${start > 0 ? "…" : ""}${core}${end < content.length ? "…" : ""}`;
}

/**
 * Escapes a raw query into the RHS of a `content LIKE ? ESCAPE '\\'` predicate.
 * The three LIKE metacharacters (`%`, `_`, and the escape char itself) are
 * prefixed with the ESCAPE char so a query containing them matches them
 * literally (e.g. searching for the literal string `50%` must not wildcard).
 * The caller wraps the result in `%…%` for a substring match.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE}${ch}`);
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
        // second index). Case-insensitive by default, matching the old
        // `toLowerCase()` comparison. Trade-off: the trigram tokenizer
        // cannot serve queries under 3 unicode codepoints, so 2-codepoint
        // queries (common 2-syllable Korean nouns) are served by the bound
        // LIKE branch in `query()` against this same table; only queries
        // under 2 codepoints never match. See the `query()` JSDoc.
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
      } catch (chmodErr) {
        // Stays best-effort/non-fatal (Windows ignores mode bits; a pre-existing
        // file may already be correct) — but on POSIX a real chmod failure means
        // the DB file may be world-readable, so emit a debug signal instead of
        // fully swallowing it. Not a warn: this is not itself a functional break.
        if (process.platform !== "win32") {
          log.debug(
            "chmod 0o600 on index.db failed (file may be world-readable): %s",
            (chmodErr as Error).message,
          );
        }
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
      // Test-env hardening: a native-addon LOAD failure (ABI mismatch, missing
      // binary) must NOT be swallowed under vitest — that is exactly the silent
      // 0-hit signal loss an Electron-ABI CI binary once caused. Re-throw so the
      // suite fails at the binding instead of every query returning []. Runtime
      // failures (corrupt file / bad PRAGMA on a loaded module) stay swallowed so
      // the deleteFile→rebuild recovery path is still testable.
      if (IS_TEST_ENV && isNativeLoadFailure(err)) {
        throw new Error(
          `better-sqlite3 native load failed (corrupt prebuild?) — search index cannot open. ` +
            `In CI this usually means the shipped N-API prebuild is missing or corrupt for this platform+arch. ` +
            `Original: ${(err as Error).message}`,
        );
      }
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

  /**
   * Runs a query against the FTS table. HYBRID by query length (Unicode code
   * points), so a CJK-first product does not silently regress on its most
   * common query shape:
   *
   *  - **3+ code points** → FTS5 `MATCH` on the trigram index (fast path).
   *    `rawQuery` is escaped into a literal FTS5 phrase (see
   *    {@link escapeFtsQuery}) so user input can never be parsed as FTS
   *    operators.
   *  - **exactly 2 code points** → `content LIKE '%'||?||'%' ESCAPE '\\'` on the
   *    SAME `sessions_fts` table. The trigram tokenizer physically cannot MATCH
   *    a 2-code-point query (a trigram is 3), but the old JSONL linear scan did
   *    a raw 2-char substring match — so Korean 2-syllable queries (`매출`,
   *    `분기`, `회의`) that the old search found would silently return [] under a
   *    MATCH-only implementation. This is NOT the No-Fallback linear-scan revival
   *    the module header forbids: it is a different QUERY FORM against the exact
   *    same index table (no JSONL re-read, no second index), so a 2-char query
   *    is answered from the index like every other query. ASCII case-folding
   *    (old `toLowerCase()` parity) is done with `lower()` on both sides;
   *    `lower()` is ASCII-only in stock SQLite, which is fine — Korean has no
   *    case, and the old scan's `toLowerCase()` only ever changed ASCII too.
   *  - **fewer than 2 code points** → never reaches here (guarded upstream in
   *    `MemoryManager.searchSessions`); returns [] defensively if it does.
   *
   * Scope filters (`kind`/`routineId`/`projectRoot`) are applied identically as
   * SQL WHERE clauses over the UNINDEXED columns in both branches. Returns `[]`
   * (never throws, never scans JSONL) on any failure.
   */
  query(rawQuery: string, options: SessionSearchIndexQueryOptions = {}): SessionSearchIndexHit[] {
    if (!this.db) return [];
    const trimmed = rawQuery.trim();
    const cpLen = codePointLength(trimmed);
    if (cpLen < 2) return [];
    try {
      const kind = options.kind ?? "main";
      const limit = options.limit ?? DEFAULT_LIMIT;
      const useLike = cpLen < TRIGRAM_MIN_CODEPOINTS; // exactly 2 code points

      const clauses: string[] = [];
      const params: unknown[] = [];
      // Match predicate + the excerpt expression differ per branch; scope
      // clauses that follow are identical.
      let matchedMessageExpr: string;
      if (useLike) {
        // Substring match on content, case-insensitive for ASCII (lower()).
        clauses.push("lower(content) LIKE lower(?) ESCAPE ?");
        params.push(`%${escapeLikePattern(trimmed)}%`, LIKE_ESCAPE);
        // snippet() is MATCH-only; for the LIKE branch return the raw content
        // (caller/UI already truncates for display, and the JS excerpt below
        // trims it centred on the match).
        matchedMessageExpr = "content";
      } else {
        clauses.push("sessions_fts MATCH ?");
        params.push(escapeFtsQuery(trimmed));
        matchedMessageExpr = `snippet(sessions_fts, 1, '', '', '…', ${SNIPPET_TOKENS})`;
      }

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
               ${matchedMessageExpr} as matchedMessage
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
        matchedMessage: useLike
          ? excerptAroundMatch(row.matchedMessage, trimmed)
          : row.matchedMessage,
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
