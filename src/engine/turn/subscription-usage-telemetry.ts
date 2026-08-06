import type { GenericMessage } from "../llm/types.js";
import { estimateMessageTokensForWire } from "../auto-compact.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type SubscriptionChatRuntimeSelection,
  type SubscriptionUsageTelemetry,
} from "../../shared/subscription-runtime.js";
import type { StreamCollectResult } from "./stream-collector.js";

type CompletedSubscriptionRound = Extract<StreamCollectResult, { kind: "ok" }>;

export interface SubscriptionUsageCollector {
  record(
    runtime: SubscriptionChatRuntimeSelection | undefined,
    stream: CompletedSubscriptionRound,
    inputTokens: number,
  ): SubscriptionUsageTelemetry | undefined;
  readonly values: SubscriptionUsageTelemetry[];
}

/** Mutable engine fields calibrated only from terminal Codex provider reports. */
export interface SubscriptionContextTelemetryTarget {
  readonly lastRoundInputProjection: { readonly totalTokens: number } | null;
  lastRoundProviderInputTokens: number;
  lastContextInputTokens: number;
  lastContextInputProjectionTokens: number;
  lastReportedSubscriptionContextWindow: {
    readonly provider: "codex";
    readonly model: string;
    readonly contextWindow: number;
  } | null;
}

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
export function createSubscriptionUsageCollector(): SubscriptionUsageCollector {
  const segments: SubscriptionUsageTelemetry[] = [];
  return {
    record(
      runtime: SubscriptionChatRuntimeSelection | undefined,
      stream: CompletedSubscriptionRound,
      inputTokens: number,
    ): SubscriptionUsageTelemetry | undefined {
      if (!runtime) return undefined;
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
      return usage;
    },
    get values(): SubscriptionUsageTelemetry[] {
      return [...segments];
    },
  };
}

/**
 * Records each subscription round while allowing only a terminal Codex provider
 * report to calibrate engine context state. The caller resets the provider
 * baseline before each stream, so a telemetry-less final round remains local.
 */
export function recordSubscriptionRoundTelemetry(
  target: SubscriptionContextTelemetryTarget,
  collector: SubscriptionUsageCollector,
  runtime: SubscriptionChatRuntimeSelection | undefined,
  stream: CompletedSubscriptionRound,
  isTerminal: boolean,
): void {
  const usage = collector.record(
    runtime,
    stream,
    target.lastRoundInputProjection?.totalTokens ?? 0,
  );
  if (
    !isTerminal
    || usage?.provider !== "codex"
    || usage.source !== "provider-reported"
  ) return;

  target.lastRoundProviderInputTokens = usage.inputTokens;
  target.lastContextInputTokens = usage.inputTokens;
  target.lastContextInputProjectionTokens =
    target.lastRoundInputProjection?.totalTokens ?? 0;
  if (usage.contextWindow !== undefined) {
    target.lastReportedSubscriptionContextWindow = {
      provider: "codex",
      model: usage.model,
      contextWindow: usage.contextWindow,
    };
  }
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
