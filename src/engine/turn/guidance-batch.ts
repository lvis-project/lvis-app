/**
 * How a mid-turn guidance batch is formed, bounded, and attributed.
 *
 * Guidance reaches the receiver as a user-role message, which is how the model
 * must see it — but a sub-agent's report is not something the user wrote, and
 * the transcript has to say so. Forming the batch and attributing it live
 * together here: the live renderer frame and the persisted history meta are two
 * halves of one decision, and splitting them would let a reloaded session render
 * a different bubble than the live turn had shown.
 */
import { t } from "../../i18n/index.js";
import type { MessageMeta } from "../llm/types.js";
import { GUIDE_JOINED_MAX_CHARS } from "./guidance-limits.js";
import type { GuidanceInjectionSource, TurnCallbacks } from "./types.js";

/**
 * Drain the queue into one bounded message, oldest entries first.
 *
 * Truncation is from the HEAD so the most recent guides survive (older ones may
 * already be superseded), and the drop is surfaced by a leading marker so the
 * model is not left reasoning over silently missing context. Callers must still
 * fire `onDropped` for every returned `dropped` entry.
 */
export function truncateGuidanceBatch<T extends { text: string }>(
  queue: readonly T[],
): { kept: T[]; dropped: T[]; joined: string } {
  const kept = [...queue];
  const dropped: T[] = [];
  let joined = kept.map((entry) => entry.text).join("\n\n");
  let truncatedCount = 0;
  while (joined.length > GUIDE_JOINED_MAX_CHARS && kept.length > 1) {
    const removed = kept.shift();
    if (removed) dropped.push(removed);
    truncatedCount += 1;
    joined = kept.map((entry) => entry.text).join("\n\n");
  }
  return {
    kept,
    dropped,
    joined: truncatedCount > 0
      ? t("be_conversationLoop.guidanceTruncationMarker", { count: truncatedCount, joined })
      : joined,
  };
}

/**
 * Attribute a batch to a sub-agent only when EVERY entry came from one.
 *
 * A batch that also carried the user's own mid-turn guide is still the user's
 * message; labelling it a child report would credit the wrong author for text
 * the user typed.
 */
export function subAgentSourceForBatch(
  entries: readonly { subAgentTitle?: string }[],
): GuidanceInjectionSource | undefined {
  if (entries.length === 0) return undefined;
  const titles = [...new Set(entries.map((entry) => entry.subAgentTitle))];
  if (titles.includes(undefined)) return undefined;
  return {
    kind: "sub-agent",
    // Several children in one batch: report it as a child report, unnamed,
    // rather than crediting one child for another's work.
    ...(titles.length === 1 ? { title: titles[0]! } : {}),
  };
}

/** Persisted counterpart of {@link subAgentSourceForBatch}, for reload replay. */
export function subAgentHistoryMeta(
  source: GuidanceInjectionSource | undefined,
): { meta: MessageMeta } | Record<string, never> {
  if (!source) return {};
  return {
    meta: {
      subAgentReport: source.title === undefined ? {} : { title: source.title },
    },
  };
}

/** Notify the renderer, keeping the one-argument shape for user-authored guides. */
export function notifyGuidanceInjected(
  callback: TurnCallbacks["onGuidanceInjected"],
  text: string,
  source: GuidanceInjectionSource | undefined,
): void {
  if (source) callback?.(text, source);
  else callback?.(text);
}
