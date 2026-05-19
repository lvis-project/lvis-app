/**
 * Memory Manager — 파일 기반 기억 구조
 *
 * ~/.lvis/ 파일 기반 메모리 시스템.
 * - AGENTS.md: 프로젝트·조직 컨텍스트 (관리자 배포 가능)
 * - user-preferences.md: 사용자 개인 선호
 * - memories/MEMORY.md: 부팅 시 적극 주입되는 메모리 인덱스
 * - memories/: 사용자 축적 기억
 * - sessions/: 대화 세션 JSONL *
 * 설계 원칙:
 * - 단순함 우선: 별도 기억 엔진·승격·만료 로직 없음
 * - 사용자 제어: 직접 확인·편집·삭제 가능
 * - 세션 독립: 파일은 영속, 인메모리는 휘발
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmSync, statSync, renameSync, watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import {
  buildToolResultStrippedStub,
  buildToolResultTruncatedStub,
  isToolResultStubContent,
  type ToolResultTruncatedInfo,
} from "../shared/tool-result-stub.js";
const log = createLogger("memory");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

export interface MemoryIndexSectionsPatch {
  urgentMemory?: string;
  references?: string;
}

export interface SessionSearchEntry {
  sessionId: string;
  matchedMessage: string;
  timestamp: string;
  sessionKind: SessionKind;
}

export interface ToolResultArtifact {
  toolUseId: string;
  toolName?: string;
  content: string;
  truncated: ToolResultTruncatedInfo;
  sha256: string;
  createdAt: string;
}

export type SessionKind = "main" | "routine";

export interface ListSessionsOptions {
  kind?: SessionKind | "all";
  routineId?: string;
  limit?: number;
  before?: Date;
  beforeId?: string;
  after?: Date;
}

export interface MainActiveSessionState {
  mainActiveSessionId: string | null;
  mainActiveMode: "resume" | "fresh";
  updatedAt: string;
}

export interface SessionListEntry {
  id: string;
  modifiedAt: Date;
  title: string;
  preview: string;
  sessionKind: SessionKind;
  routineId?: string;
  routineTitle?: string;
  routineFiredAt?: string;
  /**
   * Checkpoint/fork provenance only. This is not a chronological previous
   * session pointer and must not drive automatic previous-session loading.
   */
  parentSessionId?: string;
  /** Compact sequence number this session was forked from. Only set on true checkpoint forks. */
  branchedFromCompactNum?: number;
  /** ISO timestamp when this session was branched. Only set on true checkpoint forks. */
  branchedAt?: string;
}

/**
 * Checkpoint trigger reasons.
 * - "auto-compact": token preflight 가 LLM compact 를 실행
 * - "manual":      user explicitly triggered a checkpoint (e.g. /compact command)
 */
export type CheckpointTrigger = "auto-compact" | "manual";

/**
 * A checkpoint record written into a session's metadata when context is compacted.
 * Stores enough information to reconstruct the chain and resume with prior context.
 *
 * `summary` 는 `renderBoundaryAsPreamble()` 결과 (12-section structured)
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
   * For auto-compact checkpoints, this is `renderBoundaryAsPreamble()` output.
   */
  summary: string | null;
  /** Number of messages in the session at trigger time */
  messageCountAtTrigger: number;
  /**
   * Compact checkpoint #N in the numbered checkpoint chain.
   * Set by auto-compact and manual compact when a checkpoint is created.
   */
  compactNum?: number;
}

/**
 * Metadata stored alongside a session's JSONL message file.
 * Fields are optional because metadata may be partial; missing kind is
 * normalized by the repository and must not imply chronological continuity.
 */
export interface SessionMetadata {
  sessionKind?: SessionKind;
  routineId?: string;
  routineTitle?: string;
  routineFiredAt?: string;
  /** Checkpoint/fork provenance parent, not a chronological previous session. */
  parentSessionId?: string;
  /**
   * Rolling summary carried forward from the parent session.
   * Max 8000 chars (approx. 2000 tokens). Truncated on write if exceeded.
   */
  summaryPreamble?: string;
  /** Checkpoints recorded inside this session (normally 0 or 1) */
  checkpoints?: Checkpoint[];
  /**
   * LLM-generated session title. When set, takes precedence over the
   * auto-derived title from session content. Max 20 chars enforced on write.
   */
  title?: string;
  /**
   * Compact number of the checkpoint this session was branched from.
   * Set when a session is created via branchFromCheckpoint().
   * Absent for normal (non-branched) sessions.
   */
  branchedFromCompactNum?: number;
  /**
   * ISO timestamp when this session was branched from a checkpoint.
   * Absent for normal (non-branched) sessions.
   */
  branchedAt?: string;
}

const MEMORY_MARKER = "<!-- lvis:kind=memory -->";

const DEFAULT_AGENTS_MD = `# LVIS 에이전트 컨텍스트

> 이 파일은 LVIS 에이전트에게 프로젝트·조직·팀 컨텍스트를 전달합니다.
> 관리자가 배포하거나, 사용자가 직접 편집할 수 있습니다.

## 조직 정보

(여기에 팀·부서·프로젝트 정보를 기입하세요)

## 업무 규칙

(반복적으로 지켜야 하는 규칙이나 가이드라인)
`;

const DEFAULT_MEMORY_INDEX = `# LVIS Memory Index

> LVIS가 세션 시작 시 적극적으로 읽는 장기 메모리 인덱스입니다.
> 긴급 기억은 이 파일의 Urgent Memory 섹션에 500자 내외로 유지하고,
> 상세 기억은 같은 폴더의 개별 Markdown 파일로 분리한 뒤 Saved Memories에 링크하세요.

## Urgent Memory

(지금 즉시 참고해야 할 내용을 500자 내외로 유지)

## References

(긴급 기억의 근거 링크 또는 출처)

## Saved Memories

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
const ACTIVE_SESSION_STATE_FILE = ".active-session.json";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToolResultRecord(value: unknown): value is Record<string, unknown> & {
  role: "tool_result";
  toolUseId: string;
  content: string;
} {
  return (
    isRecord(value) &&
    value.role === "tool_result" &&
    typeof value.toolUseId === "string" &&
    typeof value.content === "string"
  );
}

function normalizeTruncatedInfo(value: unknown): ToolResultTruncatedInfo | null {
  if (!isRecord(value)) return null;
  const { originalLines, originalTokens, originalBytes, trimmedAt } = value;
  if (
    typeof originalLines !== "number" ||
    typeof originalTokens !== "number" ||
    typeof originalBytes !== "number" ||
    !Number.isFinite(originalLines) ||
    !Number.isFinite(originalTokens) ||
    !Number.isFinite(originalBytes)
  ) return null;
  return {
    originalLines,
    originalTokens,
    originalBytes,
    trimmedAt: typeof trimmedAt === "string" ? trimmedAt : new Date(0).toISOString(),
  };
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function toolUseArtifactKey(toolUseId: string): string {
  return createHash("sha256").update(toolUseId, "utf8").digest("hex").slice(0, 32);
}

/** Valid trigger values for strict narrowing. */
const VALID_CHECKPOINT_TRIGGERS = new Set<CheckpointTrigger>([
  "auto-compact",
  "manual",
]);

function normalizeSessionKind(value: unknown): SessionKind {
  if (value === "main" || value === "routine") return value;
  return "main";
}

function matchesSessionScope(
  metadata: SessionMetadata | null,
  options: Pick<ListSessionsOptions, "kind" | "routineId">,
): boolean {
  const kind = options.kind ?? "main";
  const sessionKind = metadata?.sessionKind ?? normalizeSessionKind(undefined);
  if (kind !== "all" && sessionKind !== kind) return false;
  if (options.routineId !== undefined && metadata?.routineId !== options.routineId) return false;
  return true;
}

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
  // `compactNum` 은 numbered checkpoint chain 의 #N. load 시 누락되면
  // chain 깨짐 → 신규 record 만 set 되도록 optional 유지하되 정상 read.
  // >= 0 허용 — enterViewMode/branchFromCheckpoint 가 compactNum=0 checkpoint 검색.
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
 * Absent or invalid session kind is treated as main. Routine metadata is not
 * used to infer kind because fallback inference is intentionally unsupported.
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
  const routineId = typeof raw.routineId === "string" ? raw.routineId : undefined;
  return {
    sessionKind: normalizeSessionKind(raw.sessionKind),
    routineId,
    routineTitle: typeof raw.routineTitle === "string" ? raw.routineTitle : undefined,
    routineFiredAt: typeof raw.routineFiredAt === "string" ? raw.routineFiredAt : undefined,
    parentSessionId: isValidSessionId(raw.parentSessionId) ? raw.parentSessionId : undefined,
    // Defense-in-depth: cap on read in case file was written without truncation.
    summaryPreamble: rawPreamble !== undefined
      ? rawPreamble.slice(0, MAX_SUMMARY_PREAMBLE_CHARS)
      : undefined,
    checkpoints: checkpoints && checkpoints.length > 0 ? checkpoints : undefined,
    // Stored title (max 20 chars enforced on write; cap defensively on read too)
    title: rawTitle && rawTitle.length > 0 ? rawTitle.slice(0, 20) : undefined,
    // Checkpoint branch provenance fields.
    branchedFromCompactNum: rawBranchedFromCompactNum,
    branchedAt: rawBranchedAt,
  };
}

export class MemoryManager {
  private readonly lvisDir: string;
  private readonly memoryDir: string;
  private readonly sessionsDir: string;
  private persistentContextWatchers: FSWatcher[] = [];
  private persistentContextReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private persistentContextPollTimer: ReturnType<typeof setInterval> | undefined;
  private persistentContextFileState = new Map<string, number>();
  /** Pre-compact snapshots stored here to avoid polluting listSessions scan. */
  private get checkpointsDir(): string {
    return join(this.sessionsDir, ".checkpoints");
  }
  // 부팅 시 로드되어 캐시되는 영속 기억
  private agentsMd: string = "";
  private memoryIndex: string = "";
  private userPreferences: string = "";

  constructor(options?: MemoryManagerOptions) {
    this.lvisDir = resolve(options?.lvisDir ?? lvisHome());
    this.memoryDir = join(this.lvisDir, "memories");
    this.sessionsDir = join(this.lvisDir, "sessions");
    this.ensureStructure();
  }

  /** 부팅 시 호출 — 영속 기억을 메모리에 로드 */
  load(): void {
    this.agentsMd = this.readFile("AGENTS.md");
    this.memoryIndex = this.readMemoryIndex();
    this.userPreferences = this.readFile("user-preferences.md");
  }

  /** Watch AGENTS.md and MEMORY.md so direct file edits affect the next prompt. */
  startPersistentContextWatcher(): void {
    if (this.persistentContextWatchers.length > 0 || this.persistentContextPollTimer !== undefined) return;
    this.snapshotPersistentContextFiles();
    this.watchDirectoryForPersistentContext(this.lvisDir, new Set(["AGENTS.md", "user-preferences.md"]));
    this.watchDirectoryForPersistentContext(this.memoryDir, new Set(["MEMORY.md"]));
    this.startPersistentContextPoller();
  }

  stopPersistentContextWatcher(): void {
    if (this.persistentContextReloadTimer !== undefined) {
      clearTimeout(this.persistentContextReloadTimer);
      this.persistentContextReloadTimer = undefined;
    }
    if (this.persistentContextPollTimer !== undefined) {
      clearInterval(this.persistentContextPollTimer);
      this.persistentContextPollTimer = undefined;
    }
    for (const watcher of this.persistentContextWatchers) {
      try {
        watcher.close();
      } catch {
        /* ignore close races */
      }
    }
    this.persistentContextWatchers = [];
    this.persistentContextFileState.clear();
  }

  // ─── Read API (SystemPromptBuilder에서 사용) ──────

  getAgentsMd(): string {
    return this.agentsMd;
  }

  /** @deprecated Storage has moved to AGENTS.md; kept for legacy IPC/tests. */
  getLvisMd(): string {
    return this.getAgentsMd();
  }

  getMemoryIndex(): string {
    return this.memoryIndex;
  }

  getUserPreferences(): string {
    return this.userPreferences;
  }

  /** memories/ 전체 목록 반환 */
  listMemoryEntries(): NoteEntry[] {
    return this.readMarkdownEntries(this.memoryDir);
  }

  /** memories/ 키워드 검색 — Agent Loop에서 on-demand 참조. Cap 50. */
  searchMemoryEntries(query: string): NoteEntry[] {
    return this.searchEntries(this.listMemoryEntries(), query);
  }

  /** sessions/ 키워드 검색 — D5 메모리 검색 패널용. Cap 50. */
  searchSessions(query: string, options: Pick<ListSessionsOptions, "kind" | "routineId"> = {}): SessionSearchEntry[] {
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
      const metadata = this.loadSessionMetadata(stem);
      if (!matchesSessionScope(metadata, options)) continue;
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
              results.push({
                sessionId: stem,
                matchedMessage: excerpt,
                timestamp,
                sessionKind: metadata?.sessionKind ?? normalizeSessionKind(undefined),
              });
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

  /** memories/ 전체를 하나의 문자열로 — SystemPromptBuilder에서 사용 */
  getMemoryContext(): string {
    return this.buildMarkdownContext(this.listMemoryEntries());
  }

  /** sessions/ 최근 목록 — 검색 전에도 항목을 확인할 수 있도록 최근 세션을 노출한다. */
  listSessionEntries(limit = 50, options: Pick<ListSessionsOptions, "kind" | "routineId"> = {}): SessionSearchEntry[] {
    const UUID_RE = /^[0-9a-f-]{8,}$/i;
    return this.listSessions({ ...options, limit })
      .filter((session) => UUID_RE.test(session.id))
      .map((session) => ({
        sessionId: session.id,
        matchedMessage: session.preview,
        timestamp: session.modifiedAt.toISOString(),
        sessionKind: session.sessionKind,
      }));
  }

  // ─── Write API ("이거 기억해" 명령) ───────────────

  /** 기억 저장 — 사용자가 "기억해" 하면 memories/에 저장 */
  async saveMemory(title: string, content: string): Promise<NoteEntry> {
    const filename = this.memoryFilenameForTitle(title);
    const visibleContent = `# ${title}\n\n${content}\n`;
    const storedContent = `${MEMORY_MARKER}\n${visibleContent}`;
    const targetPath = join(this.memoryDir, filename);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(indexPath, async () => {
      writeFileSync(targetPath, storedContent, "utf-8");
      this.updateMemoryIndexLocked(indexPath, filename, title, content);
    });
    this.memoryIndex = this.readMemoryIndex();
    return { filename, title, content: visibleContent, updatedAt: new Date().toISOString() };
  }

  /** memories/MEMORY.md 업데이트 */
  async updateMemoryIndex(content: string): Promise<void> {
    const targetPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  async updateMemoryIndexIfUnchanged(expectedContent: string, nextContent: string): Promise<boolean> {
    const targetPath = join(this.memoryDir, "MEMORY.md");
    let didUpdate = false;
    await withFileLock(targetPath, async () => {
      const current = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";
      if (current !== expectedContent) return;
      writeFileSync(targetPath, nextContent, "utf-8");
      didUpdate = true;
    });
    this.memoryIndex = this.readMemoryIndex();
    return didUpdate;
  }

  async updateMemoryIndexSections(sections: MemoryIndexSectionsPatch): Promise<void> {
    const targetPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(targetPath, async () => {
      const current = existsSync(targetPath)
        ? readFileSync(targetPath, "utf-8")
        : DEFAULT_MEMORY_INDEX;
      writeFileSync(targetPath, this.patchMemoryIndexSections(current, sections), "utf-8");
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  /** 기억 삭제 */
  async deleteMemory(filename: string): Promise<void> {
    const safeFilename = this.validateDeletableMemoryFilename(filename);
    const path = join(this.memoryDir, safeFilename);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(indexPath, async () => {
      if (existsSync(path)) unlinkSync(path);
      this.removeMemoryIndexEntryLocked(safeFilename, indexPath);
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  /** AGENTS.md 업데이트 */
  async updateAgentsMd(content: string): Promise<void> {
    const targetPath = join(this.lvisDir, "AGENTS.md");
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.agentsMd = content;
  }

  /** @deprecated Storage has moved to AGENTS.md; kept for legacy IPC/tests. */
  async updateLvisMd(content: string): Promise<void> {
    return this.updateAgentsMd(content);
  }

  /** user-preferences.md 업데이트 */
  async updateUserPreferences(content: string): Promise<void> {
    const targetPath = join(this.lvisDir, "user-preferences.md");
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.userPreferences = content;
  }

  /**
   * user-preferences.md compare-and-set update.
   * Used by background refresh so an idle LLM write cannot overwrite a newer
   * manual edit that landed while the refresh was waiting on the model.
   */
  async updateUserPreferencesIfUnchanged(expectedContent: string, nextContent: string): Promise<boolean> {
    const targetPath = join(this.lvisDir, "user-preferences.md");
    let didWrite = false;
    await withFileLock(targetPath, async () => {
      const current = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";
      if (current !== expectedContent) return;
      writeFileSync(targetPath, nextContent, "utf-8");
      this.userPreferences = nextContent;
      didWrite = true;
    });
    if (!didWrite) {
      this.userPreferences = this.readFile("user-preferences.md");
    }
    return didWrite;
  }

  /** ~/.lvis/ 경로 반환 */
  getDir(): string {
    return this.lvisDir;
  }

  // ─── Private ──────────────────────────────────────

  // ─── Session Persistence (~/.lvis/sessions/) ─

  /** 세션 저장 — JSONL 형식 */
  async saveSession(sessionId: string, messages: unknown[]): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`saveSession: invalid sessionId "${sessionId}"`);
    }
    const targetPath = join(this.sessionsDir, `${sessionId}.jsonl`);
    await withFileLock(targetPath, async () => {
      const prepared = this.prepareSessionMessagesForDisk(sessionId, messages);
      const lines = prepared.messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      writeFileSync(targetPath, lines, "utf-8");
      this.cleanupToolResultArtifacts(sessionId, prepared.keepArtifactKeys);
    });
  }

  /**
   * Save a per-checkpoint pre-compact snapshot before compaction overwrites the main JSONL.
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
    await withFileLock(targetPath, async () => {
      const prepared = this.prepareSessionMessagesForDisk(sessionId, messages);
      const lines = prepared.messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      writeFileSync(targetPath, lines, "utf-8");
    });
  }

  /** Load a per-checkpoint pre-compact snapshot saved by saveCheckpointSnapshot(). Returns null if not found. */
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
    if (!isValidSessionId(sessionId)) return null;
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

  loadToolResultArtifact(sessionId: string, toolUseId: string): ToolResultArtifact | null {
    if (!isValidSessionId(sessionId) || typeof toolUseId !== "string" || toolUseId.length === 0) {
      return null;
    }
    const paths = this.toolResultArtifactPaths(sessionId, toolUseId);
    if (!existsSync(paths.contentPath) || !existsSync(paths.metaPath)) return null;
    try {
      const content = readFileSync(paths.contentPath, "utf-8");
      const meta = JSON.parse(readFileSync(paths.metaPath, "utf-8")) as Record<string, unknown>;
      if (meta.toolUseId !== toolUseId) return null;
      const truncated = normalizeTruncatedInfo(meta.truncated);
      const sha256 = typeof meta.sha256 === "string" ? meta.sha256 : "";
      if (!truncated || sha256.length === 0 || sha256Text(content) !== sha256) return null;
      return {
        toolUseId,
        ...(typeof meta.toolName === "string" ? { toolName: meta.toolName } : {}),
        content,
        truncated,
        sha256,
        createdAt: typeof meta.createdAt === "string" ? meta.createdAt : new Date(0).toISOString(),
      };
    } catch (err) {
      log.warn(`loadToolResultArtifact failed for ${sessionId}/${toolUseId}: %s`, (err as Error).message);
      return null;
    }
  }

  rehydrateToolResultArtifacts(sessionId: string, messages: unknown[]): unknown[] {
    if (!isValidSessionId(sessionId)) return messages;
    let changed = false;
    const hydrated = messages.map((message) => {
      if (!isToolResultRecord(message) || !isToolResultStubContent(message.content)) {
        return message;
      }
      const artifact = this.loadToolResultArtifact(sessionId, message.toolUseId);
      if (!artifact) return message;
      const meta = isRecord(message.meta) ? message.meta : {};
      const { serializedStub: _serializedStub, ...restMeta } = meta;
      changed = true;
      return {
        ...message,
        toolName: artifact.toolName ?? message.toolName,
        content: artifact.content,
        meta: {
          ...restMeta,
          truncated: artifact.truncated,
        },
      };
    });
    return changed ? hydrated : messages;
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
    safe = {
      ...safe,
      sessionKind: normalizeSessionKind(safe.sessionKind),
    };
    // Cap stored title to 20 chars.
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
      // Surface metadata parse/IO failures as a warning so a
      // corrupted .meta.json doesn't silently surface as "no metadata".
      // Error semantics are preserved (still returns null) — only the
      // diagnostic surface is added.
      log.warn(`loadSessionMetadata failed for ${sessionId}: %s`, (err as Error).message);
      return null;
    }
  }

  loadMainActiveSessionState(): MainActiveSessionState | null {
    const path = join(this.sessionsDir, ACTIVE_SESSION_STATE_FILE);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      const mode = parsed.mainActiveMode;
      if (mode !== "resume" && mode !== "fresh") return null;
      const id = parsed.mainActiveSessionId;
      const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString();
      const mainActiveSessionId = isValidSessionId(id) ? id : null;
      if (mode === "resume" && mainActiveSessionId) {
        const metadata = this.loadSessionMetadata(mainActiveSessionId);
        if (metadata?.sessionKind === "routine") {
          return {
            mainActiveMode: "fresh",
            mainActiveSessionId: null,
            updatedAt,
          };
        }
      }
      return {
        mainActiveMode: mode,
        mainActiveSessionId,
        updatedAt,
      };
    } catch (err) {
      log.warn(`loadMainActiveSessionState failed: %s`, (err as Error).message);
      return null;
    }
  }

  async saveMainActiveSessionState(state: MainActiveSessionState): Promise<void> {
    const targetPath = join(this.sessionsDir, ACTIVE_SESSION_STATE_FILE);
    const safe: MainActiveSessionState = {
      mainActiveMode: state.mainActiveMode,
      mainActiveSessionId:
        state.mainActiveMode === "fresh"
          ? null
          : isValidSessionId(state.mainActiveSessionId)
            ? state.mainActiveSessionId
            : null,
      updatedAt: state.updatedAt,
    };
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, JSON.stringify(safe, null, 2), "utf-8");
    });
  }

  async markMainActiveFresh(): Promise<void> {
    await this.saveMainActiveSessionState({
      mainActiveSessionId: null,
      mainActiveMode: "fresh",
      updatedAt: new Date().toISOString(),
    });
  }

  async markMainActiveResume(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`markMainActiveResume: invalid sessionId "${sessionId}"`);
    }
    await this.saveMainActiveSessionState({
      mainActiveSessionId: sessionId,
      mainActiveMode: "resume",
      updatedAt: new Date().toISOString(),
    });
  }

  /** 세션 목록 */
  listSessions(input: number | ListSessionsOptions = Number.POSITIVE_INFINITY): SessionListEntry[] {
    const options: ListSessionsOptions = typeof input === "number" ? { limit: input } : input;
    if (!existsSync(this.sessionsDir)) return [];
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
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
      .map((session) => ({ ...session, metadata: this.loadSessionMetadata(session.id) }))
      .filter((session) => matchesSessionScope(session.metadata, options))
      .slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined)
      .map((session) => {
        const metadata = session.metadata;
        const sessionKind = metadata?.sessionKind ?? normalizeSessionKind(undefined);
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
          sessionKind,
          title: metadata?.title || summary.title || metadata?.routineTitle || `세션 ${session.id.slice(0, 8)}`,
          preview: summary.preview,
          routineId: metadata?.routineId,
          routineTitle: metadata?.routineTitle,
          routineFiredAt: metadata?.routineFiredAt,
          // Branch provenance — already loaded from metadata, no extra disk IO
          ...(metadata?.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
          ...(metadata?.branchedFromCompactNum !== undefined ? { branchedFromCompactNum: metadata.branchedFromCompactNum } : {}),
          ...(metadata?.branchedAt ? { branchedAt: metadata.branchedAt } : {}),
        };
      });
  }

  listSessionsPage(options: ListSessionsOptions = {}): SessionListEntry[] {
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
      .map((session) => ({ ...session, metadata: this.loadSessionMetadata(session.id) }))
      .filter((session) => matchesSessionScope(session.metadata, options))
      .slice(0, Number.isFinite(limit) ? limit : undefined)
      .map((session) => {
        const metadata = session.metadata;
        const sessionKind = metadata?.sessionKind ?? normalizeSessionKind(undefined);
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
          sessionKind,
          title: metadata?.title || summary.title || metadata?.routineTitle || `세션 ${session.id.slice(0, 8)}`,
          preview: summary.preview,
          routineId: metadata?.routineId,
          routineTitle: metadata?.routineTitle,
          routineFiredAt: metadata?.routineFiredAt,
          // Branch provenance — already loaded from metadata above, no extra disk IO
          ...(metadata?.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
          ...(metadata?.branchedFromCompactNum !== undefined ? { branchedFromCompactNum: metadata.branchedFromCompactNum } : {}),
          ...(metadata?.branchedAt ? { branchedAt: metadata.branchedAt } : {}),
        };
      });
  }

  listSessionsByRoutine(routineId: string, limit = Number.POSITIVE_INFINITY): SessionListEntry[] {
    return this.listSessions({ kind: "routine", routineId, limit });
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

  /**
   * 세션 삭제 — jsonl + metadata + 같은 session 의 compact archive/snapshot/sidecar 동시 제거.
   *
   * Compact pipeline 이 oversize 메시지를
   * `sessions/<sessionId>/truncated/` 와 `sessions/.checkpoints/<sessionId>/`
   * 에 격리하므로, 세션 삭제 시 transcript 조각이 orphan 으로 남지 않게 함께 정리.
   */
  deleteSession(sessionId: string): void {
    if (!isValidSessionId(sessionId)) {
      log.warn({ sessionId }, "unsafe caller-provided sessionId rejected in deleteSession");
      return;
    }
    const jsonlPath = join(this.sessionsDir, `${sessionId}.jsonl`);
    if (existsSync(jsonlPath)) unlinkSync(jsonlPath);
    const metaPath = join(this.sessionsDir, `${sessionId}.meta.json`);
    if (existsSync(metaPath)) unlinkSync(metaPath);
    const sessionDir = join(this.sessionsDir, sessionId);
    if (existsSync(sessionDir)) {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`deleteSession: failed to remove session dir ${sessionDir}: ${(err as Error).message}`);
      }
    }
    const checkpointSnapshotDir = join(this.checkpointsDir, sessionId);
    if (existsSync(checkpointSnapshotDir)) {
      try {
        rmSync(checkpointSnapshotDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`deleteSession: failed to remove checkpoint snapshot dir ${checkpointSnapshotDir}: ${(err as Error).message}`);
      }
    }
    const diffCacheDir = join(this.lvisDir, "diff-cache", sessionId);
    if (existsSync(diffCacheDir)) {
      try {
        rmSync(diffCacheDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`deleteSession: failed to remove diff cache dir ${diffCacheDir}: ${(err as Error).message}`);
      }
    }
  }

  private toolResultArtifactsDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId, "tool-results");
  }

  private toolResultArtifactPaths(sessionId: string, toolUseId: string): { key: string; contentPath: string; metaPath: string } {
    const key = toolUseArtifactKey(toolUseId);
    const dir = this.toolResultArtifactsDir(sessionId);
    return {
      key,
      contentPath: join(dir, `${key}.txt`),
      metaPath: join(dir, `${key}.json`),
    };
  }

  private writeToolResultArtifact(
    sessionId: string,
    message: { toolUseId: string; toolName?: unknown; content: string },
    truncated: ToolResultTruncatedInfo,
  ): void {
    const paths = this.toolResultArtifactPaths(sessionId, message.toolUseId);
    mkdirSync(this.toolResultArtifactsDir(sessionId), { recursive: true, mode: 0o700 });
    const sha256 = sha256Text(message.content);
    writeFileSync(paths.contentPath, message.content, { encoding: "utf-8", mode: 0o600 });
    writeFileSync(
      paths.metaPath,
      JSON.stringify({
        toolUseId: message.toolUseId,
        ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
        truncated,
        sha256,
        createdAt: new Date().toISOString(),
      }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  }

  private prepareSessionMessagesForDisk(sessionId: string, messages: unknown[]): {
    messages: unknown[];
    keepArtifactKeys: Set<string>;
  } {
    const keepArtifactKeys = new Set<string>();
    const prepared = messages.map((message) => {
      if (!isToolResultRecord(message)) return message;

      const meta = isRecord(message.meta) ? message.meta : {};
      let truncated = normalizeTruncatedInfo(meta.truncated);
      const compactedAt = typeof meta.compactedAt === "string" ? meta.compactedAt : undefined;
      const hasStubPrefix = isToolResultStubContent(message.content);
      const isSerializedStub = hasStubPrefix && (meta.serializedStub === true || !truncated);

      if (truncated) {
        const paths = this.toolResultArtifactPaths(sessionId, message.toolUseId);
        keepArtifactKeys.add(paths.key);
        if (!isSerializedStub) {
          this.writeToolResultArtifact(sessionId, message, truncated);
        }
      } else if (isSerializedStub) {
        const paths = this.toolResultArtifactPaths(sessionId, message.toolUseId);
        const artifact = this.loadToolResultArtifact(sessionId, message.toolUseId);
        if (artifact) {
          keepArtifactKeys.add(paths.key);
          truncated = artifact.truncated;
          if (compactedAt === undefined) {
            return {
              ...message,
              content: buildToolResultTruncatedStub(message.toolUseId, message.toolName as string | undefined, artifact.truncated),
              meta: {
                ...meta,
                truncated: artifact.truncated,
                serializedStub: true,
              },
            };
          }
        }
      }

      if (!truncated && compactedAt === undefined) return message;

      const content =
        compactedAt !== undefined
          ? buildToolResultStrippedStub(
              typeof message.toolName === "string" ? message.toolName : undefined,
              truncated?.originalBytes ?? message.content.length,
            )
          : buildToolResultTruncatedStub(
              message.toolUseId,
              typeof message.toolName === "string" ? message.toolName : undefined,
              truncated!,
            );
      return {
        ...message,
        content,
        meta: {
          ...meta,
          ...(truncated ? { truncated } : {}),
          serializedStub: true,
        },
      };
    });

    return { messages: prepared, keepArtifactKeys };
  }

  private cleanupToolResultArtifacts(sessionId: string, keepArtifactKeys: Set<string>): void {
    const dir = this.toolResultArtifactsDir(sessionId);
    if (!existsSync(dir)) return;
    const checkpointKeys = this.loadCheckpointToolResultArtifactKeys(sessionId);
    for (const entry of readdirSync(dir)) {
      const key = entry.replace(/\.(txt|json)$/u, "");
      if (keepArtifactKeys.has(key) || checkpointKeys.has(key)) continue;
      try {
        unlinkSync(join(dir, entry));
      } catch (err) {
        log.warn(`cleanupToolResultArtifacts: failed to remove ${entry}: ${(err as Error).message}`);
      }
    }
  }

  private loadCheckpointToolResultArtifactKeys(sessionId: string): Set<string> {
    const keys = new Set<string>();
    const dir = join(this.checkpointsDir, sessionId);
    if (!existsSync(dir)) return keys;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(dir, entry);
      try {
        const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isToolResultRecord(parsed)) continue;
          const meta = isRecord(parsed.meta) ? parsed.meta : {};
          if (isToolResultStubContent(parsed.content) || normalizeTruncatedInfo(meta.truncated)) {
            keys.add(toolUseArtifactKey(parsed.toolUseId));
          }
        }
      } catch (err) {
        log.warn(`loadCheckpointToolResultArtifactKeys: failed to scan ${entry}: ${(err as Error).message}`);
      }
    }
    return keys;
  }

  private ensureStructure(): void {
    mkdirSync(this.lvisDir, { recursive: true });
    this.migrateLegacyFile("LVIS.md", "AGENTS.md");
    this.migrateLegacyDirectory("memory", "memories");

    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });

    const agentsMdPath = join(this.lvisDir, "AGENTS.md");
    if (!existsSync(agentsMdPath)) {
      writeFileSync(agentsMdPath, DEFAULT_AGENTS_MD, "utf-8");
    }

    const userPrefsPath = join(this.lvisDir, "user-preferences.md");
    if (!existsSync(userPrefsPath)) {
      writeFileSync(userPrefsPath, DEFAULT_USER_PREFS, "utf-8");
    }

    const memoryIndexPath = join(this.memoryDir, "MEMORY.md");
    if (!existsSync(memoryIndexPath)) {
      writeFileSync(memoryIndexPath, DEFAULT_MEMORY_INDEX, "utf-8");
    }
  }

  private readFile(name: string): string {
    const path = join(this.lvisDir, name);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  private readMemoryIndex(): string {
    const path = join(this.memoryDir, "MEMORY.md");
    if (!existsSync(path)) return "";
    return this.truncateMemoryIndex(readFileSync(path, "utf-8"));
  }

  private watchDirectoryForPersistentContext(dir: string, filenames: Set<string>): void {
    try {
      const watcher = watch(dir, { persistent: false }, (_eventType, changedName) => {
        const name = typeof changedName === "string" ? basename(changedName) : "";
        if (name !== "" && !filenames.has(name)) return;
        this.schedulePersistentContextReload(name || dir);
      });
      watcher.on("error", (err) => {
        log.warn({ dir, err }, "persistent context watcher failed");
        this.schedulePersistentContextReload(`${dir}:watcher-error`);
      });
      this.persistentContextWatchers.push(watcher);
    } catch (err) {
      log.warn({ dir, err }, "persistent context watcher unavailable");
    }
  }

  private persistentContextFiles(): string[] {
    return [
      join(this.lvisDir, "AGENTS.md"),
      join(this.lvisDir, "user-preferences.md"),
      join(this.memoryDir, "MEMORY.md"),
    ];
  }

  private snapshotPersistentContextFiles(): void {
    this.persistentContextFileState.clear();
    for (const path of this.persistentContextFiles()) {
      this.persistentContextFileState.set(path, this.getFileMtimeMs(path));
    }
  }

  private startPersistentContextPoller(): void {
    if (this.persistentContextPollTimer !== undefined) return;
    const timer = setInterval(() => {
      let changed = false;
      for (const path of this.persistentContextFiles()) {
        const previous = this.persistentContextFileState.get(path);
        const current = this.getFileMtimeMs(path);
        if (previous !== current) {
          this.persistentContextFileState.set(path, current);
          changed = true;
        }
      }
      if (changed) this.schedulePersistentContextReload("persistent-context-poll");
    }, 500);
    const maybeNodeTimer = timer as ReturnType<typeof setInterval> & { unref?: () => void };
    maybeNodeTimer.unref?.();
    this.persistentContextPollTimer = timer;
  }

  private getFileMtimeMs(path: string): number {
    try {
      return existsSync(path) ? statSync(path).mtimeMs : -1;
    } catch {
      return -1;
    }
  }

  private schedulePersistentContextReload(reason: string): void {
    if (this.persistentContextReloadTimer !== undefined) {
      clearTimeout(this.persistentContextReloadTimer);
    }
    const timer = setTimeout(() => {
      this.persistentContextReloadTimer = undefined;
      try {
        this.load();
        log.info({ reason }, "persistent context reloaded");
      } catch (err) {
        log.warn({ reason, err }, "persistent context reload failed");
      }
    }, 75);
    const maybeNodeTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
    maybeNodeTimer.unref?.();
    this.persistentContextReloadTimer = timer;
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
        if (filename.toLowerCase() === "memory.md") return [];
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

  private migrateLegacyFile(legacyName: string, currentName: string): void {
    const legacyPath = join(this.lvisDir, legacyName);
    const currentPath = join(this.lvisDir, currentName);
    if (!existsSync(legacyPath)) return;
    if (existsSync(currentPath)) {
      log.warn(`${legacyName} exists but ${currentName} is already present; keeping ${currentName}`);
      return;
    }
    renameSync(legacyPath, currentPath);
  }

  private migrateLegacyDirectory(legacyName: string, currentName: string): void {
    const legacyPath = join(this.lvisDir, legacyName);
    const currentPath = join(this.lvisDir, currentName);
    if (!existsSync(legacyPath)) return;
    if (!existsSync(currentPath)) {
      renameSync(legacyPath, currentPath);
      return;
    }
    for (const entry of readdirSync(legacyPath)) {
      const source = join(legacyPath, entry);
      const target = join(currentPath, entry);
      if (existsSync(target)) continue;
      renameSync(source, target);
    }
    log.warn(`${legacyName}/ exists alongside ${currentName}/; moved non-conflicting entries into ${currentName}/`);
  }

  private updateMemoryIndexLocked(targetPath: string, filename: string, title: string, content: string): void {
    const safeTitle = title.replace(/[\r\n\[\]]/g, " ").trim() || filename.replace(".md", "");
    const excerpt = content.replace(/\s+/g, " ").trim().slice(0, 140);
    const line = `- [${safeTitle}](./${filename}) — ${excerpt}`;
    const existing = existsSync(targetPath)
      ? readFileSync(targetPath, "utf-8")
      : DEFAULT_MEMORY_INDEX;
    const lines = existing.split(/\r?\n/);
    const linkNeedle = `](./${filename})`;
    const idx = lines.findIndex((l) => l.includes(linkNeedle));
    if (idx >= 0) {
      lines[idx] = line;
    } else {
      if (!existing.includes("## Saved Memories")) {
        lines.push("", "## Saved Memories", "");
      }
      lines.push(line);
    }
    writeFileSync(targetPath, lines.join("\n").replace(/\n{4,}/g, "\n\n\n"), "utf-8");
  }

  private patchMemoryIndexSections(markdown: string, sections: MemoryIndexSectionsPatch): string {
    let next = this.ensureMemoryIndexSections(markdown);
    if (sections.urgentMemory !== undefined) {
      next = this.replaceMemoryIndexSection(next, "Urgent Memory", sections.urgentMemory);
    }
    if (sections.references !== undefined) {
      next = this.replaceMemoryIndexSection(next, "References", sections.references);
    }
    return `${next.trim()}\n`;
  }

  private ensureMemoryIndexSections(markdown: string): string {
    const base = markdown.trim() ? markdown.trim() : "# LVIS Memory Index";
    let next = base.startsWith("# ") ? base : `# LVIS Memory Index\n\n${base}`;
    next = this.ensureMemoryIndexSection(next, "Urgent Memory", "(지금 즉시 참고해야 할 내용을 500자 내외로 유지)");
    next = this.ensureMemoryIndexSection(next, "References", "(긴급 기억의 근거 링크 또는 출처)");
    next = this.ensureMemoryIndexSection(next, "Saved Memories", "");
    return next;
  }

  private ensureMemoryIndexSection(markdown: string, heading: string, placeholder: string): string {
    if (this.hasMemoryIndexSection(markdown, heading)) return markdown;
    const block = `## ${heading}\n\n${placeholder}`.trimEnd();
    if (heading !== "Saved Memories") {
      const savedIndex = markdown.search(/^##\s+Saved Memories\s*$/im);
      if (savedIndex >= 0) {
        return `${markdown.slice(0, savedIndex).trimEnd()}\n\n${block}\n\n${markdown.slice(savedIndex).trimStart()}`;
      }
    }
    return `${markdown.trimEnd()}\n\n${block}`;
  }

  private replaceMemoryIndexSection(markdown: string, heading: string, body: string): string {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const headingRegex = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
    const nextHeadingRegex = /^##\s+/;
    const start = lines.findIndex((line) => headingRegex.test(line));
    const sectionLines = [`## ${heading}`, "", ...body.trim().split(/\r?\n/).filter((line) => line.length > 0)];
    if (start < 0) {
      return `${markdown.trimEnd()}\n\n${sectionLines.join("\n")}`;
    }

    let end = start + 1;
    while (end < lines.length && !nextHeadingRegex.test(lines[end])) {
      end += 1;
    }
    return [...lines.slice(0, start), ...sectionLines, "", ...lines.slice(end)].join("\n").replace(/\n{4,}/g, "\n\n\n");
  }

  private hasMemoryIndexSection(markdown: string, heading: string): boolean {
    return new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "im").test(markdown);
  }

  private memoryFilenameForTitle(title: string): string {
    const filename = `${this.slugify(title)}.md`;
    return this.isMemoryIndexFilename(filename) ? "memory-entry.md" : filename;
  }

  private removeMemoryIndexEntryLocked(filename: string, targetPath: string): void {
    if (!existsSync(targetPath)) {
      this.memoryIndex = "";
      return;
    }
    const existing = readFileSync(targetPath, "utf-8");
    const linkNeedle = `](./${filename})`;
    const lines = existing.split(/\r?\n/).filter((line) => !line.includes(linkNeedle));
    writeFileSync(targetPath, lines.join("\n"), "utf-8");
  }

  private validateDeletableMemoryFilename(filename: string): string {
    if (
      typeof filename !== "string" ||
      filename.trim() === "" ||
      filename.includes("\0") ||
      basename(filename) !== filename ||
      !filename.endsWith(".md")
    ) {
      throw new Error("deleteMemory: invalid memory filename");
    }
    if (this.isMemoryIndexFilename(filename)) {
      throw new Error("deleteMemory: MEMORY.md is an index file and cannot be deleted as a memory entry");
    }
    return filename;
  }

  private isMemoryIndexFilename(filename: string): boolean {
    return filename.toLowerCase() === "memory.md";
  }

  private truncateMemoryIndex(content: string): string {
    const byLines = content.split(/\r?\n/).slice(0, 200).join("\n");
    const buf = Buffer.from(byLines, "utf-8");
    if (buf.byteLength <= 25 * 1024) return byLines;
    return buf.subarray(0, 25 * 1024).toString("utf-8");
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
