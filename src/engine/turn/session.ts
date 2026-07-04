/**
 * Session lifecycle.
 *
 * newConversation / loadSession / resetAndResume / branchFromCheckpoint /
 * startRoutineConversation. The newConversation + loadSession field-reset
 * lists live TOGETHER here so the two hand-maintained lists cannot drift.
 * Free functions over a `self: ConversationLoop` this-shaped param.
 */
import type { ConversationLoop } from "../conversation-loop.js";
import type { SessionKind } from "../../memory/memory-manager.js";
import type { GenericMessage } from "../llm/types.js";
import { normalizeToolPairInvariant } from "../conversation-history.js";
import { createTracer } from "../../observability/conversation-trace.js";
import { latestPersistedContextTokens } from "./context-carrier.js";
import { estimateMessagesTokens } from "../auto-compact.js";
import { createLogger } from "../../lib/logger.js";
import { projectBasename } from "../../shared/project-identity.js";

const log = createLogger("lvis");

const SESSION_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;

export interface SessionProjectContext {
  projectRoot?: string;
  projectName?: string;
  isDefault?: boolean;
}

function isSafeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_REGEX.test(sessionId);
}

function normalizeProjectString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function applyProjectContext(self: ConversationLoop, project?: SessionProjectContext): void {
  let projectRoot = normalizeProjectString(project?.projectRoot);
  let projectName = normalizeProjectString(project?.projectName);
  if (projectRoot && self.deps.authorizeProject) {
    const authorized = self.deps.authorizeProject(projectRoot, projectName ?? undefined);
    if (authorized) {
      projectRoot = normalizeProjectString(authorized.projectRoot);
      projectName = normalizeProjectString(authorized.projectName) ?? projectName;
      project = { ...project, isDefault: authorized.isDefault };
    } else {
      const fallback = self.deps.getDefaultProject?.();
      projectRoot = normalizeProjectString(fallback?.projectRoot);
      projectName = normalizeProjectString(fallback?.projectName);
      project = fallback;
    }
  }
  const projectIsDefault = projectRoot
    ? project?.isDefault === true || self.deps.isDefaultProjectRoot?.(projectRoot) === true
    : false;
  self.sessionProjectRoot = projectRoot;
  self.sessionProjectName = projectName;
  self.sessionProjectIsDefault = projectIsDefault;
  self.sessionAdditionalDirectories = projectRoot ? [projectRoot] : [];
  self.deps.systemPromptBuilder.setProjectContext?.(projectRoot
    ? {
        projectRoot,
        projectName: projectName ?? projectBasename(projectRoot),
        ...(projectIsDefault ? { isDefault: true } : {}),
      }
    : null);
}

function currentProjectContext(self: ConversationLoop): SessionProjectContext {
  return {
    ...(self.sessionProjectRoot ? { projectRoot: self.sessionProjectRoot } : {}),
    ...(self.sessionProjectName ? { projectName: self.sessionProjectName } : {}),
  };
}

export function newConversation(
  self: ConversationLoop,
  kind: SessionKind = "main",
  project?: SessionProjectContext,
): void {
    if (self.history.length > 0) {
      self.deps.memoryManager.saveSession(self.sessionId, self.history.getMessages()).catch((err: unknown) => {
        log.warn("newConversation saveSession failed: %s", (err as Error).message);
      });
    }
    // C2(c): drop the previous session's loaded skills so a fresh chat
    // starts with a clean overlay. Tests / stubs without overlay omit self.
    self.deps.skillOverlay?.clear(self.sessionId);
    // Clear the OLD session's on-demand plugin activations BEFORE reassigning
    // sessionId. Clearing after the reassignment would key on the NEW id and
    // orphan the OLD session's Map entry.
    self.deps.pluginRuntime?.clearSessionActivated?.(self.sessionId);
    self.sessionId = crypto.randomUUID();
    self.sessionKind = kind;
    self.sessionRoutineId = null;
    self.sessionRoutineTitle = null;
    self.sessionAdditionalDirectories = [];
    applyProjectContext(self, project);
    // #811 m2 — new session ⇒ SessionStart must re-fire on the next turn.
    self.sessionStartFiredFor = null;
    self.turnAdditionalDirectories = [];
    self.history.clear();
    self.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    self.lastRoundProviderInputTokens = 0;
    self.lastRoundInputProjection = null;
    self.lastContextInputTokens = 0;
    self.lastContextInputProjectionTokens = 0;
    self.sessionPluginExpansions = 0;
    self.sessionToolSearches = 0;
    self.sessionActivatedPluginIds.clear();
    self.lastTurnToolNames = null;
    self.compactNum = 0;
    self.rateLimitRecoveryAttempted = false;
    self.tracer = createTracer(self.sessionId);
    // Clear rolling summary preamble for fresh session.
    self.deps.systemPromptBuilder.setSummaryPreamble?.(null);
  }

export function loadSession(self: ConversationLoop, sessionId: string): boolean {
    if (!isSafeSessionId(sessionId)) {
      log.warn({ sessionId }, "loadSession rejected unsafe sessionId");
      return false;
    }
    const messages = self.deps.memoryManager.loadSession(sessionId);
    if (!messages) return false;


    if (self.history.length > 0) {
      self.deps.memoryManager.saveSession(self.sessionId, self.history.getMessages()).catch((err: unknown) => {
        log.warn("loadSession saveSession failed: %s", (err as Error).message);
      });
    }

    const normalized = normalizeToolPairInvariant(messages as import("../llm/types.js").GenericMessage[]);
    if (normalized.removedMessages > 0 || normalized.removedToolCalls > 0) {
      log.warn(
        `loadSession: repaired invalid tool history for ${sessionId} (removedMessages=${normalized.removedMessages}, removedToolCalls=${normalized.removedToolCalls})`,
      );
      void self.deps.memoryManager.saveSession(sessionId, normalized.messages).catch((err: unknown) => {
        log.warn("loadSession repair saveSession failed: %s", (err as Error).message);
      });
    }

    // Clear the OLD session's on-demand plugin activations BEFORE reassigning
    // sessionId. Clearing after the reassignment would key on the NEW id and
    // orphan the OLD session's Map entry.
    self.deps.pluginRuntime?.clearSessionActivated?.(self.sessionId);
    self.sessionId = sessionId;
    // #811 m2 — switched-into session ⇒ SessionStart re-fires on its next turn.
    self.sessionStartFiredFor = null;
    const sessionMeta = self.deps.memoryManager.loadSessionMetadata(sessionId);
    self.sessionKind = sessionMeta?.sessionKind ?? "main";
    self.sessionRoutineId = sessionMeta?.routineId ?? null;
    self.sessionRoutineTitle = sessionMeta?.routineTitle ?? null;
    self.sessionAdditionalDirectories = [];
    applyProjectContext(self, {
      ...(sessionMeta?.projectRoot ? { projectRoot: sessionMeta.projectRoot } : {}),
      ...(sessionMeta?.projectName ? { projectName: sessionMeta.projectName } : {}),
    });
    self.history.clear();
    self.history.restore(normalized.messages);
    self.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    self.lastRoundProviderInputTokens = 0;
    self.lastRoundInputProjection = null;
    self.lastContextInputTokens = latestPersistedContextTokens(normalized.messages);
    self.lastContextInputProjectionTokens = 0;
    self.sessionPluginExpansions = 0;
    self.sessionToolSearches = 0;
    self.sessionActivatedPluginIds.clear();
    self.lastTurnToolNames = null;
    self.turnAdditionalDirectories = [];
    // Use max compactNum across all checkpoints (monotonic guarantee).
    // Using array length would produce a stale value when normalizeCheckpoint drops
    // invalid entries — next compact would reuse an already-used compactNum.
    self.compactNum = sessionMeta?.checkpoints?.reduce(
      (max, c) => Math.max(max, c.compactNum ?? 0),
      0,
    ) ?? 0;
    self.tracer = createTracer(self.sessionId);
    // Inject rolling summary preamble from loaded session metadata.
    const preamble = sessionMeta?.summaryPreamble ?? null;
    self.deps.systemPromptBuilder.setSummaryPreamble?.(preamble);
    return true;
  }

export function resetAndResume(self: ConversationLoop, sessionId: string): {
    ok: boolean;
    compacted: boolean;
    compactedAt: string | null;
    removedMessageCount: number;
  } {
    const loaded = loadSession(self, sessionId);
    if (!loaded) {
      return { ok: false, compacted: false, compactedAt: null, removedMessageCount: 0 };
    }

    // Session resume does not compact immediately. The next user turn computes
    // a full request-input projection from the live prompt/tool scope before
    // deciding whether compact is needed.
    self.cumulativeUsage = {
      inputTokens: estimateMessagesTokens(self.history.getMessages()),
      outputTokens: 0,
    };
    self.lastRoundProviderInputTokens = 0;
    self.lastRoundInputProjection = null;
    self.rateLimitRecoveryAttempted = false;

    return {
      ok: true,
      compacted: false,
      compactedAt: null,
      removedMessageCount: 0,
    };
  }

export async function startRoutineConversation(self: ConversationLoop, routineId: string, routineTitle: string, routineFiredAt?: string): Promise<string> {
    const project = currentProjectContext(self);
    newConversation(self, "routine", project);
    self.sessionRoutineId = routineId;
    self.sessionRoutineTitle = routineTitle;
    await self.deps.memoryManager.saveSession(self.sessionId, []);
    await self.deps.memoryManager.saveSessionMetadata(self.sessionId, {
      sessionKind: "routine",
      routineId,
      routineTitle,
      ...(routineFiredAt ? { routineFiredAt } : {}),
      ...project,
    });
    return self.sessionId;
  }

export async function branchFromCheckpoint(self: ConversationLoop, compactNum: number): Promise<{
    newSessionId: string;
    lastMessageRole: GenericMessage["role"] | null;
    shouldAutoContinue: boolean;
  }> {
    const checkpoints = self.deps.memoryManager.loadSessionMetadata(self.sessionId)?.checkpoints ?? [];
    const target = checkpoints.find((c) => c.compactNum === compactNum);
    if (!target) throw new Error(`Checkpoint #${compactNum} not found in session ${self.sessionId}`);

    // Load the pre-compact snapshot saved at compaction time.
    // The main session JSONL is overwritten by PostTurnHookChain.saveSession with the
    // post-compact history after each turn, so it cannot be used to reconstruct the
    // pre-checkpoint transcript. saveCheckpointSnapshot() persists messagesBefore to
    // a checkpoint-specific file (.checkpoints/{sessionId}/{N}.jsonl) before the turn completes.
    const snapshotMessages = self.deps.memoryManager.loadCheckpointSnapshot(self.sessionId, compactNum);
    if (!snapshotMessages) {
      throw new Error(
        `branchFromCheckpoint: no snapshot found for checkpoint #${compactNum} in session ${self.sessionId}. ` +
        `Snapshots are only available for checkpoints created after this feature was introduced.`,
      );
    }
    if (snapshotMessages.length < target.messageCountAtTrigger) {
      throw new Error(
        `branchFromCheckpoint: snapshot length ${snapshotMessages.length} < checkpoint messageCountAtTrigger ${target.messageCountAtTrigger} for session ${self.sessionId}`,
      );
    }

    const newSessionId = crypto.randomUUID();
    const sliced = (snapshotMessages as import("../llm/types.js").GenericMessage[]).slice(0, target.messageCountAtTrigger);

    // Repair tool-pair invariant — loadCheckpointSnapshot skips malformed JSONL.
    // lines, which can leave orphaned tool_call or tool_result entries in the slice.
    const { messages: repaired, removedMessages, removedToolCalls } = normalizeToolPairInvariant(sliced);
    if (removedMessages > 0 || removedToolCalls > 0) {
      log.warn(
        `branchFromCheckpoint: repaired ${removedMessages} messages + ${removedToolCalls} tool calls from snapshot (session ${self.sessionId} compact #${compactNum})`,
      );
    }

    const forkMessages = self.deps.memoryManager.rehydrateToolResultArtifacts(self.sessionId, repaired) as GenericMessage[];
    await self.deps.memoryManager.saveSession(newSessionId, forkMessages);

    // 브랜치 세션 metadata — checkpoint/fork provenance + prior summary.
    await self.deps.memoryManager.saveSessionMetadata(newSessionId, {
      sessionKind: self.sessionKind,
      ...(self.sessionRoutineId ? { routineId: self.sessionRoutineId } : {}),
      ...(self.sessionRoutineTitle ? { routineTitle: self.sessionRoutineTitle } : {}),
      ...currentProjectContext(self),
      parentSessionId: self.sessionId,
      ...(target.summary ? { summaryPreamble: target.summary } : {}),
      branchedFromCompactNum: compactNum,
      branchedAt: new Date().toISOString(),
    });

    const lastMessageRole = forkMessages[forkMessages.length - 1]?.role ?? null;
    const shouldAutoContinue = lastMessageRole === "user";

    log.info(`branchFromCheckpoint: new session ${newSessionId} from ${self.sessionId} @ compact #${compactNum}`);
    return { newSessionId, lastMessageRole, shouldAutoContinue };
  }
