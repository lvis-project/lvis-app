// React-free constants extracted from src/renderer.tsx.

// ── Toast / Banner TTL ────────────────────────────────────────────────────────
/**
 * Short auto-dismiss duration for simple one-line toasts (ms).
 * Use when the message is a brief status (e.g. drag-drop result, copy
 * confirmation) that does not require extended reading time.
 */
export const SHORT_TOAST_TTL_MS = 3000;

/**
 * Default auto-dismiss duration for inline toasts and banners (ms).
 * Most callsites use this value; those that need a longer read window
 * (complex permission banners, MCP status) override explicitly with a comment.
 */
export const DEFAULT_TOAST_TTL_MS = 4000;

/**
 * Long auto-dismiss duration for toasts that require extended reading (ms).
 * Use for multi-line banners, error details, or Korean prose longer than
 * ~8 words that needs comfortable reading time.
 */
export const LONG_TOAST_TTL_MS = 5000;

import type { ExecMode } from "./types.js";
import {
  DEFAULT_VISIBLE_LLM_VENDOR_IDS,
  LLM_VENDOR_DEFAULTS,
  LLM_VENDOR_MODEL_OPTIONS,
  LLM_VENDORS,
  MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS,
  OPENAI_COMPATIBLE_PRESET_VENDOR_IDS,
  OPENAI_COMPATIBLE_VENDOR_PRESETS,
  isLLMVendor,
  type OpenAICompatiblePresetVendor,
  type LLMVendor,
} from "../../shared/llm-vendor-defaults.js";
import { t } from "../../i18n/runtime.js";

export const SOURCE_BADGE: Record<string, string> = {
  get builtin() { return t("constants.sourceBadgeBuiltin"); },
  get plugin() { return t("constants.sourceBadgePlugin"); },
  mcp: "MCP",
};

// Settings-dialog UI metadata per vendor. Typed as `Record<LLMVendor, ...>`
// so adding a new entry to `LLM_VENDORS` without updating this object is
// a compile error — keeps the dropdown in lockstep with the canonical
// vendor list. `defaultModel` derives from LLM_VENDOR_DEFAULTS so the
// model selector stays in sync with the data layer's seed values.
export interface VendorUiMeta {
  label: string;
  placeholder: string;
  needsBaseUrl: boolean;
  baseUrlPlaceholder?: string;
}

export interface VendorOption extends VendorUiMeta {
  id: LLMVendor;
  defaultModel: string;
  modelOptions: readonly string[];
}

type VendorOptionFor<T extends LLMVendor> = VendorOption & { id: T };

const CORE_VENDOR_UI: Record<Exclude<LLMVendor, OpenAICompatiblePresetVendor>, VendorUiMeta> = {
  claude: { label: "Anthropic Claude", placeholder: "sk-ant-...", needsBaseUrl: false },
  openai: { label: "OpenAI", placeholder: "sk-...", needsBaseUrl: false },
  gemini: { label: "Google Gemini", placeholder: "AIza...", needsBaseUrl: false },
  copilot: { label: "GitHub Copilot", placeholder: "ghp_...", needsBaseUrl: false },
  "azure-foundry": {
    label: "Azure AI Foundry",
    get placeholder() { return t("constants.vendorAzureFoundryPlaceholder"); },
    needsBaseUrl: true,
    baseUrlPlaceholder: "https://{resource}.openai.azure.com/openai/v1/",
  },
  "vertex-ai": {
    label: "Google Vertex AI",
    get placeholder() { return t("constants.vendorVertexAiPlaceholder"); },
    needsBaseUrl: false,
  },
  "openai-compatible": {
    get label() { return t("constants.vendorOpenAiCompatibleLabel"); },
    get placeholder() { return t("constants.vendorOpenAiCompatiblePlaceholder"); },
    needsBaseUrl: true,
    baseUrlPlaceholder: "http://10.231.108.187:8001/v1",
  },
};

const PRESET_VENDOR_UI = Object.fromEntries(
  OPENAI_COMPATIBLE_PRESET_VENDOR_IDS.map((id) => {
    const preset = OPENAI_COMPATIBLE_VENDOR_PRESETS[id];
    return [
      id,
      {
        label: preset.label,
        placeholder: preset.apiKeyPlaceholder,
        needsBaseUrl: true,
        baseUrlPlaceholder: preset.baseUrl,
      } satisfies VendorUiMeta,
    ];
  }),
) as Record<OpenAICompatiblePresetVendor, VendorUiMeta>;

const VENDOR_UI: Record<LLMVendor, VendorUiMeta> = {
  ...CORE_VENDOR_UI,
  ...PRESET_VENDOR_UI,
};

export const ALL_VENDORS: VendorOption[] = LLM_VENDORS.map((id) => ({
  id,
  ...VENDOR_UI[id],
  defaultModel: LLM_VENDOR_DEFAULTS[id].model,
  modelOptions: LLM_VENDOR_MODEL_OPTIONS[id],
}));

function requireVendorOption<T extends LLMVendor>(id: T): VendorOptionFor<T> {
  const option = ALL_VENDORS.find((vendor) => vendor.id === id);
  if (!option) throw new Error(`Missing LLM vendor metadata: ${id}`);
  return option as VendorOptionFor<T>;
}

export const VENDORS = DEFAULT_VISIBLE_LLM_VENDOR_IDS.map(requireVendorOption);

export const MARKETPLACE_PROVIDER_VENDORS =
  MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS.map(requireVendorOption);

export function getVendorOption(vendorId: string): VendorOption {
  return ALL_VENDORS.find((vendor) => vendor.id === vendorId) ?? VENDORS[0]!;
}

export function visibleVendorsFor(currentVendorIds: readonly string[] = []): VendorOption[] {
  const visible: VendorOption[] = [...VENDORS];
  for (const vendorId of currentVendorIds) {
    if (!isLLMVendor(vendorId)) continue;
    if (visible.some((vendor) => vendor.id === vendorId)) continue;
    const option = getVendorOption(vendorId);
    visible.push(option);
  }
  return visible;
}

export const WEB_PROVIDERS: { id: string; label: string; readonly placeholder: string; needsKey: boolean }[] = [
  { id: "duckduckgo", label: "DuckDuckGo", get placeholder() { return t("constants.webProviderDuckDuckGoPlaceholder"); }, needsKey: false },
  { id: "tavily", label: "Tavily AI", placeholder: "tvly-...", needsKey: true },
  { id: "serper", label: "Serper.dev", get placeholder() { return t("constants.webProviderSerperPlaceholder"); }, needsKey: true },
  { id: "google", label: "Google Search", get placeholder() { return t("constants.webProviderGooglePlaceholder"); }, needsKey: true },
];

// Reasoning effort slider steps. Budget values are chosen to land cleanly in
// both `mapReasoningEffort()` (OpenAI: ≤3000=low, ≤8000=medium, >8000=high)
// and `mapBudgetToEffort()` (Claude adaptive: ≤3000=low, ≤6000=medium,
// ≤16000=high, >16000=max) in vercel/adapter.ts. Keep values in sync if those
// thresholds change.
export const REASONING_EFFORT_STEPS = [
  { get label() { return t("constants.reasoningEffortLow"); }, budget: 2000 },
  { get label() { return t("constants.reasoningEffortMedium"); }, budget: 6000 },
  { get label() { return t("constants.reasoningEffortHigh"); }, budget: 12_000 },
  { get label() { return t("constants.reasoningEffortMax"); }, budget: 24_000 },
] as const;

export function budgetToEffortIndex(budget: number): number {
  let closest = 0;
  let minDiff = Math.abs(REASONING_EFFORT_STEPS[0]!.budget - budget);
  for (let i = 1; i < REASONING_EFFORT_STEPS.length; i++) {
    const diff = Math.abs(REASONING_EFFORT_STEPS[i]!.budget - budget);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  return closest;
}

// Ordered most-restrictive → least-restrictive so the policy picker reads as a


// auto-wired from this mode (handleModeChange), so this is the only permission
// axis the user sets.
export const EXEC_MODE_OPTIONS: { value: ExecMode; readonly label: string; readonly description: string }[] = [
  {
    value: "strict",
    get label() { return t("constants.execModeStrictLabel"); },
    get description() { return t("constants.execModeStrictDesc"); },
  },
  {
    value: "default",
    get label() { return t("constants.execModeDefaultLabel"); },
    get description() { return t("constants.execModeDefaultDesc"); },
  },
  {
    value: "auto",
    get label() { return t("constants.execModeAutoLabel"); },
    get description() { return t("constants.execModeAutoDesc"); },
  },
  {
    value: "allow",
    get label() { return t("constants.execModeAllowLabel"); },
    get description() { return t("constants.execModeAllowDesc"); },
  },
];

// Keep in sync with src/tools/render-html.ts — the server already clamps,
// but reloaded history could deliver forged/NaN values and we must not
// trust them at render time.
export const RENDER_HTML_MIN_HEIGHT = 80;
export const RENDER_HTML_MAX_HEIGHT = 1200;
export const RENDER_HTML_DEFAULT_HEIGHT = 400;
