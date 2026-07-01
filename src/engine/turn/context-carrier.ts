/**
 * Context-fill carrier helpers (C9 Wave 1).
 *
 * Pure functions that (a) recover the latest persisted context-token count from
 * a message array and (b) attach a `checkpointMeta.contextTokensAfter` carrier
 * to compacted / content-truncated histories. Extracted verbatim from
 * `conversation-loop.ts` — no `this` dependency.
 */
import type { GenericMessage, MessageMeta } from "../llm/types.js";
import { estimateMessagesTokens } from "../auto-compact.js";
import { CompressionStatus } from "../../shared/compact-status.js";
import { t } from "../../i18n/index.js";

export function latestPersistedContextTokens(messages: GenericMessage[]): number {
  let latestTurnSummaryTokens = 0;
  let latestTurnSummaryCreatedAt = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const contextTokensAfter = messages[i]?.meta?.checkpointMeta?.contextTokensAfter;
    if (
      typeof contextTokensAfter === "number" &&
      Number.isFinite(contextTokensAfter) &&
      contextTokensAfter > 0
    ) {
      const compactedAt = messages[i]?.meta?.createdAt;
      if (
        latestTurnSummaryTokens > 0 &&
        typeof compactedAt === "number" &&
        Number.isFinite(compactedAt) &&
        latestTurnSummaryCreatedAt > compactedAt
      ) {
        return latestTurnSummaryTokens;
      }
      return Math.floor(contextTokensAfter);
    }
    const tokensIn = messages[i]?.meta?.turnSummary?.tokensIn;
    if (typeof tokensIn === "number" && Number.isFinite(tokensIn) && tokensIn > 0) {
      latestTurnSummaryTokens = Math.floor(tokensIn);
      const createdAt = messages[i]?.meta?.createdAt;
      latestTurnSummaryCreatedAt =
        typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0;
    }
  }
  return latestTurnSummaryTokens;
}

export function compactedHistoryWithContextCarrier(
  messages: GenericMessage[],
  contextTokensAfter: number,
): GenericMessage[] {
  let contextCarrierAttached = false;
  return messages.map((message) => {
    const meta = message.meta;
    if (!meta) return message;
    const nextMeta: MessageMeta = { ...meta };
    delete nextMeta.turnSummary;
    if (!contextCarrierAttached && nextMeta.checkpointMeta) {
      nextMeta.checkpointMeta = {
        ...nextMeta.checkpointMeta,
        contextTokensAfter,
      };
      contextCarrierAttached = true;
    }
    return { ...message, meta: nextMeta };
  });
}

export function contentTruncatedHistoryWithContextCarrier(params: {
  messages: GenericMessage[];
  compactNum: number;
  trigger: "auto-compact" | "manual";
  removedCount: number;
  freedTokens: number;
  estimatedAfter: number;
  truncatedDir?: string;
}): { history: GenericMessage[]; contextTokensAfter: number; createdAt: string } {
  const createdAt = new Date().toISOString();
  const checkpointContent = `[compact #${params.compactNum}: content truncated]`;
  const checkpoint: GenericMessage = {
    role: "user",
    content: checkpointContent,
    meta: {
      compactBoundary: true,
      compactNum: params.compactNum,
      removedCount: params.removedCount,
      compactedAt: createdAt,
      createdAt: new Date(createdAt).getTime(),
      checkpointMeta: {
        removedMessages: params.removedCount,
        freedTokens: params.freedTokens,
        compactNum: params.compactNum,
        trigger: params.trigger,
        compactStatus: CompressionStatus.CONTENT_TRUNCATED,
        summary: t("be_conversationLoop.contentTruncatedSummary", { count: params.removedCount }),
        ...(params.truncatedDir !== undefined ? { truncatedDir: params.truncatedDir } : {}),
      },
    },
  };
  const contextTokensAfter = params.estimatedAfter + estimateMessagesTokens([checkpoint]);
  return {
    history: compactedHistoryWithContextCarrier([checkpoint, ...params.messages], contextTokensAfter),
    contextTokensAfter,
    createdAt,
  };
}
