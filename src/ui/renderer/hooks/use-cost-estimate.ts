import { useMemo } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { costTier, estimateTokens, estimateTurnCost } from "../../../lib/cost-estimator.js";
import {
  computeCost,
  lookupBillablePricingOptional,
  lookupPricing,
  type ModelPricing,
  type PricingVendor,
} from "../../../shared/pricing-data.js";
import { estimateMultimodalTokenOverhead } from "../../../shared/multimodal-token-estimate.js";
import type { ComposedOutgoing } from "../utils/compose.js";

/**
 * Cost estimate hook.
 *
 * Returns the pre-send cost estimate + badge color for the draft input.
 * The expensive history serialization only depends on `entries`, so we
 * memo it separately keyed on length + last-entry identity (performance fix
 * pattern) — typing a draft in long sessions doesn't re-serialize the
 * whole conversation.
 */
export function useCostEstimate(params: {
  entries: ChatEntry[];
  question: string;
  llmVendor: string;
  llmModel: string;
  maxOutputTokens: number;
  composeOutgoing: (raw: string) => Pick<ComposedOutgoing, "text"> & Partial<Pick<ComposedOutgoing, "attachments">>;
}) {
  const { entries, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing } = params;

  const contextCarrierTokens = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.kind === "turn_summary" || entry?.kind === "context_usage") {
        return Math.max(0, entry.tokensIn);
      }
    }
    return undefined;
  }, [entries.length, entries[entries.length - 1]]);

  const historySerialized = useMemo(() => {
    if (contextCarrierTokens !== undefined) return [];
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
  }, [contextCarrierTokens, entries.length, entries[entries.length - 1]]);

  const costEstimate = useMemo(() => {
    const pricing = lookupBillablePricingOptional(llmVendor, llmModel);
    const contextPricing = pricing ?? lookupPricing(llmVendor, llmModel);
    const composed = question ? composeOutgoing(question) : { text: "", attachments: [] };
    const draft = composed.text;
    const attachmentTokens = estimateMultimodalTokenOverhead(composed.attachments ?? []);
    const pricingVendor = toPricingVendor(llmVendor);
    if (contextCarrierTokens !== undefined) {
      const draftTokens = draft ? estimateTokens(JSON.stringify({ role: "user", content: draft })) : 0;
      const inputTokens = contextCarrierTokens + draftTokens + attachmentTokens;
      const outputTokens = Math.max(0, maxOutputTokens);
      const { inputCost, outputCost, total } = pricing
        ? computeEstimatedCost(inputTokens, outputTokens, pricing, pricingVendor)
        : { inputCost: 0, outputCost: 0, total: 0 };
      return {
        inputTokens,
        outputTokens,
        inputCost,
        outputCost,
        total,
        pricingKnown: !!pricing,
      };
    }
    const estimated = estimateTurnCost({ historySerialized, draft, maxOutputTokens, pricing: pricing ?? contextPricing });
    const inputTokens = estimated.inputTokens + attachmentTokens;
    if (!pricing) {
      return {
        ...estimated,
        inputTokens,
        inputCost: 0,
        outputCost: 0,
        total: 0,
        pricingKnown: false,
      };
    }
    return {
      ...estimated,
      inputTokens,
      ...computeEstimatedCost(inputTokens, estimated.outputTokens, pricing, pricingVendor),
      pricingKnown: true,
    };
  }, [contextCarrierTokens, historySerialized, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing]);

  const costBadgeClass = useMemo(() => {
    if (costEstimate.pricingKnown === false) return "text-muted-foreground";
    const t = costTier(costEstimate.total);
    if (t === "trivial") return "text-muted-foreground";
    if (t === "low") return "text-success";
    if (t === "medium") return "text-warning";
    return "text-destructive";
  }, [costEstimate.pricingKnown, costEstimate.total]);

  return { costEstimate, costBadgeClass };
}

const PRICING_VENDORS = new Set<PricingVendor>([
  "claude",
  "openai",
  "gemini",
  "copilot",
  "azure-foundry",
  "vertex-ai",
]);

function toPricingVendor(vendor: string): PricingVendor {
  return PRICING_VENDORS.has(vendor as PricingVendor)
    ? vendor as PricingVendor
    : "openai";
}

function computeEstimatedCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
  vendor: PricingVendor,
): { inputCost: number; outputCost: number; total: number } {
  const inputCost = computeCost({ inputTokens, outputTokens: 0 }, pricing, vendor);
  const total = computeCost({ inputTokens, outputTokens }, pricing, vendor);
  return {
    inputCost,
    outputCost: Math.max(0, total - inputCost),
    total,
  };
}
