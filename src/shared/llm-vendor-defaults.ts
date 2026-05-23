/**
 * Single source of truth for the LLM vendor list and per-vendor default
 * configuration block. Consumed by `data/settings-store.ts` (to seed
 * DEFAULT_SETTINGS.llm.vendors) and by the renderer's `VENDORS` constant
 * (for the model dropdown shown in the settings dialog).
 *
 * Pure, browser-safe — no Electron / Node imports.
 */

export const LLM_VENDORS = [
  "claude",
  "openai",
  "gemini",
  "copilot",
  "azure-foundry",
  "vertex-ai",
] as const;

export type LLMVendor = (typeof LLM_VENDORS)[number];

/**
 * Canonical fallback vendor — used both as the seed for
 * `DEFAULT_SETTINGS.llm.provider` and as the boundary-narrowing fallback
 * when a corrupt settings.json or IPC payload delivers an out-of-union
 * value. Centralizing here keeps the two in lockstep; flipping the
 * default elsewhere without updating the narrower would otherwise drift
 * silently.
 *
 * 2026-05-19 — flipped from `"claude"` to `"azure-foundry"` so the
 * default install lands on the internal organization demo target. The Z onboarding
 * chain ScenarioShowcase + LoginModal still let the user pick any vendor
 * during first-boot; this is purely the seed for `settings.json` writes
 * + every boundary-narrowing fallback. Production builds shipping with
 * `LVIS_DEMO_VENDOR` set continue to honor the env value via
 * `getDemoActiveVendor()` in `demo-credentials.ts` (env overrides the
 * default for the active session).
 */
export const DEFAULT_LLM_VENDOR: LLMVendor = "azure-foundry";

/**
 * Runtime type guard — narrows `unknown` to `LLMVendor`. Use at every
 * boundary that accepts vendor strings from outside the type system:
 * settings.json on disk, IPC payloads, query params, deep-linked URLs,
 * etc. Internal code that already has a `LLMVendor` typed value should
 * NOT need this — the type system carries the proof.
 *
 * Empty / non-string / unknown-string inputs return false. The set is
 * the same `LLM_VENDORS` constant used to seed `DEFAULT_SETTINGS.llm.
 * vendors`, so a `true` return is a hard guarantee that downstream
 * `vendors[v]` lookups won't hit `undefined`.
 */
export function isLLMVendor(v: unknown): v is LLMVendor {
  return (
    typeof v === "string" &&
    (LLM_VENDORS as readonly string[]).includes(v)
  );
}

/**
 * Per-vendor configuration block. Every vendor's block in `LLMSettings.vendors`
 * carries its own complete copy of these fields, so switching the active
 * vendor never inherits stale values from the previous one.
 *
 * Optional fields are vendor-specific: `baseUrl` is required only for
 * `azure-foundry`; `vertexProject` / `vertexLocation` only meaningful for
 * `vertex-ai`.
 *
 * CHANGELOG (CTRL simplification):
 *   Removed `temperature`, `maxOutputTokens`, `seed`, `responseFormat`,
 *   `stopSequences` — modern frontier models (GPT-5+, Claude 4+) deprecate
 *   or ignore these sampling/decoding params. Vendor SDK defaults are used.
 *   Persisted values for these keys are silently dropped on next write.
 *
 * CHANGELOG (#893 top-level authMode promotion):
 *   Removed `authMode` — login now wraps vendor selection itself (one switch
 *   for the whole app, not per-vendor). The top-level `LLMSettings.authMode`
 *   is the new source of truth. Legacy per-vendor `authMode` keys on disk
 *   are migrated up in `loadSettings()` and dropped on next write.
 */
export interface LLMVendorSettings {
  model: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
  enableThinking: boolean;
  thinkingBudgetTokens: number;
}

const DEFAULT_MODEL: Record<LLMVendor, string> = {
  claude: "claude-sonnet-4-6",
  openai: "gpt-5.4-mini",
  gemini: "gemini-2.0-flash",
  copilot: "gpt-4o",
  "azure-foundry": "gpt-4o",
  "vertex-ai": "gemini-2.5-flash",
};

export const LLM_VENDOR_MODEL_OPTIONS: Readonly<Record<LLMVendor, readonly string[]>> =
  Object.freeze({
    claude: [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
      "claude-opus-4-5",
    ],
    openai: [
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.4-nano",
      "gpt-5.4-pro",
      "gpt-4.1",
      "gpt-4.1-mini",
      "o4-mini",
      "o3",
      "gpt-4o",
    ],
    gemini: [
      "gemini-2.0-flash",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash-lite",
    ],
    copilot: [
      "gpt-4o",
      "gpt-5.4-nano",
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-4.1",
      "gpt-4.1-mini",
      "claude-sonnet-4-6",
    ],
    "azure-foundry": [
      "gpt-4o",
      "gpt-5.4-nano",
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-4.1",
      "gpt-4.1-mini",
    ],
    "vertex-ai": [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemini-2.5-flash-lite",
    ],
  });

/**
 * True when `model` is a selectable model ID for `vendor` per
 * {@link LLM_VENDOR_MODEL_OPTIONS} (the authoritative option list the
 * settings UI offers — there is no other way to provision a model for a
 * vendor). Used by `SubAgentRunner.resolveSubAgentModel` to validate an
 * agent profile's explicit `model:` frontmatter before applying it as a
 * child `modelOverride`, so an unavailable ID falls back to the parent
 * model instead of hard-failing the sub-agent on a non-retryable
 * provider model-not-found.
 */
export function isModelAvailableForVendor(
  vendor: string,
  model: string,
): boolean {
  if (!isLLMVendor(vendor)) return false;
  return LLM_VENDOR_MODEL_OPTIONS[vendor].includes(model);
}

function defaultBlock(vendor: LLMVendor): LLMVendorSettings {
  const model = DEFAULT_MODEL[vendor];
  return {
    model,
    enableThinking: true,
    thinkingBudgetTokens: 10_000,
  };
}

export const LLM_VENDOR_DEFAULTS: Readonly<Record<LLMVendor, LLMVendorSettings>> =
  Object.freeze(
    Object.fromEntries(LLM_VENDORS.map((v) => [v, defaultBlock(v)])) as Record<
      LLMVendor,
      LLMVendorSettings
    >,
  );

export function freshVendorBlocks(): Record<LLMVendor, LLMVendorSettings> {
  return Object.fromEntries(
    LLM_VENDORS.map((v) => [v, { ...LLM_VENDOR_DEFAULTS[v] }]),
  ) as Record<LLMVendor, LLMVendorSettings>;
}
