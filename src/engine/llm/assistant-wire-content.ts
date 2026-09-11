import type { LLMVendor, ThinkingBlock } from "./types.js";

/**
 * Select signed reasoning blocks that the active route can replay. Callers
 * without a route conservatively retain replayable blocks for estimation.
 * Display-only thought is never request content.
 */
export function selectAssistantWireThinkingBlocks(
  blocks: readonly ThinkingBlock[] | undefined,
  vendor?: LLMVendor,
): ThinkingBlock[] {
  if (vendor !== undefined && vendor !== "claude") return [];
  return (blocks ?? []).filter(
    (block) => typeof block.signature === "string" && block.signature.length > 0,
  );
}
