



import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmSync, renameSync, watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import { t } from "../i18n/index.js";
import { projectRootEquals } from "../shared/project-identity.js";
import {
  buildToolResultStrippedStub,
  buildToolResultTruncatedStub,
  type ToolResultArtifactUnavailableInfo,
  isToolResultStubContent,
  type ToolResultTruncatedInfo,
} from "../shared/tool-result-stub.js";
import { SessionSearchIndex, type IndexedSessionInput } from "./session-search-index.js";
const log = createLogger("memory");

export const MAX_TOOL_RESULT_ARTIFACT_BYTES = 5_000_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface FileSnapshot {
  content: string;
  mtime: Date;
  mtimeMs: number;
  size: number;
  tooLarge: boolean;
}

function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function readUtf8FileIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
}

function readUtf8FileSnapshotIfPresent(path: string, maxBytes = Number.POSITIVE_INFINITY): FileSnapshot | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (stat.size > maxBytes) {
      return { content: "", mtime: stat.mtime, mtimeMs: stat.mtimeMs, size: stat.size, tooLarge: true };
    }
    return {
      content: readFileSync(fd, "utf-8"),
      mtime: stat.mtime,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      tooLarge: false,
    };
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function statPathIfPresent(path: string): Omit<FileSnapshot, "content" | "tooLarge"> | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    return { mtime: stat.mtime, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readdirIfPresent(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (err) {
    if (isMissingPathError(err)) return [];
    throw err;
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isMissingPathError(err)) throw err;
  }
}

export interface MemoryManagerOptions {

  lvisDir?: string;
}

export interface NoteEntry {
  filename: string;
  title: string;
  content: string;
  updatedAt?: string;
  excerpt?: string;
  projectRoot?: string;
  projectName?: string;
}

export interface ProjectScopedMemoryOptions {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
}

export interface MemoryIndexSectionsPatch {
  urgentMemory?: string;
  references?: string;
}

export interface SessionSearchEntry {
  sessionId: string;
  title?: string;
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

export type SessionKind = "main" | "routine" | "subagent";

export interface ListSessionsOptions {
  kind?: SessionKind | "all";
  routineId?: string;
  projectRoot?: string;
  includeUnscoped?: boolean;
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
  /** Workspace/project root this conversation belongs to. */
  projectRoot?: string;
  /** Human-readable workspace/project label captured when the session was created. */
  projectName?: string;
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




export type CheckpointTrigger = "auto-compact" | "manual";




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
  /** Workspace/project root this conversation belongs to. */
  projectRoot?: string;
  /** Human-readable workspace/project label captured when the session was created. */
  projectName?: string;
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
  /**
   * Sub-agent resume metadata. Written on spawn (SubAgentRunner), read by the
   * PR-C resume entry point to reconstruct the child with the SAME permission
   * scope it was frozen with. Present only on `sessionKind === "subagent"`
   * sessions; absent for main/routine.
   *
   * The scoped tool names the child was spawned with. A resume MUST re-scope
   * the child's ToolRegistry to exactly this set (permission is frozen at the
   * original spawn — resume re-hydrates history, it does not re-grant tools).
   */
  sourceTools?: string[];
  /** Agent profile's `model:` frontmatter the child was spawned with (resume reuses it). */
  profileModel?: string;
  /** Agent profile's `mode:` frontmatter the child was spawned with (resume reuses it). */
  profileMode?: string;
  /**
   * Number of times this sub-agent session has been resumed. Initialized to 0
   * on spawn. PR-D's MAX_RESUMES loop guard reads this to refuse a fork-bomb
   * via the resume axis.
   */
  resumeCount?: number;
  /**
   * Cumulative assistant rounds spent across the original spawn plus every
   * resume segment. Initialized to 0 on spawn (the spawn's own rounds are added
   * by the resume accounting in PR-C/PR-D). PR-D's cumulative-rounds ceiling
   * reads this so a long resume chain cannot exceed the global round budget.
   */
  cumulativeRounds?: number;
}

const MEMORY_MARKER = "<!-- lvis:kind=memory -->";
const MEMORY_PROJECT_ROOT_PREFIX = "<!-- lvis:project-root:";
const MEMORY_PROJECT_NAME_PREFIX = "<!-- lvis:project-name:";

function getDefaultAgentsMd(): string {
  return t("be_memoryManager.defaultAgentsMd");
}

function getDefaultMemoryIndex(): string {
  return t("be_memoryManager.defaultMemoryIndex");
}

function getDefaultUserPrefs(): string {
  return t("be_memoryManager.defaultUserPrefs");
}

const MAX_SESSION_FILE_BYTES = 5_000_000;
/** Max length of summaryPreamble stored in session metadata (~2000 tokens). */
const MAX_SUMMARY_PREAMBLE_CHARS = 8_000;
const MAX_PROJECT_ROOT_CHARS = 2_048;
const MAX_PROJECT_NAME_CHARS = 120;
const ACTIVE_SESSION_STATE_FILE = ".active-session.json";

/**
 * Regex for session IDs used in file paths.
 * Allows alphanumerics, underscores, and hyphens — rejects path-traversal chars.
 */
const SESSION_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;

/**
 * Returns true when `id` is a valid session ID safe to use as a filename component.
 * Single source of truth for session ID validation across all call sites.
 * Exported so the sub-agent resume entry point (SubAgentRunner.resume) can
 * fail-closed on an unsafe `resumeId` BEFORE calling loadSessionMetadata (which
 * throws on an invalid id) — reusing the SOT rather than re-deriving the regex.
 */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_REGEX.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompactBoundaryRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const meta = isRecord(value.meta) ? value.meta : {};
  return value.role === "user" && meta.compactBoundary === true;
}

function isRenderableUserRecord(value: unknown): value is Record<string, unknown> & {
  role: "user";
  content: unknown;
} {
  return isRecord(value) && value.role === "user" && "content" in value && !isCompactBoundaryRecord(value);
}

function findLatestRenderableUserRecord(messages: readonly unknown[]): unknown | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isRenderableUserRecord(message)) return message;
  }
  return null;
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

function normalizeArtifactUnavailable(value: unknown): ToolResultArtifactUnavailableInfo | null {
  if (!isRecord(value)) return null;
  if (value.reason !== "artifact-too-large") return null;
  if (typeof value.maxBytes !== "number" || !Number.isFinite(value.maxBytes) || value.maxBytes <= 0) {
    return null;
  }
  return { reason: "artifact-too-large", maxBytes: value.maxBytes };
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
  if (value === "main" || value === "routine" || value === "subagent") return value;
  return "main";
}

function normalizeMetadataString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxChars) : undefined;
}

/**
 * Extracts every string-valued searchable field from a session's raw
 * (already-parsed) message records into one newline-joined blob for FTS
 * indexing. Covers the same `content: string` case the pre-#1500 linear
 * scan matched (user/assistant/tool_result plain-string content) PLUS text
 * parts of array `content` (multi-part user messages) — a strict superset,
 * never a narrower match set, so this is a coverage improvement rather than
 * a regression relative to the old scan.
 */
function extractSearchableContent(messages: unknown[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    const message = raw as Record<string, unknown>;
    const content = message?.content;
    if (typeof content === "string") {
      if (content.trim().length > 0) parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join("\n");
}

function matchesSessionScope(
  metadata: SessionMetadata | null,
  options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped">,
): boolean {
  const kind = options.kind ?? "main";
  const sessionKind = metadata?.sessionKind ?? normalizeSessionKind(undefined);
  if (kind !== "all" && sessionKind !== kind) return false;
  if (options.routineId !== undefined && metadata?.routineId !== options.routineId) return false;
  if (
    options.projectRoot !== undefined &&
    !projectRootEquals(metadata?.projectRoot, options.projectRoot) &&
    !(options.includeUnscoped === true && metadata?.projectRoot === undefined)
  ) return false;
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
  const projectRoot = normalizeMetadataString(raw.projectRoot, MAX_PROJECT_ROOT_CHARS);
  const projectName = normalizeMetadataString(raw.projectName, MAX_PROJECT_NAME_CHARS);
  // Sub-agent resume metadata (PR-B). Only string[] of strings survives for
  // sourceTools; non-negative integers for the counters. Invalid shapes drop to
  // undefined rather than corrupting the frozen permission scope on resume.
  const sourceTools = Array.isArray(raw.sourceTools)
    ? raw.sourceTools.filter((n): n is string => typeof n === "string")
    : undefined;
  const profileModel = typeof raw.profileModel === "string" ? raw.profileModel : undefined;
  const profileMode = typeof raw.profileMode === "string" ? raw.profileMode : undefined;
  const resumeCount = typeof raw.resumeCount === "number" && Number.isInteger(raw.resumeCount) && raw.resumeCount >= 0
    ? raw.resumeCount
    : undefined;
  const cumulativeRounds = typeof raw.cumulativeRounds === "number" && Number.isInteger(raw.cumulativeRounds) && raw.cumulativeRounds >= 0
    ? raw.cumulativeRounds
    : undefined;
  return {
    sessionKind: normalizeSessionKind(raw.sessionKind),
    routineId,
    routineTitle: typeof raw.routineTitle === "string" ? raw.routineTitle : undefined,
    routineFiredAt: typeof raw.routineFiredAt === "string" ? raw.routineFiredAt : undefined,
    projectRoot,
    projectName,
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
    // Sub-agent resume metadata (PR-B).
    sourceTools: sourceTools && sourceTools.length > 0 ? sourceTools : undefined,
    profileModel,
    profileMode,
    resumeCount,
    cumulativeRounds,
  };
}

export class MemoryManager {
  private readonly lvisDir: string;
  private readonly memoryDir: string;
  private readonly sessionsDir: string;
  /** FTS5 cross-session search index (#1500) — one per MemoryManager instance,
   *  keyed by this.lvisDir (never a global singleton; mirrors sessionsDir). */
  private readonly searchIndex: SessionSearchIndex;
  private persistentContextWatchers: FSWatcher[] = [];
  private persistentContextReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private persistentContextPollTimer: ReturnType<typeof setInterval> | undefined;
  private persistentContextFileState = new Map<string, number>();
  /** Pre-compact snapshots stored here to avoid polluting listSessions scan. */
  private get checkpointsDir(): string {
    return join(this.sessionsDir, ".checkpoints");
  }

  private agentsMd: string = "";
  private memoryIndex: string = "";
  private userPreferences: string = "";

  constructor(options?: MemoryManagerOptions) {
    this.lvisDir = resolve(options?.lvisDir ?? lvisHome());
    this.memoryDir = join(this.lvisDir, "memories");
    this.sessionsDir = join(this.lvisDir, "sessions");
    this.searchIndex = new SessionSearchIndex(this.lvisDir);
    this.ensureStructure();
  }


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

  /**
   * Closes the FTS5 search index's SQLite handle (#1500 / E3). The read
   * (`searchSessions`) and write (`indexSessionForSearch`) paths already
   * open→use→close per operation, so no persistent handle normally survives a
   * call boundary — this is a defensive no-op safety net (idempotent, cheap)
   * kept wired into `before-quit` alongside `stopPersistentContextWatcher()`
   * in case a future long-lived-handle code path is added.
   */
  closeSearchIndex(): void {
    this.searchIndex.close();
  }



  getAgentsMd(): string {
    return this.agentsMd;
  }

  getMemoryIndex(options: ProjectScopedMemoryOptions = {}): string {
    if (options.projectRoot) return "";
    return this.memoryIndex;
  }

  getUserPreferences(): string {
    return this.userPreferences;
  }


  listMemoryEntries(options: ProjectScopedMemoryOptions = {}): NoteEntry[] {
    return this.readMarkdownEntries(this.memoryDir, options);
  }


  searchMemoryEntries(query: string, options: ProjectScopedMemoryOptions = {}): NoteEntry[] {
    return this.searchEntries(this.listMemoryEntries(options), query);
  }


  /**
   * Cross-session search — SQLite FTS5-backed (#1500 / E3). Signature and
   * return type (`SessionSearchEntry[]`) are unchanged from the pre-#1500
   * JSONL linear scan; only the internal implementation moved to
   * `this.searchIndex`. Opens the index on demand (sync — no persistent
   * handle; see `indexSessionForSearch`), queries, then closes, so a search
   * never leaves a handle open to block a later `rmSync(lvisDir)` on Windows.
   * No-Fallback: if the index cannot be opened (corrupt/unavailable), this
   * returns `[]` rather than silently reverting to a scan —
   * `verifyOrRebuildSearchIndex()` (called once at boot) is the only repair
   * path.
   */
  searchSessions(query: string, options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped"> = {}): SessionSearchEntry[] {
    // Require at least 2 Unicode code points. The FTS5 trigram tokenizer can't
    // MATCH a query under 3 code points, but SessionSearchIndex.query() serves a
    // 2-code-point query via a LIKE substring fallback on the same table — this
    // restores the old linear scan's 2-syllable Korean matching (`매출`, `분기`),
    // the single most common query shape for a CJK-first product. Only genuinely
    // trivial (empty / 1-char / whitespace) queries are rejected here, matching
    // the pre-#1500 `< 2` floor. Length is measured in code points (not UTF-16
    // units) so a 2-syllable Korean query counts as 2, not more.
    if ([...query.trim()].length < 2) return [];
    if (!this.searchIndex.open()) return [];
    try {
      return this.searchIndex.query(query, {
        kind: options.kind,
        routineId: options.routineId,
        projectRoot: options.projectRoot,
        includeUnscoped: options.includeUnscoped,
      });
    } finally {
      this.searchIndex.close();
    }
  }


  getMemoryContext(options: ProjectScopedMemoryOptions = {}): string {
    return this.buildMarkdownContext(this.listMemoryEntries(options));
  }


  listSessionEntries(limit = 50, options: Pick<ListSessionsOptions, "kind" | "routineId" | "projectRoot" | "includeUnscoped"> = {}): SessionSearchEntry[] {
    const UUID_RE = /^[0-9a-f-]{8,}$/i;
    return this.listSessions({ ...options, limit })
      .filter((session) => UUID_RE.test(session.id))
      .map((session) => ({
        sessionId: session.id,
        title: session.title,
        matchedMessage: session.preview,
        timestamp: session.modifiedAt.toISOString(),
        sessionKind: session.sessionKind,
      }));
  }




  async saveMemory(title: string, content: string, project: ProjectScopedMemoryOptions = {}): Promise<NoteEntry> {
    const filename = this.memoryFilenameForTitle(title);
    const projectRoot = normalizeMetadataString(project.projectRoot, MAX_PROJECT_ROOT_CHARS);
    const projectName = normalizeMetadataString(project.projectName, MAX_PROJECT_NAME_CHARS);
    const visibleContent = `# ${title}\n\n${content}\n`;
    const projectMarkers = [
      ...(projectRoot ? [`${MEMORY_PROJECT_ROOT_PREFIX} ${projectRoot} -->`] : []),
      ...(projectName ? [`${MEMORY_PROJECT_NAME_PREFIX} ${projectName} -->`] : []),
    ];
    const storedContent = [MEMORY_MARKER, ...projectMarkers, visibleContent].join("\n");
    const targetPath = join(this.memoryDir, filename);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(indexPath, async () => {
      writeFileSync(targetPath, storedContent, "utf-8");
      this.updateMemoryIndexLocked(indexPath, filename, title, content);
    });
    this.memoryIndex = this.readMemoryIndex();
    return {
      filename,
      title,
      content: visibleContent,
      updatedAt: new Date().toISOString(),
      ...(projectRoot ? { projectRoot } : {}),
      ...(projectName ? { projectName } : {}),
    };
  }

  /** Update memories/MEMORY.md. */
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
      const current = readUtf8FileIfPresent(targetPath) ?? "";
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
      const current = readUtf8FileIfPresent(targetPath) ?? getDefaultMemoryIndex();
      writeFileSync(targetPath, this.patchMemoryIndexSections(current, sections), "utf-8");
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  /** Delete a saved memory note. */
  async deleteMemory(filename: string): Promise<void> {
    const safeFilename = this.validateDeletableMemoryFilename(filename);
    const path = join(this.memoryDir, safeFilename);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(indexPath, async () => {
      unlinkIfPresent(path);
      this.removeMemoryIndexEntryLocked(safeFilename, indexPath);
    });
    this.memoryIndex = this.readMemoryIndex();
  }

  /** Update AGENTS.md. */
  async updateAgentsMd(content: string): Promise<void> {
    const targetPath = join(this.lvisDir, "AGENTS.md");
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, content, "utf-8");
    });
    this.agentsMd = content;
  }

  /** Update user-preferences.md. */
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
      const current = readUtf8FileIfPresent(targetPath) ?? "";
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

  /** Return the ~/.lvis directory path. */
  getDir(): string {
    return this.lvisDir;
  }

  // ─── Private ──────────────────────────────────────

  // ─── Session Persistence (~/.lvis/sessions/) ─

  /** Save a session in JSONL format. */
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
    this.indexSessionForSearch(sessionId, messages);
  }

  /**
   * Saves a freshly-imported conversation (#1500 / E3) as a brand-new
   * session — import is symmetric with `lvis:chat:export` but NEVER
   * overwrites an existing session; callers must pass a freshly minted
   * sessionId (e.g. `crypto.randomUUID()`), matching the `chat.fork`
   * handler's new-session pattern.
   */
  async saveImportedSession(sessionId: string, messages: unknown[]): Promise<void> {
    await this.saveSession(sessionId, messages);
    await this.saveSessionMetadata(sessionId, { sessionKind: "main" });
  }

  /**
   * Builds the FTS row input for one session from its messages + metadata,
   * or `null` when the session has no searchable text (caller should drop any
   * existing row instead of inserting an empty one). Pure — opens nothing.
   *
   * `timestamp` is sourced from the session JSONL's on-disk mtime (its actual
   * last-modified time), NOT the index-write wall clock. The search UI renders
   * this as the conversation's relative/absolute time; using index-time would
   * make every session show as "just now" after a boot-time reindex/rebuild.
   * Falls back to the current time only when the file mtime can't be read
   * (e.g. a from-memory upsert of a session not yet flushed to disk).
   */
  private buildIndexInput(sessionId: string, messages: unknown[]): IndexedSessionInput | null {
    const content = extractSearchableContent(messages);
    if (!content) return null;
    const metadata = this.loadSessionMetadata(sessionId);
    const summary = this.readSessionSummary(sessionId);
    const mtimeMs = this.getFileMtimeMs(join(this.sessionsDir, `${sessionId}.jsonl`));
    const timestamp = mtimeMs >= 0 ? new Date(mtimeMs).toISOString() : new Date().toISOString();
    return {
      sessionId,
      content,
      timestamp,
      sessionKind: metadata?.sessionKind ?? normalizeSessionKind(undefined),
      ...(metadata?.routineId ? { routineId: metadata.routineId } : {}),
      ...(metadata?.projectRoot ? { projectRoot: metadata.projectRoot } : {}),
      ...(summary.title ? { title: summary.title } : {}),
    };
  }

  /**
   * Incrementally upserts one session's FTS row (#1500 / E3). Per-op
   * open→upsert→close: the handle is NEVER held open across the call, so a
   * caller that deletes `lvisDir` right after `saveSession` (every test's
   * teardown; a domain-unit `rm -rf ~/.lvis/<feature>/`) is not blocked by an
   * open SQLite/WAL handle on Windows (EPERM). Best-effort: failures are
   * logged/swallowed inside `SessionSearchIndex` — the JSONL just written is
   * the source of truth, so a transient index failure never blocks session
   * persistence (No-Fallback applies to the *search path*, not to writes).
   */
  private indexSessionForSearch(sessionId: string, messages: unknown[]): void {
    if (!this.searchIndex.open()) return;
    try {
      const input = this.buildIndexInput(sessionId, messages);
      if (input) this.searchIndex.upsertSession(input);
      else this.searchIndex.deleteSession(sessionId);
    } finally {
      this.searchIndex.close();
    }
  }

  /**
   * Boot-time integrity check → rebuild-from-JSONL recovery path (#1500 /
   * E3, No-Fallback: this is the ONLY recovery path — search never falls
   * back to a linear scan when the index is corrupt or missing). Safe to
   * call every boot: a healthy index with rows already present is a no-op.
   * Leaves the index CLOSED on exit (no persistent handle — see
   * `indexSessionForSearch`); the sync `searchSessions` read path reopens on
   * demand.
   */
  async verifyOrRebuildSearchIndex(): Promise<void> {
    const opened = this.searchIndex.open();
    const sessionFiles = readdirIfPresent(this.sessionsDir).filter((f) => f.endsWith(".jsonl"));
    const needsRebuild = !opened || (this.searchIndex.rowCount() === 0 && sessionFiles.length > 0);
    if (!needsRebuild) {
      this.searchIndex.close();
      return;
    }
    log.info("search index rebuild starting (%d session file(s))", sessionFiles.length);
    if (opened) {
      this.searchIndex.close();
    }
    await SessionSearchIndex.deleteFile(this.searchIndex.getDbPath());
    if (!this.searchIndex.open()) {
      log.warn("search index rebuild failed: could not reopen index after reset");
      return;
    }
    try {
      // No clear() here: deleteFile() above removed the DB file entirely and the
      // reopen created a FRESH empty `sessions_fts` table (CREATE TABLE IF NOT
      // EXISTS on a new file), so there is nothing to clear — the call was dead.
      const UUID_RE = /^[0-9a-f-]{8,}$/i;
      for (const file of sessionFiles) {
        const stem = file.replace(".jsonl", "");
        if (!UUID_RE.test(stem)) continue;
        const messages = this.loadSession(stem);
        if (!Array.isArray(messages)) continue;
        // Keep the handle open across the whole rebuild loop (single
        // open/close) rather than per-session — this is the one bulk path.
        const input = this.buildIndexInput(stem, messages);
        if (input) this.searchIndex.upsertSession(input);
        else this.searchIndex.deleteSession(stem);
      }
      log.info("search index rebuild complete (%d row(s))", this.searchIndex.rowCount());
    } finally {
      this.searchIndex.close();
    }
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
    const raw = readUtf8FileIfPresent(snapshotPath);
    if (raw === null) return null;
    const lines = raw.trim().split("\n");
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

  /** Load a persisted session. */
  loadSession(sessionId: string): unknown[] | null {
    if (!isValidSessionId(sessionId)) return null;
    const path = join(this.sessionsDir, `${sessionId}.jsonl`);
    const raw = readUtf8FileIfPresent(path);
    if (raw === null) return null;
    const lines = raw.trim().split("\n");
    const messages: unknown[] = [];
    for (const line of lines.filter(Boolean)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        log.warn({ sessionId }, "skipping malformed session line");
      }
    }
    return this.recoverLatestCheckpointUserIfMissing(sessionId, messages);
  }

  private recoverLatestCheckpointUserIfMissing(sessionId: string, messages: unknown[]): unknown[] {
    if (messages.some(isRenderableUserRecord)) return messages;
    let metadata: SessionMetadata | null = null;
    try {
      metadata = this.loadSessionMetadata(sessionId);
    } catch {
      return messages;
    }
    const checkpoints = metadata?.checkpoints ?? [];
    const latestCompactNum = checkpoints
      .map((checkpoint) => checkpoint.compactNum)
      .filter((compactNum): compactNum is number =>
        typeof compactNum === "number" && Number.isInteger(compactNum) && compactNum >= 0,
      )
      .sort((a, b) => b - a)[0];
    if (latestCompactNum === undefined) return messages;

    const snapshot = this.loadCheckpointSnapshot(sessionId, latestCompactNum);
    if (!snapshot) return messages;
    const latestUser = findLatestRenderableUserRecord(snapshot);
    if (!latestUser) return messages;

    const firstNonBoundaryIndex = messages.findIndex((message) => !isCompactBoundaryRecord(message));
    const insertAt = firstNonBoundaryIndex < 0 ? messages.length : firstNonBoundaryIndex;
    return [
      ...messages.slice(0, insertAt),
      latestUser,
      ...messages.slice(insertAt),
    ];
  }

  loadToolResultArtifact(sessionId: string, toolUseId: string): ToolResultArtifact | null {
    if (!isValidSessionId(sessionId) || typeof toolUseId !== "string" || toolUseId.length === 0) {
      return null;
    }
    const paths = this.toolResultArtifactPaths(sessionId, toolUseId);
    try {
      const content = readUtf8FileIfPresent(paths.contentPath);
      const rawMeta = readUtf8FileIfPresent(paths.metaPath);
      if (content === null || rawMeta === null) return null;
      const meta = JSON.parse(rawMeta) as Record<string, unknown>;
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
	      const meta = isRecord(message.meta) ? message.meta : {};
	      if (normalizeArtifactUnavailable(meta.artifactUnavailable)) return message;
	      const artifact = this.loadToolResultArtifact(sessionId, message.toolUseId);
	      if (!artifact) return message;
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
      projectRoot: normalizeMetadataString(safe.projectRoot, MAX_PROJECT_ROOT_CHARS),
      projectName: normalizeMetadataString(safe.projectName, MAX_PROJECT_NAME_CHARS),
    };
    // Cap stored title to 20 chars.
    if (safe.title !== undefined && safe.title.length > 20) {
      safe = { ...safe, title: safe.title.slice(0, 20) };
    }
    await withFileLock(targetPath, async () => {
      writeFileSync(targetPath, JSON.stringify(safe, null, 2), "utf-8");
    });
    // Metadata (sessionKind/routineId/projectRoot/title) is denormalized into
    // the FTS row (#1500 / E3) — re-index whenever it changes, not just on
    // saveSession, otherwise a metadata-only update (the common create-then-
    // tag-metadata sequence) leaves the FTS row's scope fields stale and
    // `searchSessions`'s kind/routineId/projectRoot filters silently misclassify it.
    const messages = this.loadSession(sessionId);
    if (Array.isArray(messages)) {
      this.indexSessionForSearch(sessionId, messages);
    }
  }

  loadSessionMetadata(sessionId: string): SessionMetadata | null {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`loadSessionMetadata: invalid sessionId "${sessionId}"`);
    }
    const path = join(this.sessionsDir, `${sessionId}.meta.json`);
    try {
      const raw = readUtf8FileIfPresent(path);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
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
    try {
      const raw = readUtf8FileIfPresent(path);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
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

  /** List persisted sessions. */
  listSessions(input: number | ListSessionsOptions = Number.POSITIVE_INFINITY): SessionListEntry[] {
    const options: ListSessionsOptions = typeof input === "number" ? { limit: input } : input;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    return readdirIfPresent(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => {
        const stat = statPathIfPresent(join(this.sessionsDir, f));
        if (!stat) return [];
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
                ? t("be_memoryManager.sessionTitleWithRoutine", { routineTitle: metadata.routineTitle })
                : t("be_memoryManager.sessionTitleShort", { id: session.id.slice(0, 8) }),
              preview: t("be_memoryManager.sessionPreviewTooLarge"),
            }
          : this.readSessionSummary(session.id);
        return {
          id: session.id,
          modifiedAt: session.modifiedAt,
          sessionKind,
          title: metadata?.title || summary.title || metadata?.routineTitle || t("be_memoryManager.sessionTitleShort", { id: session.id.slice(0, 8) }),
          preview: summary.preview,
          routineId: metadata?.routineId,
          routineTitle: metadata?.routineTitle,
          routineFiredAt: metadata?.routineFiredAt,
          ...(metadata?.projectRoot ? { projectRoot: metadata.projectRoot } : {}),
          ...(metadata?.projectName ? { projectName: metadata.projectName } : {}),
          // Branch provenance — already loaded from metadata, no extra disk IO
          ...(metadata?.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
          ...(metadata?.branchedFromCompactNum !== undefined ? { branchedFromCompactNum: metadata.branchedFromCompactNum } : {}),
          ...(metadata?.branchedAt ? { branchedAt: metadata.branchedAt } : {}),
        };
      });
  }

  listSessionsPage(options: ListSessionsOptions = {}): SessionListEntry[] {
    const limit = Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit ?? 0))
      : Number.POSITIVE_INFINITY;
    const beforeTime = options.before?.getTime();
    const beforeId = options.beforeId;
    const afterTime = options.after?.getTime();
    return readdirIfPresent(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => {
        const stat = statPathIfPresent(join(this.sessionsDir, f));
        if (!stat) return [];
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
                ? t("be_memoryManager.sessionTitleWithRoutine", { routineTitle: metadata.routineTitle })
                : t("be_memoryManager.sessionTitleShort", { id: session.id.slice(0, 8) }),
              preview: t("be_memoryManager.sessionPreviewTooLarge"),
            }
          : this.readSessionSummary(session.id);
        return {
          id: session.id,
          modifiedAt: session.modifiedAt,
          sessionKind,
          title: metadata?.title || summary.title || metadata?.routineTitle || t("be_memoryManager.sessionTitleShort", { id: session.id.slice(0, 8) }),
          preview: summary.preview,
          routineId: metadata?.routineId,
          routineTitle: metadata?.routineTitle,
          routineFiredAt: metadata?.routineFiredAt,
          ...(metadata?.projectRoot ? { projectRoot: metadata.projectRoot } : {}),
          ...(metadata?.projectName ? { projectName: metadata.projectName } : {}),
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
   * Delete a session: JSONL, metadata, and sibling compact archives,
   * snapshots, sidecars, and diff-cache state.
   *
   * The compact pipeline stores oversized message fragments under
   * `sessions/<sessionId>/truncated/` and `sessions/.checkpoints/<sessionId>/`.
   * Remove those with the transcript so no orphaned fragments remain.
   */
  deleteSession(sessionId: string): void {
    if (!isValidSessionId(sessionId)) {
      log.warn({ sessionId }, "unsafe caller-provided sessionId rejected in deleteSession");
      return;
    }
    const jsonlPath = join(this.sessionsDir, `${sessionId}.jsonl`);
    unlinkIfPresent(jsonlPath);
    const metaPath = join(this.sessionsDir, `${sessionId}.meta.json`);
    unlinkIfPresent(metaPath);
    const sessionDir = join(this.sessionsDir, sessionId);
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`deleteSession: failed to remove session dir ${sessionDir}: ${(err as Error).message}`);
    }
    const checkpointSnapshotDir = join(this.checkpointsDir, sessionId);
    try {
      rmSync(checkpointSnapshotDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`deleteSession: failed to remove checkpoint snapshot dir ${checkpointSnapshotDir}: ${(err as Error).message}`);
    }
    const diffCacheDir = join(this.lvisDir, "diff-cache", sessionId);
    try {
      rmSync(diffCacheDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`deleteSession: failed to remove diff cache dir ${diffCacheDir}: ${(err as Error).message}`);
    }
    // Drop the session's FTS row too (#1500 / E3) — otherwise a deleted
    // session lingers as an orphaned, still-searchable hit. Per-op
    // open→delete→close (no persistent handle; mirrors indexSessionForSearch).
    if (this.searchIndex.open()) {
      try {
        this.searchIndex.deleteSession(sessionId);
      } finally {
        this.searchIndex.close();
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
  ): boolean {
    const byteLength = Buffer.byteLength(message.content, "utf8");
    if (byteLength > MAX_TOOL_RESULT_ARTIFACT_BYTES) {
      log.warn(
        {
          sessionId,
          toolUseId: message.toolUseId,
          byteLength,
          maxBytes: MAX_TOOL_RESULT_ARTIFACT_BYTES,
        },
        "tool_result artifact skipped because it exceeds the host storage cap",
      );
      return false;
    }
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
    return true;
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
      let artifactUnavailable = normalizeArtifactUnavailable(meta.artifactUnavailable);
      const hasStubPrefix = isToolResultStubContent(message.content);
      const isSerializedStub = hasStubPrefix && (meta.serializedStub === true || !truncated);

      if (truncated) {
        const paths = this.toolResultArtifactPaths(sessionId, message.toolUseId);
        if (!isSerializedStub) {
          if (this.writeToolResultArtifact(sessionId, message, truncated)) {
            keepArtifactKeys.add(paths.key);
            artifactUnavailable = null;
          } else {
            artifactUnavailable = {
              reason: "artifact-too-large",
              maxBytes: MAX_TOOL_RESULT_ARTIFACT_BYTES,
            };
          }
        } else if (!artifactUnavailable) {
          keepArtifactKeys.add(paths.key);
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
                ...(artifactUnavailable ? { artifactUnavailable } : {}),
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
              artifactUnavailable ? { artifactUnavailable } : undefined,
            );
      return {
        ...message,
        content,
        meta: {
          ...meta,
          ...(truncated ? { truncated } : {}),
          ...(artifactUnavailable ? { artifactUnavailable } : {}),
          serializedStub: true,
        },
      };
    });

    return { messages: prepared, keepArtifactKeys };
  }

  private cleanupToolResultArtifacts(sessionId: string, keepArtifactKeys: Set<string>): void {
    const dir = this.toolResultArtifactsDir(sessionId);
    const entries = readdirIfPresent(dir);
    if (entries.length === 0) return;
    const checkpointKeys = this.loadCheckpointToolResultArtifactKeys(sessionId);
    for (const entry of entries) {
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
    for (const entry of readdirIfPresent(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(dir, entry);
      try {
        const raw = readUtf8FileIfPresent(path);
        if (raw === null) continue;
        const lines = raw.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
	          if (!isToolResultRecord(parsed)) continue;
	          const meta = isRecord(parsed.meta) ? parsed.meta : {};
	          if (normalizeArtifactUnavailable(meta.artifactUnavailable)) continue;
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

    // Atomic create-if-absent: the exclusive "wx" flag fails with EEXIST when
    // the file already exists, so there is no check-then-write TOCTOU window.
    this.writeDefaultIfAbsent(join(this.lvisDir, "AGENTS.md"), getDefaultAgentsMd());
    this.writeDefaultIfAbsent(join(this.lvisDir, "user-preferences.md"), getDefaultUserPrefs());
    this.writeDefaultIfAbsent(join(this.memoryDir, "MEMORY.md"), getDefaultMemoryIndex());
  }

  /** Write `content` only when `path` does not yet exist, atomically (no TOCTOU). */
  private writeDefaultIfAbsent(path: string, content: string): void {
    try {
      writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  private readFile(name: string): string {
    const path = join(this.lvisDir, name);
    return readUtf8FileIfPresent(path) ?? "";
  }

  private readMemoryIndex(): string {
    const path = join(this.memoryDir, "MEMORY.md");
    const raw = readUtf8FileIfPresent(path);
    return raw === null ? "" : this.truncateMemoryIndex(raw);
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
      return statPathIfPresent(path)?.mtimeMs ?? -1;
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

  private readMarkdownEntries(dir: string, options: (ProjectScopedMemoryOptions & { excludeMarkedMemory?: boolean }) = {}): NoteEntry[] {
    return readdirIfPresent(dir)
      .filter((f) => f.endsWith(".md"))
      .flatMap((filename) => {
        const path = join(dir, filename);
        if (filename.toLowerCase() === "memory.md") return [];
        const snapshot = readUtf8FileSnapshotIfPresent(path);
        if (!snapshot || snapshot.tooLarge) return [];
        const rawContent = snapshot.content;
        if (options?.excludeMarkedMemory && this.hasMemoryMarker(rawContent)) return [];
        const project = this.parseMemoryProject(rawContent);
        if (!this.matchesMemoryProject(project, options)) return [];
        const content = this.stripInternalMarkers(rawContent);
        const titleMatch = content.match(/^#\s+(.+)/m);
        return [{
          filename,
          title: titleMatch?.[1] ?? filename.replace(".md", ""),
          content,
          updatedAt: snapshot.mtime.toISOString(),
          ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
          ...(project.projectName ? { projectName: project.projectName } : {}),
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
    return content
      .replace(/^<!--\s*lvis:kind=memory\s*-->\r?\n?/, "")
      .replace(/^<!--\s*lvis:project-root:[\s\S]*?-->\r?\n?/m, "")
      .replace(/^<!--\s*lvis:project-name:[\s\S]*?-->\r?\n?/m, "");
  }

  private parseMemoryProject(content: string): ProjectScopedMemoryOptions {
    const rootMatch = content.match(/^<!--\s*lvis:project-root:\s*([\s\S]*?)\s*-->/m);
    const nameMatch = content.match(/^<!--\s*lvis:project-name:\s*([\s\S]*?)\s*-->/m);
    const projectRoot = normalizeMetadataString(rootMatch?.[1], MAX_PROJECT_ROOT_CHARS);
    const projectName = normalizeMetadataString(nameMatch?.[1], MAX_PROJECT_NAME_CHARS);
    return {
      ...(projectRoot ? { projectRoot } : {}),
      ...(projectName ? { projectName } : {}),
    };
  }

  private matchesMemoryProject(project: ProjectScopedMemoryOptions, options: ProjectScopedMemoryOptions): boolean {
    if (!options.projectRoot) return true;
    return projectRootEquals(project.projectRoot, options.projectRoot) || (options.includeUnscoped === true && !project.projectRoot);
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
    const existing = readUtf8FileIfPresent(targetPath) ?? getDefaultMemoryIndex();
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
    next = this.ensureMemoryIndexSection(next, "Urgent Memory", t("be_memoryManager.urgentMemoryPlaceholder"));
    next = this.ensureMemoryIndexSection(next, "References", t("be_memoryManager.referencesPlaceholder"));
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
    const existing = readUtf8FileIfPresent(targetPath);
    if (existing === null) {
      this.memoryIndex = "";
      return;
    }
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
        title: t("be_memoryManager.sessionTitleShort", { id: sessionId.slice(0, 8) }),
        preview: t("be_memoryManager.sessionPreviewEmpty"),
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
      title: (lastUser || lastContent || t("be_memoryManager.sessionTitleShort", { id: sessionId.slice(0, 8) })).slice(0, 80),
      preview: (lastContent || lastUser || t("be_memoryManager.sessionPreviewEmpty")).slice(0, 200),
    };
  }

  private slugify(title: string): string {
    return title
      .toLowerCase()
      // Keep Hangul in user-authored memory titles while the source remains ASCII.
      .replace(/[^a-z0-9\uac00-\ud7a3\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "untitled";
  }
}
