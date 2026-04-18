/**
 * Shared vendor capability flags — pure, browser-safe.
 *
 * Single source of truth for which LLM vendors expose a "thinking" /
 * extended-reasoning channel as an always-on capability. OpenAI-family
 * vendors (openai, copilot, azure-foundry) gate thinking on specific
 * model IDs rather than the vendor itself; use `modelSupportsThinking`
 * for the per-model check.
 */

/** Vendors where every model exposes thinking. */
export const THINKING_CAPABLE_VENDORS: ReadonlySet<string> = new Set([
  "claude",
  "gemini",
  "vertex-ai",
]);

/** OpenAI-family vendors that gate thinking on the model ID. */
const MODEL_GATED_THINKING_VENDORS: ReadonlySet<string> = new Set([
  "openai",
  "copilot",
  "azure-foundry",
]);

/** Model-ID prefixes/substrings in the OpenAI family that support thinking. */
function modelHasOpenAiThinking(model: string): boolean {
  const m = (model || "").toLowerCase();
  return m.includes("gpt-5") || m.includes("o1") || m.includes("o3") || m.includes("o4");
}

/**
 * Returns true if the given vendor+model combination exposes a thinking
 * channel. Shared between renderer and engine so toggles stay in sync.
 */
export function vendorSupportsThinking(vendor: string, model: string): boolean {
  if (THINKING_CAPABLE_VENDORS.has(vendor)) return true;
  if (MODEL_GATED_THINKING_VENDORS.has(vendor)) return modelHasOpenAiThinking(model);
  return false;
}
