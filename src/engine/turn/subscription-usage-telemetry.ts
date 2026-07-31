import type { GenericMessage } from "../llm/types.js";
import { estimateMessageTokensForWire } from "../auto-compact.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type SubscriptionChatRuntimeSelection,
  type SubscriptionUsageTelemetry,
} from "../../shared/subscription-runtime.js";
import type { StreamCollectResult } from "./stream-collector.js";

type CompletedSubscriptionRound = Extract<StreamCollectResult, { kind: "ok" }>;

function estimateLocalSubscriptionUsage(params: {
  provider: SubscriptionChatRuntimeSelection["provider"];
  model: string;
  inputTokens: number;
  assistant: GenericMessage;
}): SubscriptionUsageTelemetry | undefined {
  const inputTokens = Number.isSafeInteger(params.inputTokens) && params.inputTokens >= 0
    ? params.inputTokens
    : 0;
  const outputTokens = estimateMessageTokensForWire(params.assistant);
  return normalizeSubscriptionUsageTelemetry({
    provider: params.provider,
    model: params.model,
    source: "local-estimate",
    billable: false,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  });
}

/** Collects exact provider reports or the shared wire-shape fallback per round. */
export function createSubscriptionUsageCollector() {
  const segments: SubscriptionUsageTelemetry[] = [];
  return {
    record(
      runtime: SubscriptionChatRuntimeSelection | undefined,
      stream: CompletedSubscriptionRound,
      inputTokens: number,
    ): void {
      if (!runtime) return;
      const reportedUsage = stream.subscriptionUsage
        && stream.subscriptionUsage.provider === runtime.provider
        ? normalizeSubscriptionUsageTelemetry(stream.subscriptionUsage)
        : undefined;
      const usage = reportedUsage ?? estimateLocalSubscriptionUsage({
        provider: runtime.provider,
        model: runtime.model ?? "default",
        inputTokens,
        assistant: {
          role: "assistant",
          content: stream.text,
          ...(stream.thought ? { thought: stream.thought } : {}),
          ...(stream.thinkingBlocks.length > 0 ? { thinkingBlocks: stream.thinkingBlocks } : {}),
          ...(stream.toolCalls.length > 0 ? { toolCalls: stream.toolCalls } : {}),
        },
      });
      if (usage) segments.push(usage);
    },
    get values(): SubscriptionUsageTelemetry[] {
      return [...segments];
    },
  };
}

/** Keeps subscription telemetry separate from API usage and price calculations. */
export function aggregateSubscriptionUsage(segments: readonly SubscriptionUsageTelemetry[]) {
  return segments.reduce((total, segment) => ({
    inputTokens: total.inputTokens + segment.inputTokens,
    outputTokens: total.outputTokens + segment.outputTokens,
    totalTokens: total.totalTokens + segment.totalTokens,
    cacheReadTokens: total.cacheReadTokens + (segment.cacheReadTokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (segment.cacheWriteTokens ?? 0),
    reasoningOutputTokens: total.reasoningOutputTokens + (segment.reasoningOutputTokens ?? 0),
  }), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningOutputTokens: 0,
  });
}
