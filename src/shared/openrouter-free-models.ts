export const OPENROUTER_FREE_ROUTER_MODEL_ID = "openrouter/free";
export const OPENROUTER_FREE_MODEL_VARIANT_SUFFIX = ":free";

export function isOpenRouterFreeModel(model: unknown): model is string {
  if (typeof model !== "string") return false;
  const trimmed = model.trim();
  return (
    trimmed === OPENROUTER_FREE_ROUTER_MODEL_ID ||
    trimmed.endsWith(OPENROUTER_FREE_MODEL_VARIANT_SUFFIX)
  );
}
