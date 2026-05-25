import type { GenericMessage, MessageMeta } from "../engine/llm/types.js";
import { userContentText } from "../engine/llm/types.js";
import { maskSensitiveData } from "./dlp.js";
import { isOverlayTriggerOrigin } from "./overlay-trigger-source.js";
import {
  normalizeProviderToolAliasName,
  normalizeProviderToolAliasText,
} from "./tool-name-aliases.js";

export type SerializedHistoryToolCall = {
  id: string;
  name: string;
  input?: Record<string, unknown>;
};

/**
 * Turn-aggregate stats carried on the turn-final assistant message. Mirrors
 * `MessageMeta.turnSummary` 1:1 so the renderer can reconstruct a
 * `kind: "turn_summary"` ChatEntry from persisted state without re-running
 * the conversation loop.
 */
export type SerializedTurnSummary = NonNullable<MessageMeta["turnSummary"]>;

/** Checkpoint metrics carried on the compactBoundary user message. */
export type SerializedCheckpointMeta = NonNullable<MessageMeta["checkpointMeta"]>;
export type SerializedImportedTriggerMeta = NonNullable<MessageMeta["importedTrigger"]>;
export type SerializedToolDisplayMeta = {
  durationMs?: number;
};

// Exact IPC payload emitted by serializeHistoryMessage() for renderer history
// replay: multimodal content is flattened at the boundary, while persisted
// assistant/tool structure remains available for turn/work reconstruction.
export type SerializedHistoryMessage = {
  index: number;
  role: "user" | "assistant" | "tool_result";
  content: string;
  thought?: string;
  toolCalls?: SerializedHistoryToolCall[];
  toolUseId?: string;
  toolName?: string;
  isError?: boolean;
  /** Wall-clock epoch ms when the message was created (see MessageMeta.createdAt). */
  createdAt?: number;
  /** User-visible text when durable content carries routing/provenance wrappers. */
  displayText?: string;
  /** Skill route provenance for user-turn replay. */
  routeSkill?: NonNullable<MessageMeta["routeSkill"]>;
  /** Proactive/plugin imported-trigger provenance for card replay. */
  importedTrigger?: SerializedImportedTriggerMeta;
  /** Tool result display metadata for live/reload parity. */
  toolDisplay?: SerializedToolDisplayMeta;
  /** Turn-aggregate stats — only on turn-final assistant messages. */
  turnSummary?: SerializedTurnSummary;
  /** Checkpoint metrics — only on compactBoundary user messages. */
  checkpointMeta?: SerializedCheckpointMeta;
  /** Issue #911 system-notice marker — assistant entries that are host
   *  notifications, rendered with destructive styling in the UI. */
  systemNotice?: NonNullable<MessageMeta["systemNotice"]>;
};

export function serializeHistoryMessage(
  m: GenericMessage,
  index: number,
): SerializedHistoryMessage {
  const content =
    m.role === "user"
      ? userContentText(m.content)
      : m.role === "tool_result"
        ? normalizeProviderToolAliasText(maskSensitiveData(m.content).masked)
        : normalizeProviderToolAliasText(m.content);
  const meta = m.meta as MessageMeta | undefined;
  const toolDisplay = serializeToolDisplay(meta?.toolDisplay);
  const importedTrigger = serializeImportedTrigger(meta?.importedTrigger);
  const systemNotice = serializeSystemNotice(meta?.systemNotice);
  const routeSkill = serializeRouteSkill(meta?.routeSkill);
  const displayText = typeof meta?.displayText === "string" ? meta.displayText : undefined;
  const createdAt =
    typeof meta?.createdAt === "number" && Number.isFinite(meta.createdAt)
      ? meta.createdAt
      : undefined;
  const metaFields = {
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(displayText !== undefined ? { displayText } : {}),
    ...(routeSkill !== undefined ? { routeSkill } : {}),
    ...(importedTrigger !== undefined ? { importedTrigger } : {}),
    ...(toolDisplay !== undefined ? { toolDisplay } : {}),
    ...(m.meta?.turnSummary !== undefined ? { turnSummary: m.meta.turnSummary } : {}),
    ...(m.meta?.checkpointMeta !== undefined ? { checkpointMeta: m.meta.checkpointMeta } : {}),
    ...(systemNotice !== undefined ? { systemNotice } : {}),
  };
  const base = {
    index,
    role: m.role,
    // Renderer history replay operates on visible text. Multimodal user
    // content is flattened to the same placeholders used by export/search,
    // while assistant/tool structural fields below are passed through intact.
    content,
    ...metaFields,
  };

  if (m.role === "assistant") {
    return {
      ...base,
      ...(m.thought !== undefined
        ? { thought: normalizeProviderToolAliasText(m.thought) }
        : {}),
      ...(m.toolCalls !== undefined
        ? {
            toolCalls: m.toolCalls.map((toolCall) => ({
              ...toolCall,
              name: normalizeProviderToolAliasName(toolCall.name),
            })),
          }
        : {}),
    };
  }

  if (m.role === "tool_result") {
    return {
      ...base,
      toolUseId: m.toolUseId,
      ...(m.toolName !== undefined
        ? { toolName: normalizeProviderToolAliasName(m.toolName) }
        : {}),
      ...(m.isError !== undefined ? { isError: m.isError } : {}),
    };
  }

  return base;
}

function serializeRouteSkill(
  routeSkill: MessageMeta["routeSkill"] | undefined,
): NonNullable<MessageMeta["routeSkill"]> | undefined {
  if (!routeSkill || typeof routeSkill.skillId !== "string") return undefined;
  if (!/^[a-zA-Z0-9_-]+$/.test(routeSkill.skillId)) return undefined;
  return { skillId: routeSkill.skillId };
}

function serializeImportedTrigger(
  importedTrigger: MessageMeta["importedTrigger"] | undefined,
): SerializedImportedTriggerMeta | undefined {
  if (!importedTrigger) return undefined;
  if (!isOverlayTriggerOrigin(importedTrigger.source)) return undefined;
  if (
    typeof importedTrigger.sessionId !== "string" ||
    typeof importedTrigger.prompt !== "string" ||
    typeof importedTrigger.summary !== "string" ||
    typeof importedTrigger.importedAt !== "string" ||
    typeof importedTrigger.toolCallCount !== "number" ||
    !Number.isInteger(importedTrigger.toolCallCount) ||
    importedTrigger.toolCallCount < 0
  ) {
    return undefined;
  }
  return {
    sessionId: importedTrigger.sessionId,
    source: importedTrigger.source,
    prompt: importedTrigger.prompt,
    summary: importedTrigger.summary,
    toolCallCount: importedTrigger.toolCallCount,
    importedAt: importedTrigger.importedAt,
  };
}

function serializeToolDisplay(
  toolDisplay: MessageMeta["toolDisplay"] | undefined,
): SerializedToolDisplayMeta | undefined {
  if (!toolDisplay) return undefined;
  // Persisted JSONL is user-writable. Replaying uiPayload would mount MCP UI
  // resources and cross back into host IPC without proof that this row came from
  // an actual tool execution, so persisted replay keeps only inert timing data.
  const durationMs =
    typeof toolDisplay.durationMs === "number" &&
    Number.isFinite(toolDisplay.durationMs) &&
    toolDisplay.durationMs >= 0
      ? toolDisplay.durationMs
      : undefined;
  if (durationMs !== undefined) {
    return { durationMs };
  }
  return undefined;
}

function serializeSystemNotice(
  systemNotice: MessageMeta["systemNotice"] | undefined,
): NonNullable<MessageMeta["systemNotice"]> | undefined {
  return systemNotice === "context-error" ||
    systemNotice === "stream-error" ||
    systemNotice === "interrupted"
    ? systemNotice
    : undefined;
}
