import type { LLMVendor, TokenUsage, TokenUsageByModel } from "../llm/types.js";

/** Appends an API-key usage segment only when the serving identity is known. */
export function appendUsageForServingModel(
  usageByModel: TokenUsageByModel[],
  vendorProvider: LLMVendor | undefined,
  vendorModel: string | undefined,
  usage: TokenUsage,
): void {
  if (vendorProvider === undefined || vendorModel === undefined) {
    return;
  }
  usageByModel.push({
    vendorProvider,
    vendorModel,
    tokenUsage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    },
  });
}
