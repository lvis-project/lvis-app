import { useMemo } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { costTier, estimateTurnCost } from "../../../lib/cost-estimator.js";
import { lookupPricing } from "../../../shared/pricing-data.js";
import type { ComposedOutgoing } from "../utils/compose.js";

/**
 * Cost estimate hook.
 *
 * Returns the pre-send cost estimate + badge color for the draft input.
 * The expensive history serialization only depends on `entries`, so we
 * memo it separately keyed on length + last-entry identity (Phase 1 fix
 * pattern) — typing a draft in long sessions doesn't re-serialize the
 * whole conversation.
 */
export function useCostEstimate(params: {
  entries: ChatEntry[];
  question: string;
  llmVendor: string;
  llmModel: string;
  maxOutputTokens: number;
  composeOutgoing: (raw: string) => Pick<ComposedOutgoing, "text">;
}) {
  const { entries, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing } = params;

  const historySerialized = useMemo(() => {
    return entries.map((e) => {
      if (e.kind === "user" || e.kind === "assistant" || e.kind === "reasoning" || e.kind === "system") {
        return JSON.stringify({ kind: e.kind, text: (e as { text?: string }).text ?? "" });
      }
      if (e.kind === "tool_group") {
        return JSON.stringify({
          kind: "tool_group",
          tools: (e.tools ?? []).map((t: { input?: unknown; result?: unknown }) => ({
            input: t.input ?? {},
            result: t.result ?? "",
          })),
        });
      }
      return "";
    }).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, entries[entries.length - 1]]);

  const costEstimate = useMemo(() => {
    const pricing = lookupPricing(llmVendor, llmModel);
    const draft = question ? composeOutgoing(question).text : "";
    return estimateTurnCost({ historySerialized, draft, maxOutputTokens, pricing });
  }, [historySerialized, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing]);

  const costBadgeClass = useMemo(() => {
    const t = costTier(costEstimate.total);
    if (t === "trivial") return "text-muted-foreground";
    if (t === "low") return "text-success";
    if (t === "medium") return "text-warning";
    return "text-destructive";
  }, [costEstimate.total]);

  return { costEstimate, costBadgeClass };
}
