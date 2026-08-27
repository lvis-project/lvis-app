



import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmSync, renameSync, watch, type FSWatcher } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import { t } from "../i18n/index.js";
import { projectRootEquals, projectRootKey } from "../shared/project-identity.js";
import { discoverProjectAgentsMd, type ProjectAgentsMd } from "./project-agents-md.js";
import { maskSensitiveData } from "../shared/dlp.js";
import { estimateTokens } from "../shared/token-estimate.js";
import {
  A2ATaskState,
  A2A_PROJECTED_TASK_STATE_VALUES,
  isA2ATerminalTaskState,
  type A2AProjectedTaskState,
} from "../shared/a2a.js";
import type { SubAgentSuspensionReason } from "../shared/subagent-events.js";
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
  defaultWorkspaceRoot?: string;
}

export interface NoteEntry {
  filename: string;
  title: string;
  content: string;
  updatedAt?: string;
  excerpt?: string;
  projectRoot?: string;
  projectName?: string;
  /** Stable lifecycle identity for v1 managed memories. */
  id?: string;
  kind?: MemoryKind;
  state?: MemoryState;
  source?: MemorySourceKind;
  createdAt?: string;
  confirmedAt?: string;
  expiresAt?: string;
  pinned?: boolean;
  derivation?: MemoryDerivationV1;
  capture?: MemoryCaptureV1;
}

export interface ProjectScopedMemoryOptions {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
}

/** A managed memory's purpose. Kept intentionally small so policy stays explicit. */
export type MemoryKind = "preference" | "constraint" | "fact" | "goal" | "reference" | "note";

/** Candidates are optional review-only records; only active memories may reach a model prompt. */
export type MemoryState = "candidate" | "active";

/** Provenance is recorded so later lifecycle policy can distinguish imports from direct user intent. */
export type MemorySourceKind = "user" | "assistant" | "import" | "capture";

/** The user intent that entered the host-owned LLM review path. */
export type MemoryCaptureTrigger = "automatic" | "explicit";

export type MemoryScope =
  | { type: "global" }
  | { type: "project"; projectRoot: string; projectName?: string };

/** Host-generated metadata for a derived note; source notes never carry it. */
interface MemoryDerivationV1 {
  v: 1;
  type: "consolidated-overview";
  sourceFingerprint: string;
  generatedAt: string;
}

/** Immutable provenance for a host-validated, LLM-refined automatic capture. */
interface MemoryCaptureV1 {
  v: 1;
  method: "llm-refined";
  /** Automatic post-turn capture versus an explicitly requested remembered note. */
  trigger: MemoryCaptureTrigger;
  /** SHA-256 of the trusted user text used as the review evidence. */
  sourceDigest: string;
  capturedAt: string;
}

/** Bounded, exact-scope source set used for one consolidation attempt. */
export interface MemoryConsolidationSnapshot {
  scope: MemoryScope;
  sources: readonly NoteEntry[];
  sourceFingerprint: string;
}

export type MemoryConsolidationUpsertResult =
  | { status: "updated"; entry: NoteEntry }
  | { status: "sources-changed" | "empty" };

/** Versioned, top-of-file metadata for a managed memory note. */
export interface MemoryMetadataV1 {
  v: 1;
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  state: MemoryState;
  source: MemorySourceKind;
  createdAt: string;
  confirmedAt?: string;
  expiresAt?: string;
  pinned?: true;
  derivation?: MemoryDerivationV1;
  capture?: MemoryCaptureV1;
}

/** Save-time lifecycle policy. Omitting projectRoot means explicit global long-term memory. */
export interface MemorySaveOptions extends ProjectScopedMemoryOptions {
  kind?: MemoryKind;
  state?: MemoryState;
  source?: MemorySourceKind;
  confirmedAt?: string;
  expiresAt?: string;
  pinned?: boolean;
  capture?: MemoryCaptureV1;
}

export interface MemoryReadOptions extends ProjectScopedMemoryOptions {
  /** Default false: candidates never appear in normal reads or prompt selection. */
  includeCandidates?: boolean;
  /** Restrict a management/refresh read to global long-term memories. */
  scope?: "all" | "global";
}

export interface MemorySelectionOptions extends ProjectScopedMemoryOptions {
  tokenBudget?: number;
  maxEntries?: number;
}

export interface MemorySelection {
  entries: NoteEntry[];
  context: string;
  usedTokens: number;
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

/**
 * One sub-agent row rebuilt from persisted metadata after a restart.
 *
 * Carries only what a panel ROW needs. The transcript is fetched separately,
 * on demand, by loading `childSessionId`.
 */
export interface RestoredSubAgentSession {
  /** Panel row identity; same id the live event stream uses. */
  spawnId: string;
  /** The child's session id — also its `resumeId` for `agent_spawn`. */
  childSessionId: string;
  title: string;
  modifiedAt: Date;
  /** Last durable A2A projection, when the child recorded one. */
  taskState?: A2AProjectedTaskState;
  /** Parent `agent_spawn` tool_use id that created this child. */
  toolUseId?: string;
}

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
  /** ISO time the user archived this conversation. Absent = not archived. */
  archivedAt?: string;
  /** ISO time the user marked it unread. Absent = read. */
  unreadSince?: string;
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
   * auto-derived title from session content. Capped on write at
   * MAX_SESSION_TITLE_CHARS, the same length the auto-derived title uses.
   */
  title?: string;
  /**
   * ISO timestamp of when the user archived this conversation. Absent means
   * not archived — the flag is the timestamp, so there is no second field to
   * fall out of step with it.
   */
  archivedAt?: string;
  /**
   * ISO timestamp of when the user marked this conversation unread. Absent
   * means read. This is a MANUAL mark, not a computed one: nothing sets it on
   * the user's behalf, so nothing has to clear it on their behalf either.
   */
  unreadSince?: string;
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
  /** Parent chat session or host-minted internal A2A origin bound to this child. */
  originSessionId?: string;
  /** Host-only A2A profile handler id. Never populated from remote context ids. */
  a2aWireHandlerId?: string;
  /** Host-minted A2A origin; must match originSessionId for wire-bound tasks. */
  a2aWireInternalOrigin?: string;
  /** Parent `agent_spawn` tool_use id that created this sub-agent. */
  originToolUseId?: string;
  /** Host-visible spawn id emitted on the live agent-spawn event stream. */
  spawnId?: string;
  /** User-visible sub-agent title. Stored separately from `title`, which is capped for session lists. */
  subAgentTitle?: string;
  /**
   * Number of budget continuations consumed by this sub-agent session.
   * MAX_RESUMES applies only to this counter.
   */
  budgetResumeCount?: number;
  /** Number of question answers accepted; independent from MAX_RESUMES. */
  questionAnswerCount?: number;
  /**
   * Legacy compatibility alias for budgetResumeCount. Old metadata may contain
   * only this field; the runner fail-closes on the greater compatible value.
   */
  resumeCount?: number;
  /**
   * Cumulative assistant rounds spent across the original spawn plus every
   * resume segment. Initialized to 0 on spawn (the spawn's own rounds are added
   * by the resume accounting in PR-C/PR-D). PR-D's cumulative-rounds ceiling
   * reads this so a long resume chain cannot exceed the global round budget.
   */
  cumulativeRounds?: number;
  /** Last durable A2A projection. Only INPUT_REQUIRED is resumable. */
  subAgentTaskState?: A2AProjectedTaskState;
  /** Typed resume axis paired with INPUT_REQUIRED. */
  subAgentSuspensionReason?: SubAgentSuspensionReason;
  /** DLP-masked, bounded prompt paired with an INPUT_REQUIRED suspension. */
  subAgentSuspensionPrompt?: string;
}

function asTerminalA2ATaskState(value: unknown): A2AProjectedTaskState | undefined {
  if (
    typeof value !== "string"
    || !(A2A_PROJECTED_TASK_STATE_VALUES as readonly string[]).includes(value)
  ) {
    return undefined;
  }
  const state = value as A2AProjectedTaskState;
  return isA2ATerminalTaskState(state) ? state : undefined;
}

function hasA2AWireIdentity(metadata: Partial<SessionMetadata>): boolean {
  return metadata.a2aWireHandlerId !== undefined
    || metadata.a2aWireInternalOrigin !== undefined;
}

interface DetachedWireTerminalTombstone {
  taskState: A2AProjectedTaskState;
  handlerId: string;
  internalOrigin: string;
  originSessionId: string;
  sourceTools: string[];
  subAgentTitle?: string;
}

function detachProjectBinding<T extends object>(
  metadata: T,
  terminalTombstone?: A2AProjectedTaskState,
): T {
  const next = { ...metadata } as T & Partial<SessionMetadata>;
  delete next.projectRoot;
  delete next.projectName;

  if (hasA2AWireIdentity(next)) {
    // Terminal A2A outcomes are immutable. A removed workspace cancels only a
    // live/waiting task; completed, failed, rejected, or already-canceled work
    // keeps its first terminal projection for host observation after restart.
    next.subAgentTaskState = asTerminalA2ATaskState(terminalTombstone)
      ?? asTerminalA2ATaskState(next.subAgentTaskState)
      ?? A2ATaskState.CANCELED;
    delete next.subAgentSuspensionReason;
    delete next.subAgentSuspensionPrompt;
  }

  return next;
}

function applyDetachedWireTerminalTombstone<T extends object>(
  metadata: T,
  tombstone: DetachedWireTerminalTombstone,
): T {
  return detachProjectBinding(
    {
      ...metadata,
      sessionKind: "subagent",
      sourceTools: [...tombstone.sourceTools],
      originSessionId: tombstone.originSessionId,
      a2aWireHandlerId: tombstone.handlerId,
      a2aWireInternalOrigin: tombstone.internalOrigin,
      ...(tombstone.subAgentTitle !== undefined
        ? { subAgentTitle: tombstone.subAgentTitle }
        : {}),
    },
    tombstone.taskState,
  );
}

const MEMORY_MARKER = "<!-- lvis:kind=memory -->";
const MEMORY_PROJECT_ROOT_PREFIX = "<!-- lvis:project-root:";
const MEMORY_PROJECT_NAME_PREFIX = "<!-- lvis:project-name:";
const MEMORY_METADATA_PREFIX = "<!-- lvis:memory-meta:";
const MEMORY_METADATA_SUFFIX = " -->";
const MAX_MANAGED_MEMORY_FILE_BYTES = 64 * 1024;
// Legacy notes predate the managed V1 write ceiling. Preserve their readable
// history while keeping a bounded main-process read; V1 files still fail closed
// when they exceed the smaller managed ceiling.
const MAX_LEGACY_MEMORY_FILE_BYTES = 512 * 1024;
const DEFAULT_MEMORY_SELECTION_TOKEN_BUDGET = 1_000;
const DEFAULT_MEMORY_SELECTION_MAX_ENTRIES = 6;
const MAX_PROMPT_MEMORY_INDEX_TOKENS = 400;
const MAX_PROMPT_USER_PREFERENCES_TOKENS = 600;
const MAX_MEMORY_SELECTION_ENTRY_TOKENS = 320;
const MAX_MANAGED_MEMORY_TITLE_CHARS = 120;
/**
 * Cap for a stored session title.
 *
 * 80, not 20. The auto-derived title (readSessionSummary) already slices at 80,
 * so a 20-char cap meant a title the user TYPED was held to a quarter of what
 * the same row displayed when nobody typed anything — and 20 characters is a
 * few words of Korean. One number now governs both.
 */
const MAX_SESSION_TITLE_CHARS = 80;
const MAX_MANAGED_MEMORY_CONTENT_CHARS = 8_000;
const MAX_CONSOLIDATION_SOURCE_NOTES = 16;
const MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_TOKENS = 400;
const MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_SCOPE_TOKENS = 190;
const MEMORY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMORY_KINDS = new Set<MemoryKind>([
  "preference", "constraint", "fact", "goal", "reference", "note",
]);
const MEMORY_STATES = new Set<MemoryState>(["candidate", "active"]);
const MEMORY_CAPTURE_TRIGGERS = new Set<MemoryCaptureTrigger>(["automatic", "explicit"]);
const MEMORY_SOURCES = new Set<MemorySourceKind>(["user", "assistant", "import", "capture"]);


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
const MAX_A2A_WIRE_ID_CHARS = 256;
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
function isValidA2AWireMetadataId(id: unknown): id is string {
  return isValidSessionId(id)
    && id.length <= MAX_A2A_WIRE_ID_CHARS
    && maskSensitiveData(id).detections.length === 0;
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

interface ParsedMemoryNote {
  content: string;
  metadata?: MemoryMetadataV1;
  legacyProject: ProjectScopedMemoryOptions;
  /** A v1-looking header that cannot be validated must never fall back to global legacy scope. */
  invalidMetadata: boolean;
}

function isValidMemoryTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && Number.isFinite(Date.parse(value));
}

function normalizeMemoryCapture(value: unknown): MemoryCaptureV1 | null {
  if (
    !isRecord(value)
    || value.v !== 1
    || value.method !== "llm-refined"
    || !MEMORY_CAPTURE_TRIGGERS.has(value.trigger as MemoryCaptureTrigger)
    || typeof value.sourceDigest !== "string"
    || !/^[a-f0-9]{64}$/i.test(value.sourceDigest)
    || !isValidMemoryTimestamp(value.capturedAt)
  ) {
    return null;
  }
  return {
    v: 1,
    method: "llm-refined",
    trigger: value.trigger as MemoryCaptureTrigger,
    sourceDigest: value.sourceDigest.toLowerCase(),
    capturedAt: value.capturedAt,
  };
}

/**
 * Capture provenance is meaningful only for its owning write path. This keeps
 * raw/manual records separate from reviewed automatic and explicit records.
 */
function hasValidCaptureSourceCombination(
  source: MemorySourceKind,
  capture: MemoryCaptureV1 | undefined,
  derivation?: MemoryDerivationV1,
): boolean {
  if (capture && derivation) return false;
  if (!capture) return source !== "capture";
  return capture.trigger === "automatic"
    ? source === "capture"
    : source === "user";
}

function decodeMemoryMetadata(encoded: string): MemoryMetadataV1 | null {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(encoded)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1 || !MEMORY_ID_PATTERN.test(String(raw.id ?? ""))) return null;
  if (!MEMORY_KINDS.has(raw.kind as MemoryKind) || !MEMORY_STATES.has(raw.state as MemoryState)) return null;
  if (!MEMORY_SOURCES.has(raw.source as MemorySourceKind) || !isValidMemoryTimestamp(raw.createdAt)) return null;
  if (raw.confirmedAt !== undefined && !isValidMemoryTimestamp(raw.confirmedAt)) return null;
  if (raw.expiresAt !== undefined && !isValidMemoryTimestamp(raw.expiresAt)) return null;
  if (raw.pinned !== undefined && raw.pinned !== true) return null;
  if (!isRecord(raw.scope)) return null;

  let derivation: MemoryDerivationV1 | undefined;
  if (raw.derivation !== undefined) {
    if (
      !isRecord(raw.derivation)
      || raw.derivation.v !== 1
      || raw.derivation.type !== "consolidated-overview"
      || typeof raw.derivation.sourceFingerprint !== "string"
      || !/^[a-f0-9]{64}$/i.test(raw.derivation.sourceFingerprint)
      || !isValidMemoryTimestamp(raw.derivation.generatedAt)
    ) {
      return null;
    }
    derivation = {
      v: 1,
      type: "consolidated-overview",
      sourceFingerprint: raw.derivation.sourceFingerprint.toLowerCase(),
      generatedAt: raw.derivation.generatedAt,
    };
  }

  const decodedCapture = raw.capture === undefined ? undefined : normalizeMemoryCapture(raw.capture);
  if (raw.capture !== undefined && !decodedCapture) return null;
  const capture = decodedCapture ?? undefined;
  if (!hasValidCaptureSourceCombination(raw.source as MemorySourceKind, capture, derivation)) return null;

  let scope: MemoryScope;
  if (raw.scope.type === "global") {
    scope = { type: "global" };
  } else if (raw.scope.type === "project") {
    const projectRoot = normalizeMetadataString(raw.scope.projectRoot, MAX_PROJECT_ROOT_CHARS);
    const projectName = normalizeMetadataString(raw.scope.projectName, MAX_PROJECT_NAME_CHARS);
    if (!projectRoot || (typeof raw.scope.projectRoot === "string" && raw.scope.projectRoot.trim().length > MAX_PROJECT_ROOT_CHARS)) {
      return null;
    }
    if (typeof raw.scope.projectName === "string" && raw.scope.projectName.trim().length > MAX_PROJECT_NAME_CHARS) return null;
    scope = { type: "project", projectRoot, ...(projectName ? { projectName } : {}) };
  } else {
    return null;
  }

  return {
    v: 1,
    id: raw.id as string,
    scope,
    kind: raw.kind as MemoryKind,
    state: raw.state as MemoryState,
    source: raw.source as MemorySourceKind,
    createdAt: raw.createdAt as string,
    ...(raw.confirmedAt ? { confirmedAt: raw.confirmedAt as string } : {}),
    ...(raw.expiresAt ? { expiresAt: raw.expiresAt as string } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
    ...(derivation ? { derivation } : {}),
    ...(capture ? { capture } : {}),
  };
}

function encodeMemoryMetadata(metadata: MemoryMetadataV1): string {
  return Buffer.from(JSON.stringify(metadata), "utf-8").toString("base64url");
}

function noteIsExpired(note: Pick<NoteEntry, "expiresAt">, now = Date.now()): boolean {
  return note.expiresAt !== undefined && Date.parse(note.expiresAt) <= now;
}

function memoryTextTerms(query: string): string[] {
  const terms = query.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return Array.from(new Set(terms)).slice(0, 16);
}

function truncateTextToTokenBudget(value: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || value.trim() === "") return "";
  if (estimateTokens(value) <= tokenBudget) return value;
  const targetChars = Math.max(48, Math.floor(value.length * tokenBudget / estimateTokens(value)) - 1);
  return `${value.slice(0, targetChars).trimEnd()}…`;
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
  const originSessionId = isValidSessionId(raw.originSessionId) ? raw.originSessionId : undefined;
  const subAgentTaskState = typeof raw.subAgentTaskState === "string"
    && (A2A_PROJECTED_TASK_STATE_VALUES as readonly string[]).includes(raw.subAgentTaskState)
    ? raw.subAgentTaskState as A2AProjectedTaskState
    : undefined;
  const hasA2AWireHandlerId = raw.a2aWireHandlerId !== undefined;
  const hasA2AWireInternalOrigin = raw.a2aWireInternalOrigin !== undefined;
  let a2aWireHandlerId: string | undefined;
  let a2aWireInternalOrigin: string | undefined;
  const isDetachedA2AWireTask = projectRoot === undefined
    && subAgentTaskState !== undefined
    && isA2ATerminalTaskState(subAgentTaskState)
    && raw.subAgentSuspensionReason === undefined
    && raw.subAgentSuspensionPrompt === undefined;
  if (hasA2AWireHandlerId || hasA2AWireInternalOrigin) {
    if (
      !hasA2AWireHandlerId
      || !hasA2AWireInternalOrigin
      || !isValidA2AWireMetadataId(raw.a2aWireHandlerId)
      || !isValidA2AWireMetadataId(raw.a2aWireInternalOrigin)
      || raw.a2aWireInternalOrigin !== originSessionId
      || (projectRoot === undefined && !isDetachedA2AWireTask)
      || !Array.isArray(raw.sourceTools)
      || !raw.sourceTools.every((tool) =>
        typeof tool === "string" && tool.length > 0 && tool.length <= 256)
    ) {
      throw new Error("invalid A2A wire binding metadata (a2a-wire-binding-invalid)");
    }
    a2aWireHandlerId = raw.a2aWireHandlerId;
    a2aWireInternalOrigin = raw.a2aWireInternalOrigin;
  }
  const originToolUseId = normalizeMetadataString(raw.originToolUseId, 256);
  const spawnId = normalizeMetadataString(raw.spawnId, 128);
  const subAgentTitle = normalizeMetadataString(raw.subAgentTitle, MAX_PROJECT_NAME_CHARS);
  const resumeCount = typeof raw.resumeCount === "number" && Number.isInteger(raw.resumeCount) && raw.resumeCount >= 0
    ? raw.resumeCount
    : undefined;
  const budgetResumeCount = typeof raw.budgetResumeCount === "number" && Number.isInteger(raw.budgetResumeCount) && raw.budgetResumeCount >= 0
    ? raw.budgetResumeCount
    : undefined;
  const questionAnswerCount = typeof raw.questionAnswerCount === "number" && Number.isInteger(raw.questionAnswerCount) && raw.questionAnswerCount >= 0
    ? raw.questionAnswerCount
    : undefined;
  const cumulativeRounds = typeof raw.cumulativeRounds === "number" && Number.isInteger(raw.cumulativeRounds) && raw.cumulativeRounds >= 0
    ? raw.cumulativeRounds
    : undefined;
  const subAgentSuspensionReason = raw.subAgentSuspensionReason === "budget"
    || raw.subAgentSuspensionReason === "question"
    ? raw.subAgentSuspensionReason
    : undefined;
  const subAgentSuspensionPrompt = normalizeMetadataString(
    raw.subAgentSuspensionPrompt,
    MAX_SUMMARY_PREAMBLE_CHARS,
  );
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
    // Stored title (capped on write; cap defensively on read too)
    title: rawTitle && rawTitle.length > 0 ? rawTitle.slice(0, MAX_SESSION_TITLE_CHARS) : undefined,
    // Checkpoint branch provenance fields.
    branchedFromCompactNum: rawBranchedFromCompactNum,
    branchedAt: rawBranchedAt,
    // Sub-agent resume metadata (PR-B).
    sourceTools: a2aWireHandlerId !== undefined
      ? sourceTools
      : sourceTools && sourceTools.length > 0
        ? sourceTools
        : undefined,
    profileModel,
    profileMode,
    originSessionId,
    a2aWireHandlerId,
    a2aWireInternalOrigin,
    originToolUseId,
    spawnId,
    subAgentTitle,
    budgetResumeCount,
    questionAnswerCount,
    resumeCount,
    cumulativeRounds,
    subAgentTaskState,
    subAgentSuspensionReason,
    subAgentSuspensionPrompt,
    archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : undefined,
    unreadSince: typeof raw.unreadSince === "string" ? raw.unreadSince : undefined,
  };
}

export class MemoryManager {
  private readonly lvisDir: string;
  private readonly memoryDir: string;
  private readonly sessionsDir: string;
  private readonly defaultWorkspaceRoot: string | undefined;
  /** FTS5 cross-session search index (#1500) — one per MemoryManager instance,
   *  keyed by this.lvisDir (never a global singleton; mirrors sessionsDir). */
  private readonly searchIndex: SessionSearchIndex;
  /**
   * Roots explicitly detached from persisted sessions. The guard prevents a
   * late metadata writer holding a pre-detach snapshot from resurrecting a
   * removed project binding while that root is absent. Re-adding the same root
   * clears this root-wide guard so NEW sessions can bind to it again.
   */
  private readonly detachedProjectRoots = new Set<string>();
  /**
   * Session-scoped tombstones survive a root re-add for the lifetime of this
   * manager. They distinguish a detached, pre-removal session from a genuinely
   * new session created after re-add, so a late writer cannot partially restore
   * old project groupings.
   */
  private readonly detachedProjectRootsBySession = new Map<string, Set<string>>();
  /**
   * Monotonic root policy generation. Capturing this before lock acquisition
   * detects detach -> allow ABA cycles even when the root-wide guard is clear
   * again by the time a stale writer finally enters the critical section.
   */
  private readonly projectRootGenerations = new Map<string, number>();
  /**
   * First terminal outcome owned by a detached wire session. The binding and
   * state are retained together so a late writer cannot regress the outcome,
   * swap handlers, or downgrade the task into an ordinary resumable sub-agent.
   */
  private readonly detachedWireTerminalTombstones = new Map<string, DetachedWireTerminalTombstone>();
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
    this.defaultWorkspaceRoot = normalizeMetadataString(
      options?.defaultWorkspaceRoot,
      MAX_PROJECT_ROOT_CHARS,
    );
    this.searchIndex = new SessionSearchIndex(this.lvisDir);
    this.ensureStructure();
  }

  private projectRootGeneration(key: string): number {
    return this.projectRootGenerations.get(key) ?? 0;
  }

  /**
   * Stable coordination target for metadata save/detach/delete.
   *
   * Locking the metadata file itself is unsafe because withFileLock must touch
   * a missing target before acquisition. A delete between detach's directory
   * snapshot and lock acquisition could therefore recreate the deleted path.
   * This sidecar survives session deletion and gives all three operations one
   * inode-independent serialization point.
   */
  private sessionMetadataLockPath(sessionId: string): string {
    return join(this.sessionsDir, ".metadata-locks", `${sessionId}.target`);
  }

  private bumpProjectRootGeneration(key: string): void {
    this.projectRootGenerations.set(key, this.projectRootGeneration(key) + 1);
  }

  private rememberDetachedWireTerminal(
    sessionId: string,
    metadata: Partial<SessionMetadata>,
  ): DetachedWireTerminalTombstone | undefined {
    const existing = this.detachedWireTerminalTombstones.get(sessionId);
    if (existing) return existing;

    const taskState = asTerminalA2ATaskState(metadata.subAgentTaskState);
    if (
      taskState === undefined
      || typeof metadata.a2aWireHandlerId !== "string"
      || typeof metadata.a2aWireInternalOrigin !== "string"
      || typeof metadata.originSessionId !== "string"
      || metadata.a2aWireInternalOrigin !== metadata.originSessionId
      || !Array.isArray(metadata.sourceTools)
    ) {
      return undefined;
    }
    const tombstone: DetachedWireTerminalTombstone = {
      taskState,
      handlerId: metadata.a2aWireHandlerId,
      internalOrigin: metadata.a2aWireInternalOrigin,
      originSessionId: metadata.originSessionId,
      sourceTools: [...metadata.sourceTools],
      ...(metadata.subAgentTitle !== undefined
        ? { subAgentTitle: metadata.subAgentTitle }
        : {}),
    };
    this.detachedWireTerminalTombstones.set(sessionId, tombstone);
    return tombstone;
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

  /** Single-entry, stat-revalidated cache for the active project's AGENTS.md. */
  private projectAgentsMdCache: { root: string; sig: number; value: ProjectAgentsMd } | null = null;

  /**
   * Committed project AGENTS.md discovered at `projectRoot`. Re-discovered when
   * the file's mtime changes (single-entry cache; a project switch changes the
   * root and re-discovers), so an edit is visible on the next turn build with no
   * fs.watch lifecycle to manage across project switches — unlike the global
   * file's watcher. Returns empty layers when the file is absent.
   */
  getProjectAgentsMd(projectRoot: string): ProjectAgentsMd {
    const root = resolve(projectRoot);
    const sig = this.getFileMtimeMs(join(root, "AGENTS.md"));
    const cached = this.projectAgentsMdCache;
    if (cached && cached.root === root && cached.sig === sig) return cached.value;
    const value = discoverProjectAgentsMd(root);
    this.projectAgentsMdCache = { root, sig, value };
    return value;
  }

  getMemoryIndex(options: ProjectScopedMemoryOptions = {}): string {
    if (options.projectRoot) return "";
    return this.memoryIndex;
  }

  /**
   * Prompt-only view of the global index. Saved-memory links are navigation
   * metadata, not model context; selected note bodies are injected separately.
   */
  getPromptMemoryIndex(): string {
    return truncateTextToTokenBudget(this.withoutSavedMemoryIndexEntries(this.memoryIndex), MAX_PROMPT_MEMORY_INDEX_TOKENS);
  }

  getUserPreferences(): string {
    return this.userPreferences;
  }

  /** Bounded prompt view; the on-disk profile remains available to its editor. */
  getPromptUserPreferences(): string {
    return truncateTextToTokenBudget(this.userPreferences, MAX_PROMPT_USER_PREFERENCES_TOKENS);
  }

  /**
   * Returns the bounded active source set for exactly one scope. A project
   * snapshot never contains global or another project's notes; callers that
   * need both scopes create two snapshots explicitly.
   */
  getConsolidationSnapshot(options: ProjectScopedMemoryOptions = {}): MemoryConsolidationSnapshot {
    return this.getConsolidationSnapshotForScope(this.consolidationScopeFromOptions(options));
  }

  /**
   * Reads a derived overview only when the exact bounded source fingerprint is
   * still current. A stale overview is intentionally suppressed rather than
   * injected into a prompt.
   */
  getConsolidatedMemoryOverview(snapshot: MemoryConsolidationSnapshot): NoteEntry | undefined {
    if (!this.isValidConsolidationSnapshot(snapshot)) return undefined;
    const current = this.getConsolidationSnapshotForScope(snapshot.scope);
    if (current.sources.length === 0 || current.sourceFingerprint !== snapshot.sourceFingerprint) {
      return undefined;
    }
    const overview = this.findConsolidatedMemoryOverview(snapshot.scope);
    return overview?.derivation?.sourceFingerprint === snapshot.sourceFingerprint
      ? overview
      : undefined;
  }

  /**
   * Bounded prompt-only view of current global plus (when selected) exact
   * project overviews. Generated summaries never enter normal memory
   * selection, so this is their only prompt path.
   */
  getPromptLongTermMemoryOverview(options: ProjectScopedMemoryOptions = {}): string {
    const globalSnapshot = this.getConsolidationSnapshot();
    const projectSnapshot = this.getConsolidationSnapshot(options);
    const globalOverview = this.getConsolidatedMemoryOverview(globalSnapshot);
    const globalSection = globalOverview
      ? `### ${globalOverview.title}\n${this.memoryBodyForPrompt(globalOverview)}`
      : "";

    // The default workspace intentionally exposes global memory only. For an
    // explicit project, give both valid scopes a bounded share so a large
    // global overview cannot starve project context (or the reverse).
    if (projectSnapshot.scope.type !== "project") {
      return truncateTextToTokenBudget(globalSection, MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_TOKENS);
    }
    const projectOverview = this.getConsolidatedMemoryOverview(projectSnapshot);
    const projectSection = projectOverview
      ? `### ${projectOverview.title}\n${this.memoryBodyForPrompt(projectOverview)}`
      : "";
    if (!globalSection || !projectSection) {
      return truncateTextToTokenBudget(
        globalSection || projectSection,
        MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_TOKENS,
      );
    }
    return [
      truncateTextToTokenBudget(globalSection, MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_SCOPE_TOKENS),
      truncateTextToTokenBudget(projectSection, MAX_PROMPT_LONG_TERM_MEMORY_OVERVIEW_SCOPE_TOKENS),
    ].join("\n\n---\n\n");
  }

  /**
   * Compare-and-swap write for a generated overview. The same index lock as
   * normal memory writes guards a re-read of the exact source snapshot, so a
   * model result can never overwrite an overview after its inputs changed.
   */
  async upsertConsolidatedMemoryIfUnchanged(
    snapshot: MemoryConsolidationSnapshot,
    content: string,
  ): Promise<MemoryConsolidationUpsertResult> {
    if (!this.isValidConsolidationSnapshot(snapshot)) {
      throw new Error("upsertConsolidatedMemoryIfUnchanged: invalid snapshot");
    }
    const title = this.consolidatedOverviewTitle(snapshot.scope);
    const input = this.assertManagedMemoryInput(title, content);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let result: MemoryConsolidationUpsertResult = { status: "sources-changed" };

    await withFileLock(indexPath, async () => {
      const current = this.getConsolidationSnapshotForScope(snapshot.scope);
      if (current.sources.length === 0) {
        result = { status: "empty" };
        return;
      }
      if (current.sourceFingerprint !== snapshot.sourceFingerprint) return;

      const existing = this.findConsolidatedMemoryOverview(snapshot.scope);
      const now = new Date().toISOString();
      const metadata: MemoryMetadataV1 = {
        v: 1,
        id: existing?.id ?? randomUUID(),
        scope: snapshot.scope,
        kind: "reference",
        state: "active",
        source: "assistant",
        createdAt: existing?.createdAt ?? now,
        confirmedAt: now,
        derivation: {
          v: 1,
          type: "consolidated-overview",
          sourceFingerprint: snapshot.sourceFingerprint,
          generatedAt: now,
        },
      };
      const filename = existing?.filename ?? this.allocateMemoryFilename(input.title, metadata.id);
      const visibleContent = `# ${input.title}\n\n${input.content}\n`;
      const storedContent = [
        MEMORY_MARKER,
        `${MEMORY_METADATA_PREFIX}${encodeMemoryMetadata(metadata)}${MEMORY_METADATA_SUFFIX}`,
        visibleContent,
      ].join("\n");
      writeFileSync(join(this.memoryDir, filename), storedContent, "utf-8");
      // Generated overviews have their own bounded prompt section and must not
      // appear in MEMORY.md navigation/index or ordinary note selection.
      this.removeMemoryIndexEntryLocked(filename, indexPath);
      result = {
        status: "updated",
        entry: this.entryFromMemoryMetadata(filename, input.title, visibleContent, metadata, now),
      };
    });

    this.memoryIndex = this.readMemoryIndex();
    return result;
  }

  listMemoryEntries(options: MemoryReadOptions = {}): NoteEntry[] {
    return this.readMarkdownEntries(this.memoryDir, options);
  }

  /**
   * Global long-term memories plus unscoped legacy records. Project-scoped V1
   * memories never cross this boundary into profile refresh or global views.
   */
  listGlobalMemoryEntries(options: Pick<MemoryReadOptions, "includeCandidates"> = {}): NoteEntry[] {
    return this.listMemoryEntries(options).filter((entry) => !entry.projectRoot);
  }

  /** Candidates are review-only and never enter normal prompt/list reads. */
  listMemoryCandidates(options: ProjectScopedMemoryOptions = {}): NoteEntry[] {
    // A detached/global review surface must never enumerate every project's
    // candidates. With a project scope, global candidates plus that exact
    // project are visible; without one, only global candidates are visible.
    return this.readMarkdownEntries(this.memoryDir, {
      includeCandidates: true,
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      ...(options.projectName ? { projectName: options.projectName } : {}),
    })
      .filter((entry) => entry.state === "candidate" && this.matchesCandidateReviewScope(entry, options));
  }


  searchMemoryEntries(query: string, options: MemoryReadOptions = {}): NoteEntry[] {
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
    return this.buildMarkdownContext(
      this.listMemoryEntries(options).filter((entry) => !this.isDerivedMemory(entry)),
    );
  }



  /**
   * Deterministically select active memories for one request. It is deliberately
   * query-aware: a project can have years of history without every note becoming
   * a permanent system-prompt tax.
   */
  selectRelevantMemories(query: string, options: MemorySelectionOptions = {}): MemorySelection {
    const tokenBudget = Math.max(1, Math.min(options.tokenBudget ?? DEFAULT_MEMORY_SELECTION_TOKEN_BUDGET, 8_000));
    const maxEntries = Math.max(1, Math.min(options.maxEntries ?? DEFAULT_MEMORY_SELECTION_MAX_ENTRIES, 24));
    const entries = this.listMemoryEntries({
      projectRoot: options.projectRoot,
      projectName: options.projectName,
      includeUnscoped: options.includeUnscoped,
    }).filter((entry) => this.isPromptVisibleMemory(entry, options));
    const terms = memoryTextTerms(query);
    const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase();
    const ranked = entries
      .flatMap((entry) => {
        const title = entry.title.normalize("NFKC").toLocaleLowerCase();
        const content = entry.content.normalize("NFKC").toLocaleLowerCase();
        let score = entry.pinned ? 8 : 0;
        if (terms.length === 0) return entry.pinned ? [{ entry, score }] : [];
        for (const term of terms) {
          if (title.includes(term)) score += 18;
          if (content.includes(term)) score += 5;
        }
        if (normalizedQuery.length >= 2 && title.includes(normalizedQuery)) score += 12;
        if (normalizedQuery.length >= 2 && content.includes(normalizedQuery)) score += 4;
        return score > 0 ? [{ entry, score }] : [];
      })
      .sort((left, right) =>
        right.score - left.score
        || Number(right.entry.pinned === true) - Number(left.entry.pinned === true)
        || String(right.entry.updatedAt ?? "").localeCompare(String(left.entry.updatedAt ?? ""))
        || left.entry.filename.localeCompare(right.entry.filename),
      );

    const selected: NoteEntry[] = [];
    const sections: string[] = [];
    for (const { entry } of ranked) {
      if (selected.length >= maxEntries) break;
      const separator = sections.length > 0 ? "\n\n---\n\n" : "";
      const existing = sections.join("\n\n---\n\n");
      const remaining = tokenBudget - estimateTokens(existing) - estimateTokens(separator);
      if (remaining < 16) break;
      const heading = `### ${entry.title}\n`;
      const fullSection = `${heading}${this.memoryBodyForPrompt(entry)}`;
      const sectionBudget = Math.min(MAX_MEMORY_SELECTION_ENTRY_TOKENS, remaining);
      const section = estimateTokens(fullSection) <= sectionBudget
        ? fullSection
        : `${heading}${truncateTextToTokenBudget(this.memoryBodyForPrompt(entry), sectionBudget - estimateTokens(heading))}`;
      if (section.trim() === "" || estimateTokens(section) > remaining) continue;
      selected.push(entry);
      sections.push(section);
    }

    const context = sections.join("\n\n---\n\n");
    return { entries: selected, context, usedTokens: context ? estimateTokens(context) : 0 };
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




  async saveMemory(title: string, content: string, options: MemorySaveOptions = {}): Promise<NoteEntry> {
    const input = this.assertManagedMemoryInput(title, content);
    let metadata = this.createMemoryMetadata(options);
    const visibleContent = `# ${input.title}\n\n${input.content}\n`;
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let filename = "";

    await withFileLock(indexPath, async () => {
      const existing = this.findExistingManagedMemory(
        input.title,
        metadata.scope,
        metadata.state,
        metadata.source,
        metadata.capture?.trigger,
      );
      if (existing) {
        // Lifecycle state and provenance are collision boundaries. A save
        // may update only a record with the same state and source, so a
        // local automation, user edit, or import can never overwrite one
        // another just because the titles happen to match.
        const mustPreserveExisting =
          metadata.state !== existing.metadata.state
          || metadata.source !== existing.metadata.source
          || metadata.capture?.trigger !== existing.metadata.capture?.trigger;
        if (mustPreserveExisting) {
          filename = this.allocateMemoryFilename(input.title, metadata.id);
        } else {
          filename = existing.filename;
          metadata = this.mergeExistingMemoryMetadata(existing.metadata, metadata, options);
        }
      } else {
        filename = this.allocateMemoryFilename(input.title, metadata.id);
      }

      const storedContent = [
        MEMORY_MARKER,
        `${MEMORY_METADATA_PREFIX}${encodeMemoryMetadata(metadata)}${MEMORY_METADATA_SUFFIX}`,
        visibleContent,
      ].join("\n");
      writeFileSync(join(this.memoryDir, filename), storedContent, "utf-8");
      if (metadata.scope.type === "global" && metadata.state === "active") {
        this.updateMemoryIndexLocked(indexPath, filename, input.title, input.content);
      } else {
        this.removeMemoryIndexEntryLocked(filename, indexPath);
      }
    });

    this.memoryIndex = this.readMemoryIndex();
    return this.entryFromMemoryMetadata(filename, input.title, visibleContent, metadata, new Date().toISOString());
  }

  /** Update memories/MEMORY.md. */
  /**
   * Promote a reviewed candidate by immutable identity. The review scope is
   * checked against the stored metadata under the same lock as the write.
   */
  async activateMemoryCandidate(
    id: string,
    options: ProjectScopedMemoryOptions = {},
  ): Promise<NoteEntry> {
    const safeId = this.validateManagedMemoryId(id, "activateMemoryCandidate");
    const indexPath = join(this.memoryDir, "MEMORY.md");
    let activated: NoteEntry | undefined;

    await withFileLock(indexPath, async () => {
      const found = this.findManagedMemoryById(safeId);
      if (
        !found
        || found.metadata.state !== "candidate"
        || !this.memoryScopeVisibleForCandidateReview(found.metadata.scope, options)
      ) {
        throw new Error("activateMemoryCandidate: candidate not found");
      }

      const metadata: MemoryMetadataV1 = {
        ...found.metadata,
        state: "active",
        confirmedAt: new Date().toISOString(),
      };
      const storedContent = [
        MEMORY_MARKER,
        `${MEMORY_METADATA_PREFIX}${encodeMemoryMetadata(metadata)}${MEMORY_METADATA_SUFFIX}`,
        found.content,
      ].join("\n");
      writeFileSync(join(this.memoryDir, found.filename), storedContent, "utf-8");

      if (metadata.scope.type === "global") {
        this.updateMemoryIndexLocked(
          indexPath,
          found.filename,
          found.title,
          this.memoryBodyForPrompt({ filename: found.filename, title: found.title, content: found.content }),
        );
      } else {
        this.removeMemoryIndexEntryLocked(found.filename, indexPath);
      }
      activated = this.entryFromMemoryMetadata(
        found.filename,
        found.title,
        found.content,
        metadata,
        new Date().toISOString(),
      );
    });

    this.memoryIndex = this.readMemoryIndex();
    return activated!;
  }

  /** Reject a reviewed candidate by immutable identity and selected scope. */
  async deleteMemoryCandidate(id: string, options: ProjectScopedMemoryOptions = {}): Promise<void> {
    const safeId = this.validateManagedMemoryId(id, "deleteMemoryCandidate");
    const indexPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(indexPath, async () => {
      const found = this.findManagedMemoryById(safeId);
      if (
        !found
        || found.metadata.state !== "candidate"
        || !this.memoryScopeVisibleForCandidateReview(found.metadata.scope, options)
      ) {
        throw new Error("deleteMemoryCandidate: candidate not found");
      }
      unlinkIfPresent(join(this.memoryDir, found.filename));
      this.removeMemoryIndexEntryLocked(found.filename, indexPath);
    });
    this.memoryIndex = this.readMemoryIndex();
  }

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
  async deleteMemory(filename: string, options: ProjectScopedMemoryOptions = {}): Promise<void> {
    const safeFilename = this.validateDeletableMemoryFilename(filename);
    const path = join(this.memoryDir, safeFilename);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    await withFileLock(indexPath, async () => {
      const snapshot = readUtf8FileSnapshotIfPresent(path, MAX_LEGACY_MEMORY_FILE_BYTES);
      if (snapshot?.tooLarge) {
        throw new Error("deleteMemory: memory file exceeds the supported size");
      }
      if (snapshot) {
        if (this.hasMemoryMarker(snapshot.content) && snapshot.size > MAX_MANAGED_MEMORY_FILE_BYTES) {
          throw new Error("deleteMemory: managed memory file exceeds the supported size");
        }
        const parsed = this.parseMemoryNote(snapshot.content);
        if (parsed.invalidMetadata) throw new Error("deleteMemory: invalid memory metadata");
        const title = parsed.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim() || safeFilename.replace(/\.md$/i, "");
        const entry = parsed.metadata
          ? this.entryFromMemoryMetadata(safeFilename, title, parsed.content, parsed.metadata, snapshot.mtime.toISOString())
          : {
              filename: safeFilename,
              title,
              content: parsed.content,
              ...(parsed.legacyProject.projectRoot ? { projectRoot: parsed.legacyProject.projectRoot } : {}),
              ...(parsed.legacyProject.projectName ? { projectName: parsed.legacyProject.projectName } : {}),
            };
        if (!this.memoryScopeVisibleForMutation(entry, options)) {
          throw new Error("deleteMemory: memory does not belong to the selected scope");
        }
      }
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
    // Derive the title from the in-memory messages the indexer already holds —
    // no redundant JSONL re-read+parse (B1). Same result as the disk path:
    // title/preview come only from string-content turns.
    const summary = this.deriveSessionSummary(sessionId, messages);
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
  private deleteSessionFromSearchIndex(sessionId: string): void {
    if (!this.searchIndex.open()) return;
    try {
      this.searchIndex.deleteSession(sessionId);
    } finally {
      this.searchIndex.close();
    }
  }

  /**
   * Rebuild every current session search row from the JSONL source of truth.
   *
   * Project detach is retryable: metadata may already be detached when a
   * process crashes before its denormalized FTS row is updated. Replacing the
   * whole index on every detach invocation repairs that state even when the
   * retry has zero metadata files left to change. Unlike ordinary best-effort
   * incremental indexing, this lifecycle path throws on reset/open/count
   * failure so workspace removal retains its durable intent for a later retry.
   */
  private repairAllSessionSearchRowsForProjectDetach(): void {
    const dbPath = this.searchIndex.getDbPath();
    this.searchIndex.close();
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(`${dbPath}${suffix}`);
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
      }
      if (!this.searchIndex.open()) {
        throw new Error("search index could not be opened after reset");
      }

      let expectedRows = 0;
      const sessionFiles = readdirIfPresent(this.sessionsDir)
        .filter((file) => file.endsWith(".jsonl"))
        .sort();
      for (const file of sessionFiles) {
        const sessionId = file.slice(0, -".jsonl".length);
        if (!isValidSessionId(sessionId)) continue;
        const messages = this.loadSession(sessionId);
        if (!Array.isArray(messages)) continue;
        const input = this.buildIndexInput(sessionId, messages);
        if (!input) continue;
        this.searchIndex.upsertSession(input);
        expectedRows += 1;
      }
      const actualRows = this.searchIndex.rowCount();
      if (actualRows !== expectedRows) {
        throw new Error(
          `search index row count mismatch (expected ${expectedRows}, got ${actualRows})`,
        );
      }
    } catch (cause) {
      throw Object.assign(
        new Error("workspace session search index repair failed"),
        { code: "SESSION_SEARCH_INDEX_REPAIR_FAILED", cause },
      );
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
    // A healthy populated index cannot need the only repair this method owns
    // (rebuild an empty/corrupt index from JSONL). Avoid enumerating the entire
    // sessions directory on every boot; large profiles can contain thousands of
    // transcripts, and the list is only consumed by the rebuild branch below.
    if (opened && this.searchIndex.rowCount() > 0) {
      this.searchIndex.close();
      return;
    }
    const sessionFiles = this.listSessionJsonlFiles();
    const needsRebuild = !opened || sessionFiles.length > 0;
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

  /** Enumerate rebuild inputs lazily; kept as a seam for scan-regression tests. */
  private listSessionJsonlFiles(): string[] {
    return readdirIfPresent(this.sessionsDir).filter((file) => file.endsWith(".jsonl"));
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

  /**
   * Apply the row-level conversation fields to a session's metadata.
   *
   * `saveSessionMetadata` writes the whole file, so a field-level update has
   * to read first or it erases everything it did not mention. The parameter is
   * an explicit triple rather than a `Partial<SessionMetadata>`: this is the
   * path a RENDERER reaches, and a general patch would let it set the A2A wire
   * identity and the project binding, which it must never do.
   *
   * `null` clears; `undefined` leaves alone. That distinction is the whole
   * reason the caller can unarchive and mark-read through the same call.
   */
  async updateSessionRowFields(
    sessionId: string,
    fields: { title?: string; archivedAt?: string | null; unreadSince?: string | null },
  ): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`updateSessionRowFields: invalid sessionId "${sessionId}"`);
    }
    const current = this.loadSessionMetadata(sessionId) ?? {};
    const next: SessionMetadata = { ...current };
    if (fields.title !== undefined) next.title = fields.title;
    if (fields.archivedAt !== undefined) {
      if (fields.archivedAt === null) delete next.archivedAt;
      else next.archivedAt = fields.archivedAt;
    }
    if (fields.unreadSince !== undefined) {
      if (fields.unreadSince === null) delete next.unreadSince;
      else next.unreadSince = fields.unreadSince;
    }
    await this.saveSessionMetadata(sessionId, next);
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
      subAgentSuspensionPrompt: normalizeMetadataString(
        safe.subAgentSuspensionPrompt,
        MAX_SUMMARY_PREAMBLE_CHARS,
      ),
    };
    const hasA2AWireHandlerId = safe.a2aWireHandlerId !== undefined;
    const hasA2AWireInternalOrigin = safe.a2aWireInternalOrigin !== undefined;
    const detachedTerminalState = asTerminalA2ATaskState(safe.subAgentTaskState);
    const isDetachedA2AWireTask = safe.projectRoot === undefined
      && detachedTerminalState !== undefined
      && safe.subAgentSuspensionReason === undefined
      && safe.subAgentSuspensionPrompt === undefined;
    if (hasA2AWireHandlerId || hasA2AWireInternalOrigin) {
      if (
        !isValidA2AWireMetadataId(safe.a2aWireHandlerId)
        || !isValidA2AWireMetadataId(safe.a2aWireInternalOrigin)
        || safe.a2aWireInternalOrigin !== safe.originSessionId
        || (safe.projectRoot === undefined && !isDetachedA2AWireTask)
        || !Array.isArray(safe.sourceTools)
        || !safe.sourceTools.every((tool) =>
          typeof tool === "string" && tool.length > 0 && tool.length <= 256)
      ) {
        throw new Error(
          "saveSessionMetadata: invalid A2A wire binding metadata (a2a-wire-binding-invalid)",
        );
      }
    }
    if (safe.title !== undefined && safe.title.length > MAX_SESSION_TITLE_CHARS) {
      safe = { ...safe, title: safe.title.slice(0, MAX_SESSION_TITLE_CHARS) };
    }
    // Capture before the first asynchronous lock boundary. A detach and re-add
    // can otherwise clear the Set guard before this writer enters the lock.
    const guardedProjectKey = projectRootKey(safe.projectRoot);
    const capturedRootGeneration = guardedProjectKey
      ? this.projectRootGeneration(guardedProjectKey)
      : undefined;
    await withFileLock(this.sessionMetadataLockPath(sessionId), async () => {
      const sessionTombstones = this.detachedProjectRootsBySession.get(sessionId);
      const rootIsDetached = Boolean(
        guardedProjectKey && this.detachedProjectRoots.has(guardedProjectKey),
      );
      const sessionWasDetached = Boolean(
        guardedProjectKey && sessionTombstones?.has(guardedProjectKey),
      );
      const rootGenerationChanged = Boolean(
        guardedProjectKey
        && capturedRootGeneration !== this.projectRootGeneration(guardedProjectKey),
      );
      const shouldDetachProject = Boolean(
        guardedProjectKey
        && (rootIsDetached || sessionWasDetached || rootGenerationChanged),
      );
      if (shouldDetachProject && guardedProjectKey) {
        // A write that first arrives while the root-wide guard is active must
        // also remain detached after re-add. A generation mismatch covers the
        // ABA case where detach and allow both completed before lock entry.
        if (!sessionWasDetached) {
          const nextTombstones = sessionTombstones ?? new Set<string>();
          nextTombstones.add(guardedProjectKey);
          this.detachedProjectRootsBySession.set(sessionId, nextTombstones);
        }
      }
      const terminalTombstone = this.detachedWireTerminalTombstones.get(sessionId);
      if (terminalTombstone) {
        safe = applyDetachedWireTerminalTombstone(safe, terminalTombstone);
      } else if (shouldDetachProject) {
        safe = detachProjectBinding(safe);
        this.rememberDetachedWireTerminal(sessionId, safe);
      }
      writeUtf8FileAtomicSync(targetPath, JSON.stringify(safe, null, 2));
    });
    // Metadata (sessionKind/routineId/projectRoot/title) is denormalized into
    // the FTS row (#1500 / E3) — re-index whenever it changes, not just on
    // saveSession, otherwise a metadata-only update (the common create-then-
    // tag-metadata sequence) leaves the FTS row's scope fields stale and
    // `searchSessions`'s kind/routineId/projectRoot filters silently misclassify it.
    const messages = this.loadSession(sessionId);
    if (Array.isArray(messages)) {
      this.indexSessionForSearch(sessionId, messages);
    } else {
      this.deleteSessionFromSearchIndex(sessionId);
    }
  }

  /**
   * Allow newly-created sessions to bind to a root that the user registered
   * again. Existing per-session tombstones intentionally remain: re-adding a
   * folder is not an implicit reassignment of previously detached chats.
   */
  allowProjectRoot(projectRoot: string): void {
    const key = projectRootKey(projectRoot);
    if (!key) return;
    this.bumpProjectRootGeneration(key);
    this.detachedProjectRoots.delete(key);
  }

  /**
   * Preserve conversation JSONL while detaching project metadata from sessions
   * that belonged to a removed workspace root. Each metadata file is re-read
   * inside its file lock so concurrent detach calls are idempotent. Project
   * fields are removed; wire tasks also receive one immutable terminal outcome
   * while their host-visible identity and unrelated future fields remain intact.
   */
  async detachSessionsFromProject(projectRoot: string): Promise<number> {
    const key = projectRootKey(projectRoot);
    if (!key) return 0;
    this.bumpProjectRootGeneration(key);
    this.detachedProjectRoots.add(key);

    type DetachPlan = {
      sessionId: string;
      targetPath: string;
      normalized: SessionMetadata;
      next: Record<string, unknown>;
    };
    const metadataTargets = readdirIfPresent(this.sessionsDir)
      .filter((file) => file.endsWith(".meta.json"))
      .map((file) => ({
        sessionId: file.slice(0, -".meta.json".length),
        targetPath: join(this.sessionsDir, file),
      }))
      .filter(({ sessionId }) => isValidSessionId(sessionId))
      .sort((a, b) => a.targetPath.localeCompare(b.targetPath));

    let detachedCount = 0;
    const withAllMetadataLocks = async <T>(
      index: number,
      action: () => Promise<T>,
    ): Promise<T> => {
      const target = metadataTargets[index];
      if (!target) return await action();
      return await withFileLock(
        this.sessionMetadataLockPath(target.sessionId),
        async () => await withAllMetadataLocks(index + 1, action),
      );
    };

    await withAllMetadataLocks(0, async () => {
      const plans: DetachPlan[] = [];
      // Validate every metadata file while every candidate lock is
      // held. No file is rewritten until the complete preflight succeeds.
      for (const { sessionId, targetPath } of metadataTargets) {
        try {
          const raw = readUtf8FileIfPresent(targetPath);
          if (raw === null) continue;
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new TypeError("session metadata must be an object");
          }
          const storedRoot = typeof parsed.projectRoot === "string"
            ? parsed.projectRoot
            : undefined;
          if (!storedRoot || !projectRootEquals(storedRoot, projectRoot)) continue;
          const normalized = normalizeSessionMetadata(parsed);
          const terminalTombstone = this.detachedWireTerminalTombstones.get(sessionId);
          const next = terminalTombstone
            ? applyDetachedWireTerminalTombstone(parsed, terminalTombstone)
            : detachProjectBinding(parsed);
          plans.push({ sessionId, targetPath, normalized, next });
        } catch (error) {
          // Parser diagnostics can echo private metadata fragments. Preserve a
          // stable retryable error without exposing source text.
          const errorName = error instanceof Error ? error.name : "UnknownError";
          log.warn("detachSessionsFromProject: invalid metadata for %s (%s)", sessionId, errorName);
          throw Object.assign(new Error("workspace session metadata detach incomplete"), {
            code: "SESSION_METADATA_INVALID",
            cause: error,
          });
        }
      }

      // Replace each metadata file atomically. An I/O failure may leave earlier
      // files detached, but the root intent remains active and a retry repairs
      // both metadata and the complete search index.
      for (const { sessionId, targetPath, normalized, next } of plans) {
        writeUtf8FileAtomicSync(targetPath, JSON.stringify(next, null, 2));
        const sessionTombstones = this.detachedProjectRootsBySession.get(sessionId)
          ?? new Set<string>();
        sessionTombstones.add(key);
        this.detachedProjectRootsBySession.set(sessionId, sessionTombstones);
        if (!this.detachedWireTerminalTombstones.has(sessionId)) {
          this.rememberDetachedWireTerminal(sessionId, {
            ...normalized,
            subAgentTaskState: (next as Partial<SessionMetadata>).subAgentTaskState,
          });
        }
        detachedCount += 1;
      }
    });

    this.repairAllSessionSearchRowsForProjectDetach();
    return detachedCount;
  }

  /**
   * Whether a conversation still exists.
   *
   * The transcript file is the same thing `listSessions` scans for, so this
   * answers exactly the question the conversation list answers: no caller can
   * be told a conversation exists that the user cannot see, or the reverse.
   * A stat rather than a read, because the question is existence.
   *
   * Unlike {@link hasSessionMetadataFile} this returns false for a malformed id
   * instead of throwing. An id that is not even well-formed names no session,
   * so false is the complete answer, and the callers are projections that must
   * not throw into a snapshot.
   */
  hasSessionTranscript(sessionId: unknown): boolean {
    if (!isValidSessionId(sessionId)) return false;
    return statPathIfPresent(join(this.sessionsDir, `${sessionId}.jsonl`)) !== null;
  }

  hasSessionMetadataFile(sessionId: string): boolean {
    if (!isValidSessionId(sessionId)) {
      throw new Error('hasSessionMetadataFile: invalid sessionId "' + sessionId + '"');
    }
    const path = join(this.sessionsDir, sessionId + ".meta.json");
    return readUtf8FileIfPresent(path) !== null;
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
          ...(metadata?.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
          ...(metadata?.unreadSince ? { unreadSince: metadata.unreadSince } : {}),
        };
      });
  }

  /**
   * Sub-agents spawned by one parent session, newest first.
   *
   * The renderer's sub-agent panel is fed entirely by the live `agent_spawn`
   * event stream, so it is empty after an app restart: the main process that
   * emitted those events is gone and nothing replays them. Every field the
   * panel needs for a row is already on disk in the child's session metadata —
   * this reads it back so a restored conversation still shows the agents it
   * ran, and so each child's `resumeId` (its session id) stays reachable.
   *
   * Transcripts are deliberately NOT loaded here. One parent can spawn many
   * children, and reading every child's `.jsonl` to render a list would make
   * session load pay for transcripts the user may never open.
   */
  listSubAgentSessionsForOrigin(originSessionId: string): RestoredSubAgentSession[] {
    if (!originSessionId) return [];
    return readdirIfPresent(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f): RestoredSubAgentSession[] => {
        const id = f.replace(".jsonl", "");
        const stat = statPathIfPresent(join(this.sessionsDir, f));
        if (!stat) return [];
        const metadata = this.loadSessionMetadata(id);
        if (metadata?.sessionKind !== "subagent") return [];
        if (metadata.originSessionId !== originSessionId) return [];
        // `spawnId` is the panel's row identity. Metadata written before it was
        // recorded cannot be joined to a row, so it is skipped rather than
        // shown under a synthesized id that would split on the next live event.
        if (!metadata.spawnId) return [];
        return [{
          spawnId: metadata.spawnId,
          childSessionId: id,
          title: metadata.subAgentTitle ?? metadata.title ?? "",
          modifiedAt: stat.mtime,
          ...(metadata.subAgentTaskState ? { taskState: metadata.subAgentTaskState } : {}),
          ...(metadata.originToolUseId ? { toolUseId: metadata.originToolUseId } : {}),
        }];
      })
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
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
          ...(metadata?.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
          ...(metadata?.unreadSince ? { unreadSince: metadata.unreadSince } : {}),
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
   * The stable metadata lock target intentionally remains so operations that
   * were already waiting on that session keep the same serialization point.
   *
   * The compact pipeline stores oversized message fragments under
   * `sessions/<sessionId>/truncated/` and `sessions/.checkpoints/<sessionId>/`.
   * Remove those with the transcript so no orphaned fragments remain.
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      log.warn({ sessionId }, "unsafe caller-provided sessionId rejected in deleteSession");
      return;
    }
    await withFileLock(this.sessionMetadataLockPath(sessionId), async () => {
      this.detachedProjectRootsBySession.delete(sessionId);
      this.detachedWireTerminalTombstones.delete(sessionId);
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
    });
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

      // A view_image tool_result carries a large base64 image on its sibling
      // `image` field. It is never re-consumed on load/resume (the Claude mapper
      // only reads it live; the renderer serializer omits it), so persist a
      // clone WITHOUT it — keeps the .jsonl from re-storing ~MBs every save. The
      // live in-memory record keeps its image untouched for the ongoing turn.
      const base =
        "image" in message
          ? ((): Record<string, unknown> => {
              const { image: _image, ...rest } = message as Record<string, unknown>;
              return rest;
            })()
          : message;

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
              ...base,
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

      if (!truncated && compactedAt === undefined) return base;

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
        ...base,
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
      .map((entry) => `### ${entry.title}\n${entry.content}`)
      .join("\n\n---\n\n");
  }

  private readMarkdownEntries(
    dir: string,
    options: MemoryReadOptions & { excludeMarkedMemory?: boolean } = {},
  ): NoteEntry[] {
    return readdirIfPresent(dir)
      .filter((filename) => filename.endsWith(".md"))
      .flatMap((filename) => {
        if (this.isMemoryIndexFilename(filename)) return [];
        const snapshot = readUtf8FileSnapshotIfPresent(join(dir, filename), MAX_LEGACY_MEMORY_FILE_BYTES);
        if (!snapshot || snapshot.tooLarge) return [];
        if (this.hasMemoryMarker(snapshot.content) && snapshot.size > MAX_MANAGED_MEMORY_FILE_BYTES) return [];
        const parsed = this.parseMemoryNote(snapshot.content);
        if (parsed.invalidMetadata || (options.excludeMarkedMemory && this.hasMemoryMarker(snapshot.content))) return [];
        const titleMatch = parsed.content.match(/^#\s+([^\r\n]+)/);
        const entry = parsed.metadata
          ? this.entryFromMemoryMetadata(
              filename,
              titleMatch?.[1]?.trim() || filename.replace(/\.md$/i, ""),
              parsed.content,
              parsed.metadata,
              snapshot.mtime.toISOString(),
            )
          : {
              filename,
              title: titleMatch?.[1]?.trim() || filename.replace(/\.md$/i, ""),
              content: parsed.content,
              updatedAt: snapshot.mtime.toISOString(),
              ...(parsed.legacyProject.projectRoot ? { projectRoot: parsed.legacyProject.projectRoot } : {}),
              ...(parsed.legacyProject.projectName ? { projectName: parsed.legacyProject.projectName } : {}),
            };
        return this.matchesMemoryRead(entry, options) ? [entry] : [];
      })
      .sort((left, right) =>
        new Date(right.updatedAt ?? 0).getTime() - new Date(left.updatedAt ?? 0).getTime()
        || left.filename.localeCompare(right.filename),
      );
  }

  private searchEntries(entries: NoteEntry[], query: string): NoteEntry[] {
    const lower = query.toLocaleLowerCase();
    return entries.filter(
      (note) => note.title.toLocaleLowerCase().includes(lower) || note.content.toLocaleLowerCase().includes(lower),
    ).slice(0, 50);
  }

  private hasMemoryMarker(content: string): boolean {
    const firstLine = content.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
    return /^<!--\s*lvis:kind=memory\s*-->$/i.test(firstLine);
  }

  private parseMemoryNote(rawContent: string): ParsedMemoryNote {
    const lines = rawContent.replace(/^\uFEFF/, "").split(/\r?\n/);
    let cursor = 0;
    let encodedMetadata: string | undefined;
    let projectRoot: string | undefined;
    let projectName: string | undefined;
    let invalidMetadata = false;

    while (cursor < lines.length) {
      const line = lines[cursor] ?? "";
      if (/^<!--\s*lvis:kind=memory\s*-->$/i.test(line)) {
        cursor += 1;
        continue;
      }
      if (/^<!--\s*lvis:memory-meta:/i.test(line)) {
        const match = /^<!--\s*lvis:memory-meta:([A-Za-z0-9_-]+)\s*-->$/i.exec(line);
        if (!match || encodedMetadata !== undefined) invalidMetadata = true;
        else encodedMetadata = match[1];
        cursor += 1;
        continue;
      }
      const rootMatch = new RegExp(`^${escapeRegExp(MEMORY_PROJECT_ROOT_PREFIX)}\\s*(.*?)\\s*-->$`, "i").exec(line);
      if (rootMatch) {
        if (projectRoot !== undefined) invalidMetadata = true;
        else {
          const normalizedRoot = normalizeMetadataString(rootMatch[1], MAX_PROJECT_ROOT_CHARS);
          if (!normalizedRoot) invalidMetadata = true;
          else projectRoot = normalizedRoot;
        }
        cursor += 1;
        continue;
      }
      const nameMatch = new RegExp(`^${escapeRegExp(MEMORY_PROJECT_NAME_PREFIX)}\\s*(.*?)\\s*-->$`, "i").exec(line);
      if (nameMatch) {
        if (projectName !== undefined) invalidMetadata = true;
        else {
          const normalizedName = normalizeMetadataString(nameMatch[1], MAX_PROJECT_NAME_CHARS);
          if (!normalizedName) invalidMetadata = true;
          else projectName = normalizedName;
        }
        cursor += 1;
        continue;
      }
      if (/^<!--\s*lvis:/i.test(line)) invalidMetadata = true;
      break;
    }

    const content = lines.slice(cursor).join("\n");
    if (encodedMetadata !== undefined) {
      const metadata = !invalidMetadata ? decodeMemoryMetadata(encodedMetadata) : null;
      return { content, metadata: metadata ?? undefined, legacyProject: {}, invalidMetadata: metadata === null || invalidMetadata };
    }
    return {
      content,
      legacyProject: {
        ...(projectRoot ? { projectRoot } : {}),
        ...(projectName ? { projectName } : {}),
      },
      invalidMetadata,
    };
  }

  private matchesMemoryRead(entry: NoteEntry, options: MemoryReadOptions): boolean {
    if (entry.state === "candidate" && options.includeCandidates !== true) return false;
    if (noteIsExpired(entry)) return false;
    const isManagedGlobal = entry.id !== undefined && !entry.projectRoot;
    if (options.scope === "global") return isManagedGlobal;
    // Detached/global callers must not enumerate another project's V1 memory.
    // Legacy unscoped files remain visible so an upgrade does not hide history.
    if (!options.projectRoot) return !entry.projectRoot;
    if (isManagedGlobal) return true;
    return projectRootEquals(entry.projectRoot, options.projectRoot)
      || (options.includeUnscoped === true && !entry.projectRoot);
  }

  private matchesCandidateReviewScope(entry: NoteEntry, options: ProjectScopedMemoryOptions): boolean {
    if (entry.id === undefined || entry.state !== "candidate") return false;
    const scope: MemoryScope = entry.projectRoot
      ? {
          type: "project",
          projectRoot: entry.projectRoot,
          ...(entry.projectName ? { projectName: entry.projectName } : {}),
        }
      : { type: "global" };
    return this.memoryScopeVisibleForCandidateReview(scope, options);
  }

  private memoryScopeVisibleForCandidateReview(
    scope: MemoryScope,
    options: ProjectScopedMemoryOptions,
  ): boolean {
    if (!options.projectRoot) return scope.type === "global";
    return scope.type === "global" || projectRootEquals(scope.projectRoot, options.projectRoot);
  }

  private memoryScopeVisibleForMutation(entry: NoteEntry, options: ProjectScopedMemoryOptions): boolean {
    if (!options.projectRoot) return !entry.projectRoot;
    return !entry.projectRoot || projectRootEquals(entry.projectRoot, options.projectRoot);
  }

  private isPromptVisibleMemory(entry: NoteEntry, options: MemorySelectionOptions): boolean {
    if (this.isDerivedMemory(entry) || entry.state === "candidate" || noteIsExpired(entry)) return false;
    if (!options.projectRoot) return entry.id !== undefined ? !entry.projectRoot : !entry.projectRoot;
    if (entry.id !== undefined && !entry.projectRoot) return true;
    return projectRootEquals(entry.projectRoot, options.projectRoot)
      || (options.includeUnscoped === true && !entry.projectRoot);
  }

  private memoryBodyForPrompt(entry: NoteEntry): string {
    return entry.content.replace(/^#\s+[^\r\n]+\r?\n?/, "").trim();
  }

  private withoutSavedMemoryIndexEntries(markdown: string): string {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const kept: string[] = [];
    let skippingSavedMemories = false;
    for (const line of lines) {
      if (/^##\s+Saved Memories\s*$/i.test(line)) {
        skippingSavedMemories = true;
        continue;
      }
      if (skippingSavedMemories && /^##\s+/.test(line)) skippingSavedMemories = false;
      if (!skippingSavedMemories) kept.push(line);
    }
    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  private assertManagedMemoryInput(title: string, content: string): { title: string; content: string } {
    const safeTitle = typeof title === "string" ? title.trim() : "";
    const safeContent = typeof content === "string" ? content.trim() : "";
    if (!safeTitle || !safeContent) throw new Error("saveMemory: title and content are required");
    if (safeTitle.length > MAX_MANAGED_MEMORY_TITLE_CHARS) {
      throw new Error(`saveMemory: title exceeds ${MAX_MANAGED_MEMORY_TITLE_CHARS} characters`);
    }
    if (safeContent.length > MAX_MANAGED_MEMORY_CONTENT_CHARS) {
      throw new Error(`saveMemory: content exceeds ${MAX_MANAGED_MEMORY_CONTENT_CHARS} characters`);
    }
    if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(safeTitle)) {
      throw new Error("saveMemory: title must be a single-line label without control characters");
    }
    if (/<!--\s*lvis:/i.test(`${safeTitle}\n\n${safeContent}`)) {
      throw new Error("saveMemory: the lvis marker namespace is reserved");
    }
    return { title: safeTitle, content: safeContent };
  }

  private createMemoryMetadata(options: MemorySaveOptions): MemoryMetadataV1 {
    const kind = options.kind ?? "note";
    const state = options.state ?? "active";
    const source = options.source ?? "user";
    if (!MEMORY_KINDS.has(kind)) throw new Error("saveMemory: invalid memory kind");
    if (!MEMORY_STATES.has(state)) throw new Error("saveMemory: invalid memory state");
    if (!MEMORY_SOURCES.has(source)) throw new Error("saveMemory: invalid memory source");
    if (options.confirmedAt !== undefined && !isValidMemoryTimestamp(options.confirmedAt)) {
      throw new Error("saveMemory: invalid confirmedAt timestamp");
    }
    if (options.expiresAt !== undefined && !isValidMemoryTimestamp(options.expiresAt)) {
      throw new Error("saveMemory: invalid expiresAt timestamp");
    }
    if (state === "candidate" && options.confirmedAt !== undefined) {
      throw new Error("saveMemory: candidate memory cannot be confirmed");
    }
    const normalizedCapture = options.capture === undefined ? undefined : normalizeMemoryCapture(options.capture);
    if (options.capture !== undefined && !normalizedCapture) throw new Error("saveMemory: invalid capture provenance");
    const capture = normalizedCapture ?? undefined;
    if (!hasValidCaptureSourceCombination(source, capture)) {
      throw new Error("saveMemory: capture provenance does not match the memory source");
    }

    const projectRoot = normalizeMetadataString(options.projectRoot, MAX_PROJECT_ROOT_CHARS);
    const projectName = normalizeMetadataString(options.projectName, MAX_PROJECT_NAME_CHARS);
    if (typeof options.projectRoot === "string" && options.projectRoot.trim().length > MAX_PROJECT_ROOT_CHARS) {
      throw new Error("saveMemory: projectRoot exceeds the maximum length");
    }
    if (typeof options.projectName === "string" && options.projectName.trim().length > MAX_PROJECT_NAME_CHARS) {
      throw new Error("saveMemory: projectName exceeds the maximum length");
    }
    const now = new Date().toISOString();
    const scope: MemoryScope = projectRoot
      ? { type: "project", projectRoot, ...(projectName ? { projectName } : {}) }
      : { type: "global" };
    return {
      v: 1,
      id: randomUUID(),
      scope,
      kind,
      state,
      source,
      createdAt: now,
      ...(state === "active" ? { confirmedAt: options.confirmedAt ?? now } : {}),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      ...(options.pinned === true ? { pinned: true } : {}),
      ...(capture ? { capture: { ...capture } } : {}),
    };
  }

  private mergeExistingMemoryMetadata(
    existing: MemoryMetadataV1,
    requested: MemoryMetadataV1,
    options: MemorySaveOptions,
  ): MemoryMetadataV1 {
    const state = options.state ?? existing.state;
    if (existing.state === "candidate" && state !== "candidate") {
      throw new Error("saveMemory: candidate memories must be activated by id");
    }
    const pinned = options.pinned === undefined ? existing.pinned : options.pinned === true;
    const expiresAt = options.expiresAt ?? existing.expiresAt;
    return {
      v: 1,
      id: existing.id,
      scope: existing.scope,
      kind: options.kind ?? existing.kind,
      state,
      source: options.source ?? existing.source,
      createdAt: existing.createdAt,
      ...(state === "active"
        ? { confirmedAt: existing.confirmedAt ?? requested.confirmedAt ?? new Date().toISOString() }
        : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(pinned ? { pinned: true } : {}),
      ...(requested.capture ?? existing.capture ? { capture: { ...(requested.capture ?? existing.capture)! } } : {}),
    };
  }

  private entryFromMemoryMetadata(
    filename: string,
    title: string,
    content: string,
    metadata: MemoryMetadataV1,
    updatedAt: string,
  ): NoteEntry {
    const project = metadata.scope.type === "project" ? metadata.scope : undefined;
    return {
      filename,
      title,
      content,
      updatedAt,
      id: metadata.id,
      kind: metadata.kind,
      state: metadata.state,
      source: metadata.source,
      createdAt: metadata.createdAt,
      ...(metadata.confirmedAt ? { confirmedAt: metadata.confirmedAt } : {}),
      ...(metadata.expiresAt ? { expiresAt: metadata.expiresAt } : {}),
      ...(metadata.pinned ? { pinned: true } : {}),
      ...(metadata.derivation ? { derivation: { ...metadata.derivation } } : {}),
      ...(metadata.capture ? { capture: { ...metadata.capture } } : {}),
      ...(project?.projectRoot ? { projectRoot: project.projectRoot } : {}),
      ...(project?.projectName ? { projectName: project.projectName } : {}),
    };
  }

  private memoryScopesEqual(left: MemoryScope, right: MemoryScope): boolean {
    if (left.type === "global") return right.type === "global";
    if (right.type !== "project") return false;
    return projectRootEquals(left.projectRoot, right.projectRoot);
  }

  private consolidationScopeFromOptions(options: ProjectScopedMemoryOptions): MemoryScope {
    const projectRoot = normalizeMetadataString(options.projectRoot, MAX_PROJECT_ROOT_CHARS);
    if (!projectRoot) return { type: "global" };
    const projectName = normalizeMetadataString(options.projectName, MAX_PROJECT_NAME_CHARS);
    return {
      type: "project",
      projectRoot,
      ...(projectName ? { projectName } : {}),
    };
  }

  private cloneMemoryScope(scope: MemoryScope): MemoryScope {
    return scope.type === "global"
      ? { type: "global" }
      : {
          type: "project",
          projectRoot: scope.projectRoot,
          ...(scope.projectName ? { projectName: scope.projectName } : {}),
        };
  }

  private isValidConsolidationScope(scope: unknown): scope is MemoryScope {
    if (!isRecord(scope)) return false;
    if (scope.type === "global") return true;
    return scope.type === "project"
      && typeof scope.projectRoot === "string"
      && scope.projectRoot.length <= MAX_PROJECT_ROOT_CHARS
      && projectRootKey(scope.projectRoot) !== undefined
      && (scope.projectName === undefined
        || (typeof scope.projectName === "string" && scope.projectName.length <= MAX_PROJECT_NAME_CHARS));
  }

  private isValidConsolidationSnapshot(snapshot: unknown): snapshot is MemoryConsolidationSnapshot {
    return isRecord(snapshot)
      && this.isValidConsolidationScope(snapshot.scope)
      && Array.isArray(snapshot.sources)
      && typeof snapshot.sourceFingerprint === "string"
      && /^[a-f0-9]{64}$/i.test(snapshot.sourceFingerprint);
  }

  private getConsolidationSnapshotForScope(scope: MemoryScope): MemoryConsolidationSnapshot {
    const sourceOptions: MemoryReadOptions = scope.type === "project"
      ? { projectRoot: scope.projectRoot }
      : this.defaultWorkspaceRoot
        ? { projectRoot: this.defaultWorkspaceRoot, includeUnscoped: true }
        : {};
    const sources = this.readMarkdownEntries(this.memoryDir, sourceOptions)
      .filter((entry) => (
        this.entryMatchesConsolidationScope(entry, scope)
        || this.isDefaultWorkspaceGlobalSource(entry, scope)
      ) && this.isConsolidationSource(entry))
      .slice(0, MAX_CONSOLIDATION_SOURCE_NOTES)
      .map((entry) => this.cloneMemoryEntry(entry));
    const sourceFingerprint = sha256Text(JSON.stringify({
      v: 1,
      scope: this.consolidationScopeFingerprintValue(scope),
      sources: sources.map((entry) => ({
        filename: entry.filename,
        title: entry.title,
        content: entry.content,
        updatedAt: entry.updatedAt,
        id: entry.id,
        kind: entry.kind,
        state: entry.state,
        source: entry.source,
        createdAt: entry.createdAt,
        confirmedAt: entry.confirmedAt,
        expiresAt: entry.expiresAt,
        pinned: entry.pinned,
        projectRoot: entry.projectRoot ? projectRootKey(entry.projectRoot) ?? entry.projectRoot : undefined,
        projectName: entry.projectName,
      })),
    }));
    return {
      scope: this.cloneMemoryScope(scope),
      sources,
      sourceFingerprint,
    };
  }

  private consolidationScopeFingerprintValue(scope: MemoryScope): Record<string, string | number> {
    if (scope.type === "global") return { type: "global", v: 1 };
    return {
      type: "project",
      v: 1,
      projectRoot: projectRootKey(scope.projectRoot) ?? scope.projectRoot,
    };
  }

  private cloneMemoryEntry(entry: NoteEntry): NoteEntry {
    return {
      ...entry,
      ...(entry.derivation ? { derivation: { ...entry.derivation } } : {}),
      ...(entry.capture ? { capture: { ...entry.capture } } : {}),
    };
  }

  private entryMatchesConsolidationScope(entry: NoteEntry, scope: MemoryScope): boolean {
    return scope.type === "global"
      ? !entry.projectRoot
      : entry.projectRoot !== undefined && projectRootEquals(entry.projectRoot, scope.projectRoot);
  }

  private isDefaultWorkspaceGlobalSource(entry: NoteEntry, scope: MemoryScope): boolean {
    return scope.type === "global"
      && this.defaultWorkspaceRoot !== undefined
      && entry.projectRoot !== undefined
      && projectRootEquals(entry.projectRoot, this.defaultWorkspaceRoot);
  }

  private isDerivedMemory(entry: NoteEntry): boolean {
    return entry.derivation?.type === "consolidated-overview";
  }

  private isConsolidationSource(entry: NoteEntry): boolean {
    return !this.isDerivedMemory(entry)
      && !noteIsExpired(entry)
      && (entry.state === undefined || entry.state === "active");
  }

  private findConsolidatedMemoryOverview(scope: MemoryScope): NoteEntry | undefined {
    const options: MemoryReadOptions = scope.type === "project"
      ? { projectRoot: scope.projectRoot }
      : {};
    return this.readMarkdownEntries(this.memoryDir, options).find((entry) =>
      this.entryMatchesConsolidationScope(entry, scope)
      && this.isDerivedMemory(entry)
      && entry.kind === "reference"
      && entry.state === "active"
      && entry.source === "assistant",
    );
  }

  private consolidatedOverviewTitle(scope: MemoryScope): string {
    return scope.type === "global"
      ? "Long-term Memory Overview"
      : "Project Long-term Memory Overview";
  }

  private findExistingManagedMemory(
    title: string,
    scope: MemoryScope,
    preferredState: MemoryState | undefined,
    preferredSource: MemorySourceKind | undefined,
    preferredCaptureTrigger: MemoryCaptureTrigger | undefined,
  ): { filename: string; metadata: MemoryMetadataV1 } | undefined {
    let fallback: { filename: string; metadata: MemoryMetadataV1 } | undefined;
    for (const filename of readdirIfPresent(this.memoryDir)) {
      if (!filename.endsWith(".md") || this.isMemoryIndexFilename(filename)) continue;
      const snapshot = readUtf8FileSnapshotIfPresent(join(this.memoryDir, filename), MAX_MANAGED_MEMORY_FILE_BYTES);
      if (!snapshot || snapshot.tooLarge) continue;
      const parsed = this.parseMemoryNote(snapshot.content);
      if (!parsed.metadata || parsed.invalidMetadata) continue;
      if (parsed.metadata.derivation) continue;
      const existingTitle = parsed.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
      if (existingTitle === title && this.memoryScopesEqual(parsed.metadata.scope, scope)) {
        const match = { filename, metadata: parsed.metadata };
        if (
          (!preferredState || parsed.metadata.state === preferredState)
          && (!preferredSource || parsed.metadata.source === preferredSource)
          && parsed.metadata.capture?.trigger === preferredCaptureTrigger
        ) return match;
        fallback ??= match;
      }
    }
    return fallback;
  }

  private validateManagedMemoryId(id: string, operation: string): string {
    if (typeof id !== "string" || !MEMORY_ID_PATTERN.test(id)) {
      throw new Error(`${operation}: invalid memory id`);
    }
    return id.toLowerCase();
  }

  private findManagedMemoryById(
    id: string,
  ): { filename: string; title: string; content: string; metadata: MemoryMetadataV1 } | undefined {
    for (const filename of readdirIfPresent(this.memoryDir)) {
      if (!filename.endsWith(".md") || this.isMemoryIndexFilename(filename)) continue;
      const snapshot = readUtf8FileSnapshotIfPresent(join(this.memoryDir, filename), MAX_MANAGED_MEMORY_FILE_BYTES);
      if (!snapshot || snapshot.tooLarge) continue;
      const parsed = this.parseMemoryNote(snapshot.content);
      if (!parsed.metadata || parsed.invalidMetadata || parsed.metadata.id.toLowerCase() !== id) continue;
      const title = parsed.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
      if (!title) continue;
      return {
        filename,
        title,
        content: parsed.content,
        metadata: parsed.metadata,
      };
    }
    return undefined;
  }

  private allocateMemoryFilename(title: string, id: string): string {
    const base = this.memoryFilenameForTitle(title);
    if (!existsSync(join(this.memoryDir, base))) return base;
    const stem = base.replace(/\.md$/i, "");
    const suffix = id.slice(0, 8);
    let candidate = `${stem}--${suffix}.md`;
    let collision = 2;
    while (existsSync(join(this.memoryDir, candidate))) {
      candidate = `${stem}--${suffix}-${collision}.md`;
      collision += 1;
    }
    return candidate;
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

  /**
   * Derive {title, preview} from a session's messages. Pure — opens nothing.
   * Only string-content user/assistant turns feed the title/preview (tool-result
   * records are skipped), so an in-memory array and the on-disk JSONL derive the
   * same result — `prepareSessionMessagesForDisk` only rewrites tool-result
   * artifacts, never string content.
   */
  private deriveSessionSummary(
    sessionId: string,
    messages: unknown[] | null,
  ): { title: string; preview: string } {
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

  // Disk-loading wrapper for callers without the messages in hand (listSessions).
  // The indexer passes its in-memory array to deriveSessionSummary directly,
  // avoiding a redundant JSONL re-read + parse on every saveSession.
  private readSessionSummary(sessionId: string): { title: string; preview: string } {
    return this.deriveSessionSummary(sessionId, this.loadSession(sessionId));
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
