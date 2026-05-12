/**
 * Memory Manager — §5 경량 기억 구조
 *
 * ~/.lvis/ 파일 기반 메모리 시스템.
 * - LVIS.md: 프로젝트·조직 컨텍스트 (관리자 배포 가능)
 * - user-preferences.md: 사용자 개인 선호
 * - memory/: 사용자 축적 메모리 ("이거 기억해")
 * - sessions/: 대화 세션 JSONL *
 * 설계 원칙 (§5.1):
 * - 단순함 우선: 별도 기억 엔진·승격·만료 로직 없음
 * - 사용자 제어: 직접 확인·편집·삭제 가능
 * - 세션 독립: 파일은 영속, 인메모리는 휘발
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
const log = createLogger("memory");

export interface MemoryManagerOptions {
  /** lvisHome() 기본, 테스트 시 override */
  lvisDir?: string;
}

export interface NoteEntry {
  filename: string;
  title: string;
  content: string;
  updatedAt?: string;
  excerpt?: string;
}

export interface SessionSearchEntry {
  sessionId: string;
  matchedMessage: string;
  timestamp: string;
}

export interface SessionListEntry {
  id: string;
  modifiedAt: Date;
  title: string;
  preview: string;
  routineId?: string;
  routineTitle?: string;
  /**
   * ID of the previous session in this chain. Set for all chained sessions
   * (session-resume, rotation, and §PR-5 branchFromCheckpoint forks).
   * Use branchedFromCompactNum to distinguish true checkpoint forks from other chain types.
   */
  parentSessionId?: string;
  /** §PR-5: compact sequence number this session was forked from. Only set on true checkpoint forks. */
  branchedFromCompactNum?: number;
  /** §PR-5: ISO timestamp when this session was branched. Only set on true checkpoint forks. */
  branchedAt?: string;
}

/**
 * Checkpoint trigger reasons (post-infinity-session-v3).
 * - "auto-compact": Layer 0 pre-flight 가 Layer 2 compact 를 실행
 * - "manual":      user explicitly triggered a checkpoint (e.g. /compact command)
 */
export type CheckpointTrigger = "auto-compact" | "manual";

/**
 * A checkpoint record written into a session's metadata when context is compacted.
 * Stores enough information to reconstruct the chain and resume with prior context.
 *
 * PR-2-C 정정 — `summary` 는 이제 `renderBoundaryAsPreamble()` 결과 (12-section structured)
 * 또는 raw fallback. 전체 `CompactBoundary` 객체는 module boundary (memory ⊥ engine)
 * 준수상 *in-memory only* — `MessageMeta.boundary` 에 frozen reference 로 보존됨.
 */
export interface Checkpoint {
  /** Unique checkpoint identifier (any non-empty string; typically a UUID) */
  id: string;
  /** ISO timestamp when the checkpoint was created */
  triggeredAt: string;
  /** What caused the checkpoint */
  trigger: CheckpointTrigger;
  /**
   * Token usage ratio at the moment of trigger (0.0–1.0).
   * Used by the checkpoint engine to decide summary depth.
   */
  ctxUsageAtTrigger: number;
  /**
   * Rolling summary text generated at checkpoint time.
   * null when context was below the 10% minimum — no summary needed.
   * PR-2-C 이후 Layer 0 preflight checkpoint 의 경우 `renderBoundaryAsPreamble()` 결과.
   */
  summary: string | null;
  /** Number of messages in the session at trigger time */
  messageCountAtTrigger: number;
  /**
   * Layer 2 compact #N (numbered checkpoint chain — Copilot 패턴).
   * PR-2-C 이후 auto-compact + manual compact 양쪽에서 set. legacy rotation 은 absent.
   */
  compactNum?: number;
}

/**
 * Metadata stored alongside a session's JSONL message file.
 * All fields are optional to preserve backward compatibility with
 * sessions written before the checkpoint chain feature was introduced.
 */
export interface SessionMetadata {
  routineId?: string;
  routineTitle?: string;
  /** ID of the previous session in this checkpoint chain (if any) */
  parentSessionId?: string;
  /**
   * Rolling summary carried forward from the parent session.
   * Max 8000 chars (approx. 2000 tokens). Truncated on write if exceeded.
   */
  summaryPreamble?: string;
  /** Checkpoints recorded inside this session (normally 0 or 1) */
  checkpoints?: Checkpoint[];
  /**
   * §PR-3: LLM-generated session title. When set, takes precedence over the
   * auto-derived title from session content. Max 20 chars enforced on write.
   */
  title?: string;
  /**
   * §PR-5: compact number of the checkpoint this session was branched from.
   * Set when a session is created via branchFromCheckpoint().
   * Absent for normal (non-branched) sessions.
   */
  branchedFromCompactNum?: number;
  /**
   * §PR-5: ISO timestamp when this session was branched from a checkpoint.
   * Absent for normal (non-branched) sessions.
   */
  branchedAt?: string;
}

const MEMORY_MARKER = "<!-- lvis:kind=memory -->";

const DEFAULT_LVIS_MD = `# LVIS 컨텍스트

> 이 파일은 LVIS 에이전트에게 프로젝트·조직·팀 컨텍스트를 전달합니다.
> 관리자가 배포하거나, 사용자가 직접 편집할 수 있습니다.

## 조직 정보

(여기에 팀·부서·프로젝트 정보를 기입하세요)

## 업무 규칙

(반복적으로 지켜야 하는 규칙이나 가이드라인)
`;

const DEFAULT_USER_PREFS = `# 사용자 선호

> LVIS가 참고하는 개인 선호 설정입니다. 자유롭게 편집하세요.

## 커뮤니케이션 스타일

- 한국어로 답변
- 간결한 설명 선호

## 자주 쓰는 도구

(자주 사용하는 플러그인, 도구, 명령어 등)
`;

const MAX_SESSION_FILE_BYTES = 5_000_000;
/** Max length of summaryPreamble stored in session metadata (~2000 tokens). */
const MAX_SUMMARY_PREAMBLE_CHARS = 8_000;

/**
 * Regex for session IDs used in file paths.
 * Allows alphanumerics, underscores, and hyphens — rejects path-traversal chars.
 */
const SESSION_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;

/**
 * Returns true when `id` is a valid session ID safe to use as a filename component.
 * Single source of truth for session ID validation across all call sites.
 */
function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_REGEX.test(id);
}

/** Valid trigger values for strict narrowing. */
const VALID_CHECKPOINT_TRIGGERS = new Set<CheckpointTrigger>([
  "auto-compact",
  "manual",
]);

/**
 * Normalizes a raw parsed Checkpoint record — rejects entries with invalid
 * trigger values or missing required fields so corrupted data is never surfaced.
 */
function normalizeCheckpoint(raw: unknown): Checkpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  if (typeof r.triggeredAt !== "string") return null;
  if (!VALID_CHECKPOINT_TRIGGERS.has(r.trigger as CheckpointTrigger)) return null;
  const ctxUsage = r.ctxUsageAtTrigger;
  if (typeof ctxUsage !== "number" || ctxUsage < 0 || ctxUsage > 1) return null;
  if (r.summary !== null && typeof r.summary !== "string") return null;
  const msgCount = r.messageCountAtTrigger;
  if (typeof msgCount !== "number" || msgCount < 0 || !Number.isInteger(msgCount)) return null;
  // PR-2-E (#608) — `compactNum` 은 numbered checkpoint chain 의 #N. load 시 누락되면
  // chain 깨짐 → 신규 record 만 set 되도록 optional 유지하되 정상 read.
  // §PR-5: >= 0 허용 — enterViewMode/branchFromCheckpoint 가 compactNum=0 checkpoint 검색.
  const compactNum =
    typeof r.compactNum === "number" && r.compactNum >= 0 && Number.isInteger(r.compactNum)
      ? r.compactNum
      : undefined;
  return {
    id: r.id,
    triggeredAt: r.triggeredAt,
    trigger: r.trigger as CheckpointTrigger,
    ctxUsageAtTrigger: ctxUsage,
    summary: r.summary as string | null,
    messageCountAtTrigger: msgCount,
    ...(compactNum !== undefined && { compactNum }),
  };
}

/**
 * Normalizes a raw parsed SessionMetadata object.
 * All new fields are optional — absent fields are left undefined (backward compat).
 * Invalid checkpoint entries are silently dropped rather than failing the whole load.
 */
function normalizeSessionMetadata(raw: Record<string, unknown>): SessionMetadata {
  const checkpointsRaw = Array.isArray(raw.checkpoints) ? raw.checkpoints : undefined;
  const checkpoints: Checkpoint[] | undefined = checkpointsRaw
    ? (checkpointsRaw.map(normalizeCheckpoint).filter((c): c is Checkpoint => c !== null))
    : undefined;

  const rawPreamble = typeof raw.summaryPreamble === "string" ? raw.summaryPreamble : undefined;
  const rawTitle = typeof raw.title === "string" ? raw.title.trim() : undefined;
  const rawBranchedFromCompactNum = typeof raw.branchedFromCompactNum === "number" && Number.isInteger(raw.branchedFromCompactNum) && raw.branchedFromCompactNum >= 0
    ? raw.branchedFromCompactNum
    : undefined;
  const rawBranchedAt = typeof raw.branchedAt === "string" ? raw.branchedAt : undefined;
  return {
    routineId: typeof raw.routineId === "string" ? raw.routineId : undefined,
    routineTitle: typeof raw.routineTitle === "string" ? raw.routineTitle : undefined,
    parentSessionId: isValidSessionId(raw.parentSessionId) ? raw.parentSessionId : undefined,
    // Defense-in-depth: cap on read in case file was written without truncation.
    summaryPreamble: rawPreamble !== undefined
      ? rawPreamble.slice(0, MAX_SUMMARY_PREAMBLE_CHARS)
      : undefined,
    checkpoints: checkpoints && checkpoints.length > 0 ? checkpoints : undefined,
    // §PR-3: stored title (max 20 chars enforced on write; cap defensively on read too)
    title: rawTitle && rawTitle.length > 0 ? rawTitle.slice(0, 20) : undefined,
    // §PR-5: branch provenance fields
    branchedFromCompactNum: rawBranchedFromCompactNum,
    branchedAt: rawBranchedAt,
  };
}

export class MemoryManager {
  private readonly lvisDir: string;
  private readonly memoryDir: string;
  private readonly sessionsDir: string;
  /** §PR-5: Pre-compact snapshots stored here to avoid polluting listSessions scan. */
  private get checkpointsDir(): string {
    return join(this.sessionsDir, ".checkpoints");
  }
  // 부팅 시 로드되어 캐시되는 영속 기억
  private lvisMd: string = "";
  private userPreferences: string = "";

  constructor(options?: MemoryManagerOptions) {
    this.lvisDir = resolve(options?.lvisDir ?? lvisHome());
    this.memoryDir = join(this.lvisDir, "memory");
    this.sessionsDir = join(this.lvisDir, "sessions");
    this.ensureStructure();
  }

  /** 부팅 시 호출 — 영속 기억을 메모리에 로드 */
  load(): void {
    this.lvisMd = this.readFile("LVIS.md");
    this.userPreferences = this.readFile("user-preferences.md");
  }

  // ─── Read API (SystemPromptBuilder에서 사용) ──────

  getLvisMd(): string {
    return this.lvisMd;
  }

  getUserPreferences(): string {
    return this.userPreferences;
  }

  /** memory/ 전체 목록 반환 */
  listMemoryEntries(): NoteEntry[] {
    return this.readMarkdownEntries(this.memoryDir);
  }

  /** memory/ 키워드 검색 — Agent Loop에서 on-demand 참조 (§5 참조 방식). Cap 50. */
  searchMemoryEntries(query: string): NoteEntry[] {
    return this.searchEntries(this.listMemoryEntries(), query);
  }

  /** sessions/ 키워드 검색 — D5 메모리 검색 패널용. Cap 50. */
  searchSessions(query: string): SessionSearchEntry[] {
    // Require at least 2 chars to prevent accidental full-dump via empty/trivial query.
    if (query.trim().length < 2) return [];
    if (!existsSync(this.sessionsDir)) return [];
    const lower = query.toLowerCase();
    const results: SessionSearchEntry[] = [];
    const UUID_RE = /^[0-9a-f-]{8,}$/i;
    const files = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      if (results.length >= 50) break;
      const stem = file.replace(".jsonl", "");
      // Skip files whose stem is not UUID-shaped — prevents path-traversal info leak.
      if (!UUID_RE.test(stem)) continue;
      const filePath = join(this.sessionsDir, file);
      const stat = statSync(filePath);
      // Skip oversized files — unbounded readFileSync is a DoS vector.
        if (stat.size > MAX_SESSION_FILE_BYTES) continue;
      const timestamp = stat.mtime.toISOString();
      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          if (results.length >= 50) break;
          let msg: unknown;
          try { msg = JSON.parse(line); } catch { continue; }
          const content = (msg as Record<string, unknown>)?.content;
          if (typeof content === "string") {
            const idx = content.toLowerCase().indexOf(lower);
            if (idx !== -1) {
              // Excerpt: ±100 chars centred on match, max 200 chars total.
              const start = Math.max(0, idx - 100);
              const end = Math.min(content.length, idx + lower.length + 100);
              const excerpt = content.slice(start, end);
              results.push({ sessionId: stem, matchedMessage: excerpt, timestamp });
              break; // one match per session
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }
    return results;
  }

  /** memory/ 전체를 하나의 문자열로 — SystemPromptBuilder에서 사용 */
  getMemoryContext(): string {
    return this.buildMarkdownContext(this.listMemoryEntries());
  }

  /** sessions/ 최근 목록 — 검색 전에도 항목을 확인할 수 있도록 최근 세션을 노출한다. */
  listSessionEntries(limit = 50): SessionSearchEntry[] {
    const UUID_RE = /^[0-9a-f-]{8,}$/i;
    return this.listSessions(limit)
      .filter((session) => UUID_RE.test(session.id))
      .map((session) => ({
        sessionId: session.id,
        matchedMessage: session.preview,
        timestamp: session.modifiedAt.toISOString(),
      }));
  }

  // ─── Write API ("이거 기억해" 명령) ───────────────

  /** 메모리 저장 — 사용자가 "기억해" 하면 memory/에 저장 */
  async saveMemory(title: string, content: string): Promise<NoteEntry> {
    const filename = this.slugify(title) + ".md";
    const visibleContent = `# ${title}\n\n${content}\n`;
    const storedContent = `${MEMORY_MARKER}\n${visibleContent}`;
    const targetPath = join(this.memoryDir, filename);
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, storedContent, "utf-8");
    });
    return { filename, title, content: visibleContent, updatedAt: new Date().toISOString() };
  }

  /** 메모리 삭제 */
  deleteMemory(filename: string): void {
    const path = join(this.memoryDir, filename);
    if (existsSync(path)) unlinkSync(path);
  }

  /** LVIS.md 업데이트 */
  async updateLvisMd(content: string): Promise<void> {
    const targetPath = join(this.lvisDir, "LVIS.md");
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.lvisMd = content;
  }

  /** user-preferences.md 업데이트 */
  async updateUserPreferences(content: string): Promise<void> {
    const targetPath = join(this.lvisDir, "user-preferences.md");
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.userPreferences = content;
  }

  /** ~/.lvis/ 경로 반환 */
  getDir(): string {
    return this.lvisDir;
  }

  // ─── Private ──────────────────────────────────────

  // ─── Session Persistence (§5.2 ~/.lvis/sessions/) ─

  /** 세션 저장 — JSONL 형식 (§4.5.7) */
  async saveSession(sessionId: string, messages: unknown[]): Promise<void> {
    const targetPath = join(this.sessionsDir, `${sessionId}.jsonl`);
    const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, lines, "utf-8");
    });
  }

  /**
   * §PR-5: Save a per-checkpoint pre-compact snapshot before compaction overwrites the main JSONL.
   * Stored at `{sessionsDir}/.checkpoints/{sessionId}/{compactNum}.jsonl` so that
   * listSessions/listSessionsPage (which only scan sessionsDir root) never pick them up.
   * branchFromCheckpoint() loads from here instead of the mutable main session file.
   */
  async saveCheckpointSnapshot(sessionId: string, compactNum: number, messages: unknown[]): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`saveCheckpointSnapshot: invalid sessionId "${sessionId}"`);
    }
    const sessionSnapshotDir = join(this.checkpointsDir, sessionId);
    mkdirSync(sessionSnapshotDir, { recursive: true });
    const targetPath = join(sessionSnapshotDir, `${compactNum}.jsonl`);
    const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, lines, "utf-8");
    });
  }

  /** §PR-5: Load a per-checkpoint pre-compact snapshot saved by saveCheckpointSnapshot(). Returns null if not found. */
  loadCheckpointSnapshot(sessionId: string, compactNum: number): unknown[] | null {
    if (!isValidSessionId(sessionId)) return null;
    const snapshotPath = join(this.checkpointsDir, sessionId, `${compactNum}.jsonl`);
    if (!existsSync(snapshotPath)) return null;
    const lines = readFileSync(snapshotPath, "utf-8").trim().split("\n");
    const messages: unknown[] = [];
    for (const line of lines.filter(Boolean)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        log.warn({ sessionId, compactNum }, "skipping malformed checkpoint snapshot line");
      }
    }
    return messages;
  }

  /** 세션 복원 */
  loadSession(sessionId: string): unknown[] | null {
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    const messages: unknown[] = [];
    for (const line of lines.filter(Boolean)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        log.warn({ sessionId }, "skipping malformed session line");
      }
    }
    return messages;
  }

  async saveSessionMetadata(sessionId: string, metadata: SessionMetadata): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`saveSessionMetadata: invalid sessionId "${sessionId}"`);
    }
    const targetPath = join(this.sessionsDir, `${sessionId}.meta.json`);
    // Enforce length invariants on write.
    let safe: SessionMetadata = metadata.summaryPreamble !== undefined &&
      metadata.summaryPreamble.length > MAX_SUMMARY_PREAMBLE_CHARS
      ? { ...metadata, summaryPreamble: metadata.summaryPreamble.slice(0, MAX_SUMMARY_PREAMBLE_CHARS) }
      : metadata;
    // §PR-3: cap stored title to 20 chars.
    if (safe.title !== undefined && safe.title.length > 20) {
      safe = { ...safe, title: safe.title.slice(0, 20) };
    }
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, JSON.stringify(safe, null, 2), "utf-8");
    });
  }

  loadSessionMetadata(sessionId: string): SessionMetadata | null {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`loadSessionMetadata: invalid sessionId "${sessionId}"`);
    }
    const path = join(this.sessionsDir, `${sessionId}.meta.json`);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") return null;
      return normalizeSessionMetadata(parsed);
    } catch (err) {
      // Round-3 §7: surface metadata parse/IO failures as a warning so a
      // corrupted .meta.json doesn't silently surface as "no metadata".
      // Error semantics are preserved (still returns null) — only the
      // diagnostic surface is added.
      log.warn(`loadSessionMetadata failed for ${sessionId}: %s`, (err as Error).message);
      return null;
    }
  }

  /** 세션 목록 */
  listSessions(limit = Number.POSITIVE_INFINITY): SessionListEntry[] {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const stat = statSync(join(this.sessionsDir, f));
        return {
          id: f.replace(".jsonl", ""),
          modifiedAt: stat.mtime,
          size: stat.size,
        };
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())
      .slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined)
      .map((session) => {
        const metadata = this.loadSessionMetadata(session.id);
        const summary = session.size > MAX_SESSION_FILE_BYTES
          ? {
              title: metadata?.routineTitle
                ? `${metadata.routineTitle} 대화`
                : `세션 ${session.id.slice(0, 8)}`,
              preview: "(대화가 커서 미리보기를 생략했습니다)",
            }
          : this.readSessionSummary(session.id);
        return {
          id: session.id,
          modifiedAt: session.modifiedAt,
          title: metadata?.title || summary.title || metadata?.routineTitle || `세션 ${session.id.slice(0, 8)}`,
          preview: summary.preview,
          routineId: metadata?.routineId,
          routineTitle: metadata?.routineTitle,
          // §PR-5: branch provenance — already loaded from metadata, no extra disk IO
          ...(metadata?.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
          ...(metadata?.branchedFromCompactNum !== undefined ? { branchedFromCompactNum: metadata.branchedFromCompactNum } : {}),
          ...(metadata?.branchedAt ? { branchedAt: metadata.branchedAt } : {}),
        };
      });
  }

  listSessionsPage(options: { limit?: number; before?: Date; beforeId?: string; after?: Date } = {}): SessionListEntry[] {
    if (!existsSync(this.sessionsDir)) return [];
    const limit = Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit ?? 0))
      : Number.POSITIVE_INFINITY;
    const beforeTime = options.before?.getTime();
    const beforeId = options.beforeId;
    const afterTime = options.after?.getTime();
    return readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const stat = statSync(join(this.sessionsDir, f));
        return {
          id: f.replace(".jsonl", ""),
          modifiedAt: stat.mtime,
          size: stat.size,
        };
      })
      .filter((session) => {
        const t = session.modifiedAt.getTime();
        if (afterTime !== undefined && !Number.isNaN(afterTime) && t < afterTime) return false;
        if (beforeTime === undefined || Number.isNaN(beforeTime)) return true;
        if (t < beforeTime) return true;
        return t === beforeTime && beforeId !== undefined && session.id < beforeId;
      })
      .sort((a, b) => {
        const timeDelta = b.modifiedAt.getTime() - a.modifiedAt.getTime();
        return timeDelta !== 0 ? timeDelta : b.id.localeCompare(a.id);
      })
      .slice(0, Number.isFinite(limit) ? limit : undefined)
      .map((session) => {
        const metadata = this.loadSessionMetadata(session.id);
        const summary = session.size > MAX_SESSION_FILE_BYTES
          ? {
              title: metadata?.routineTitle
                ? `${metadata.routineTitle} 대화`
                : `세션 ${session.id.slice(0, 8)}`,
              preview: "(대화가 커서 미리보기를 생략했습니다)",
            }
          : this.readSessionSummary(session.id);
        return {
          id: session.id,
          modifiedAt: session.modifiedAt,
          title: metadata?.title || summary.title || metadata?.routineTitle || `세션 ${session.id.slice(0, 8)}`,
          preview: summary.preview,
          routineId: metadata?.routineId,
          routineTitle: metadata?.routineTitle,
          // §PR-5: branch provenance — already loaded from metadata above, no extra disk IO
          ...(metadata?.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
          ...(metadata?.branchedFromCompactNum !== undefined ? { branchedFromCompactNum: metadata.branchedFromCompactNum } : {}),
          ...(metadata?.branchedAt ? { branchedAt: metadata.branchedAt } : {}),
        };
      });
  }

  listSessionsByRoutine(routineId: string, limit = Number.POSITIVE_INFINITY): SessionListEntry[] {
    return this.listSessions()
      .filter((session) => session.routineId === routineId)
      .slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined);
  }

  // ─── Checkpoint Chain Helpers ─────────────────────

  /**
   * Appends a checkpoint to the session's metadata.
   * Returns the updated metadata (does NOT persist — caller must call saveSessionMetadata).
   */
  appendCheckpoint(metadata: SessionMetadata, checkpoint: Checkpoint): SessionMetadata {
    const existing = Array.isArray(metadata.checkpoints) ? metadata.checkpoints : [];
    return { ...metadata, checkpoints: [...existing, checkpoint] };
  }

  /**
   * Sets (or replaces) the summaryPreamble in session metadata.
   * Truncates to MAX_SUMMARY_PREAMBLE_CHARS if the value exceeds the limit.
   * Returns the updated metadata (does NOT persist — caller must call saveSessionMetadata).
   */
  setSummaryPreamble(metadata: SessionMetadata, preamble: string): SessionMetadata {
    const truncated = preamble.length > MAX_SUMMARY_PREAMBLE_CHARS
      ? preamble.slice(0, MAX_SUMMARY_PREAMBLE_CHARS)
      : preamble;
    return { ...metadata, summaryPreamble: truncated };
  }

  /**
   * Walks the parentSessionId chain starting from `sessionId` and returns all
   * ancestor sessions in order from oldest (root) to newest (given sessionId).
   * Stops when a session has no parentSessionId or its metadata is missing.
   * Guards against cycles by tracking visited IDs.
   */
  async getCheckpointChain(sessionId: string): Promise<SessionMetadata[]> {
    // Reject caller-provided IDs that contain path-traversal characters before any file I/O.
    if (!isValidSessionId(sessionId)) {
      log.warn({ sessionId }, "unsafe caller-provided sessionId rejected in getCheckpointChain");
      return [];
    }
    const chain: SessionMetadata[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = sessionId;

    while (currentId !== undefined) {
      if (visited.has(currentId)) {
        log.warn({ sessionId: currentId }, "cycle detected in checkpoint chain — stopping traversal");
        break;
      }
      visited.add(currentId);
      const meta = this.loadSessionMetadata(currentId);
      if (meta === null) break;
      chain.push(meta);
      const nextId = meta.parentSessionId;
      if (nextId !== undefined && !isValidSessionId(nextId)) {
        log.warn({ sessionId: currentId, parentSessionId: nextId }, "unsafe parentSessionId rejected — stopping traversal");
        break;
      }
      currentId = nextId;
    }

    chain.reverse();
    return chain;
  }

  /** 세션 삭제 */
  deleteSession(sessionId: string): void {
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    if (existsSync(path)) unlinkSync(path);
  }

  private ensureStructure(): void {
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });

    const lvisMdPath = join(this.lvisDir, "LVIS.md");
    if (!existsSync(lvisMdPath)) {
      writeFileSync(lvisMdPath, DEFAULT_LVIS_MD, "utf-8");
    }

    const userPrefsPath = join(this.lvisDir, "user-preferences.md");
    if (!existsSync(userPrefsPath)) {
      writeFileSync(userPrefsPath, DEFAULT_USER_PREFS, "utf-8");
    }
  }

  private readFile(name: string): string {
    const path = join(this.lvisDir, name);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  private buildMarkdownContext(entries: NoteEntry[]): string {
    if (entries.length === 0) return "";
    return entries
      .map((n) => `### ${n.title}\n${n.content}`)
      .join("\n\n---\n\n");
  }

  private readMarkdownEntries(dir: string, options?: { excludeMarkedMemory?: boolean }): NoteEntry[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .flatMap((filename) => {
        const path = join(dir, filename);
        const stat = statSync(path);
        const rawContent = readFileSync(path, "utf-8");
        if (options?.excludeMarkedMemory && this.hasMemoryMarker(rawContent)) return [];
        const content = this.stripInternalMarkers(rawContent);
        const titleMatch = content.match(/^#\s+(.+)/m);
        return [{
          filename,
          title: titleMatch?.[1] ?? filename.replace(".md", ""),
          content,
          updatedAt: stat.mtime.toISOString(),
        }];
      })
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
  }

  private searchEntries(entries: NoteEntry[], query: string): NoteEntry[] {
    const lower = query.toLowerCase();
    return entries.filter(
      (note) =>
        note.title.toLowerCase().includes(lower) ||
        note.content.toLowerCase().includes(lower),
    ).slice(0, 50);
  }

  private hasMemoryMarker(content: string): boolean {
    return content.startsWith(`${MEMORY_MARKER}\n`) || content === MEMORY_MARKER;
  }

  private stripInternalMarkers(content: string): string {
    return content.replace(/^<!--\s*lvis:kind=memory\s*-->\r?\n?/, "");
  }

  private readSessionSummary(sessionId: string): { title: string; preview: string } {
    const messages = this.loadSession(sessionId);
    if (!Array.isArray(messages)) {
      return {
        title: `세션 ${sessionId.slice(0, 8)}`,
        preview: "(내용 없음)",
      };
    }

    let lastUser = "";
    let lastContent = "";
    for (const message of messages) {
      const role = (message as Record<string, unknown>)?.role;
      const content = (message as Record<string, unknown>)?.content;
      if (typeof content !== "string" || content.trim().length === 0) continue;
      const normalized = content.replace(/\s+/g, " ").trim();
      lastContent = normalized;
      if (role === "user") lastUser = normalized;
    }

    return {
      title: (lastUser || lastContent || `세션 ${sessionId.slice(0, 8)}`).slice(0, 80),
      preview: (lastContent || lastUser || "(내용 없음)").slice(0, 200),
    };
  }

  private slugify(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "untitled";
  }
}
