/**
 * Single source of truth for the LLM vendor list and per-vendor default
 * configuration block. Consumed by `data/settings-store.ts` (to seed
 * DEFAULT_SETTINGS.llm.vendors) and by the renderer's `VENDORS` constant
 * (for the model dropdown shown in the settings dialog).
 *
 * Pure, browser-safe — no Electron / Node imports.
 */

export const OPENAI_COMPATIBLE_PRESET_VENDOR_IDS = [
  "openrouter",
  "deepseek",
  "xai",
  "together",
  "fireworks",
  "groq",
  "poolside",
  "cerebras",
  "sambanova",
  "nebius",
  "baseten",
  "requesty",
  "litellm",
  "huggingface",
  "vercel-ai-gateway",
  "v0",
  "aihubmix",
  "hicap",
  "nousResearch",
  "huawei-cloud-maas",
  "wandb",
  "xiaomi",
  "kilo",
  "zai",
  "zai-coding-plan",
  "qwen",
  "qwen-code",
  "doubao",
  "mistral",
  "moonshot",
  "asksage",
  "ollama",
  "lmstudio",
  "oca",
] as const;

export type OpenAICompatiblePresetVendor =
  (typeof OPENAI_COMPATIBLE_PRESET_VENDOR_IDS)[number];

export interface OpenAICompatibleVendorPreset {
  label: string;
  apiKeyPlaceholder: string;
  baseUrl: string;
  defaultModel: string;
  modelOptions: readonly string[];
}

export const OPENAI_COMPATIBLE_VENDOR_PRESETS: Readonly<
  Record<OpenAICompatiblePresetVendor, OpenAICompatibleVendorPreset>
> = Object.freeze({
  openrouter: {
    label: "OpenRouter",
    apiKeyPlaceholder: "sk-or-...",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.6",
    modelOptions: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.4", "openrouter/free"],
  },
  deepseek: {
    label: "DeepSeek",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-flash",
    modelOptions: ["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
  },
  xai: {
    label: "xAI",
    apiKeyPlaceholder: "xai-...",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.20-0309-non-reasoning",
    modelOptions: ["grok-4.20-0309-non-reasoning", "grok-4"],
  },
  together: {
    label: "Together AI",
    apiKeyPlaceholder: "tog_...",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "Qwen/Qwen3.5-397B-A17B",
    modelOptions: ["Qwen/Qwen3.5-397B-A17B", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  },
  fireworks: {
    label: "Fireworks AI",
    apiKeyPlaceholder: "fw_...",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/kimi-k2p6",
    modelOptions: ["accounts/fireworks/models/kimi-k2p6"],
  },
  groq: {
    label: "Groq",
    apiKeyPlaceholder: "gsk_...",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "moonshotai/kimi-k2-instruct-0905",
    modelOptions: ["moonshotai/kimi-k2-instruct-0905", "llama-3.3-70b-versatile"],
  },
  poolside: {
    label: "Poolside",
    apiKeyPlaceholder: "ps_...",
    baseUrl: "https://inference.poolside.ai/v1",
    defaultModel: "poolside/laguna-m.1",
    modelOptions: ["poolside/laguna-m.1"],
  },
  cerebras: {
    label: "Cerebras",
    apiKeyPlaceholder: "csk-...",
    baseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "zai-glm-4.7",
    modelOptions: ["zai-glm-4.7", "llama3.1-8b"],
  },
  sambanova: {
    label: "SambaNova",
    apiKeyPlaceholder: "sambanova-...",
    baseUrl: "https://api.sambanova.ai/v1",
    defaultModel: "Meta-Llama-3.3-70B-Instruct",
    modelOptions: ["Meta-Llama-3.3-70B-Instruct"],
  },
  nebius: {
    label: "Nebius",
    apiKeyPlaceholder: "nebius_...",
    baseUrl: "https://api.studio.nebius.ai/v1",
    defaultModel: "nvidia/nemotron-3-super-120b-a12b",
    modelOptions: ["nvidia/nemotron-3-super-120b-a12b"],
  },
  baseten: {
    label: "Baseten",
    apiKeyPlaceholder: "baseten_...",
    baseUrl: "https://model-api.baseten.co/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3.1",
    modelOptions: ["deepseek-ai/DeepSeek-V3.1"],
  },
  requesty: {
    label: "Requesty",
    apiKeyPlaceholder: "rq_...",
    baseUrl: "https://router.requesty.ai/v1",
    defaultModel: "openai/gpt-5.4",
    modelOptions: ["openai/gpt-5.4", "anthropic/claude-sonnet-4.6"],
  },
  litellm: {
    label: "LiteLLM",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "http://localhost:4000/v1",
    defaultModel: "gpt-5.4",
    modelOptions: ["gpt-5.4", "claude-sonnet-4-6"],
  },
  huggingface: {
    label: "Hugging Face",
    apiKeyPlaceholder: "hf_...",
    baseUrl: "https://router.huggingface.co/v1",
    defaultModel: "MiniMaxAI/MiniMax-M2.5",
    modelOptions: ["MiniMaxAI/MiniMax-M2.5"],
  },
  "vercel-ai-gateway": {
    label: "Vercel AI Gateway",
    apiKeyPlaceholder: "vck_...",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    defaultModel: "alibaba/qwen3.6-plus",
    modelOptions: ["alibaba/qwen3.6-plus", "anthropic/claude-sonnet-4.6", "openai/gpt-5.4"],
  },
  v0: {
    label: "Vercel V0",
    apiKeyPlaceholder: "v0_...",
    baseUrl: "https://api.v0.dev/v1",
    defaultModel: "v0-1.5-md",
    modelOptions: ["v0-1.5-md"],
  },
  aihubmix: {
    label: "AI Hub Mix",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "https://api.aihubmix.com/v1",
    defaultModel: "gpt-5.4-mini",
    modelOptions: ["gpt-5.4-mini", "claude-sonnet-4-6"],
  },
  hicap: {
    label: "HiCap",
    apiKeyPlaceholder: "hicap_...",
    baseUrl: "https://api.hicap.ai/v1",
    defaultModel: "hicap-pro",
    modelOptions: ["hicap-pro"],
  },
  nousResearch: {
    label: "Nous Research",
    apiKeyPlaceholder: "nr_...",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    defaultModel: "DeepHermes-3-Llama-3-3-70B-Preview",
    modelOptions: ["DeepHermes-3-Llama-3-3-70B-Preview"],
  },
  "huawei-cloud-maas": {
    label: "Huawei Cloud MaaS",
    apiKeyPlaceholder: "huawei_...",
    baseUrl: "https://infer-modelarts.cn-southwest-2.myhuaweicloud.com/v1",
    defaultModel: "DeepSeek-R1",
    modelOptions: ["DeepSeek-R1"],
  },
  wandb: {
    label: "W&B by CoreWeave",
    apiKeyPlaceholder: "wandb_...",
    baseUrl: "https://api.inference.wandb.ai/v1",
    defaultModel: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8",
    modelOptions: ["nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8"],
  },
  xiaomi: {
    label: "Xiaomi",
    apiKeyPlaceholder: "mi_...",
    baseUrl: "https://api.xiaomimimo.com/v1",
    defaultModel: "mimo-v2-omni",
    modelOptions: ["mimo-v2-omni"],
  },
  kilo: {
    label: "Kilo Gateway",
    apiKeyPlaceholder: "kilo_...",
    baseUrl: "https://api.kilo.ai/api/gateway",
    defaultModel: "gpt-5.4",
    modelOptions: ["gpt-5.4", "claude-sonnet-4-6"],
  },
  zai: {
    label: "Z.AI",
    apiKeyPlaceholder: "zhipu_...",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-5v-turbo",
    modelOptions: ["glm-5v-turbo", "glm-4.7"],
  },
  "zai-coding-plan": {
    label: "Z.AI Coding Plan",
    apiKeyPlaceholder: "zhipu_...",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    defaultModel: "glm-5.2",
    modelOptions: ["glm-5.2"],
  },
  qwen: {
    label: "Alibaba Qwen",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus-latest",
    modelOptions: ["qwen-plus-latest", "qwen3-max", "qwen3-coder-plus"],
  },
  "qwen-code": {
    label: "Alibaba Qwen Code",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3-coder-plus",
    modelOptions: ["qwen3-coder-plus", "qwen-plus-latest"],
  },
  doubao: {
    label: "Doubao",
    apiKeyPlaceholder: "ark_...",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-1-5-pro-256k-250115",
    modelOptions: ["doubao-1-5-pro-256k-250115"],
  },
  mistral: {
    label: "Mistral",
    apiKeyPlaceholder: "mistral_...",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-medium-latest",
    modelOptions: ["mistral-medium-latest", "codestral-latest"],
  },
  moonshot: {
    label: "Moonshot",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2-0905-preview",
    modelOptions: ["kimi-k2-0905-preview"],
  },
  asksage: {
    label: "AskSage",
    apiKeyPlaceholder: "asksage_...",
    baseUrl: "https://api.asksage.ai/server",
    defaultModel: "gpt-5.4-mini",
    modelOptions: ["gpt-5.4-mini"],
  },
  ollama: {
    label: "Ollama",
    apiKeyPlaceholder: "ollama",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.3",
    modelOptions: ["llama3.3", "qwen3", "gpt-oss"],
  },
  lmstudio: {
    label: "LM Studio",
    apiKeyPlaceholder: "lm-studio",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    modelOptions: ["local-model"],
  },
  oca: {
    label: "Oracle Code Assist",
    apiKeyPlaceholder: "oca_...",
    baseUrl: "https://code.aiservice.us-chicago-1.oci.oraclecloud.com/20250206/app/litellm",
    defaultModel: "anthropic/claude-3-7-sonnet-20250219",
    modelOptions: ["anthropic/claude-3-7-sonnet-20250219"],
  },
});

const OPENAI_COMPATIBLE_PRESET_VENDOR_SET = new Set<string>(
  OPENAI_COMPATIBLE_PRESET_VENDOR_IDS,
);

export const LLM_VENDORS = [
  "claude",
  "openai",
  "gemini",
  "copilot",
  "azure-foundry",
  "vertex-ai",
  "openai-compatible",
  ...OPENAI_COMPATIBLE_PRESET_VENDOR_IDS,
] as const;

export type LLMVendor = (typeof LLM_VENDORS)[number];

/**
 * Providers shown as the default in-app provider surface while the long-tail
 * OpenAI-compatible presets move toward marketplace packages. The full
 * `LLM_VENDORS` union intentionally remains broad for settings, secrets,
 * legacy configs, and runtime compatibility during the migration.
 */
export const DEFAULT_VISIBLE_LLM_VENDOR_IDS = [
  "openai",
  "claude",
  "gemini",
  "openrouter",
  "openai-compatible",
] as const satisfies readonly LLMVendor[];

export type DefaultVisibleLLMVendor =
  (typeof DEFAULT_VISIBLE_LLM_VENDOR_IDS)[number];

const DEFAULT_VISIBLE_LLM_VENDOR_ID_SET = new Set<string>(
  DEFAULT_VISIBLE_LLM_VENDOR_IDS,
);

export type MarketplaceEligibleLLMVendor =
  Exclude<LLMVendor, DefaultVisibleLLMVendor>;

export const MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS = LLM_VENDORS.filter(
  (vendor): vendor is MarketplaceEligibleLLMVendor =>
    !DEFAULT_VISIBLE_LLM_VENDOR_ID_SET.has(vendor),
);

export function isDefaultVisibleLLMVendor(
  vendor: unknown,
): vendor is DefaultVisibleLLMVendor {
  return (
    typeof vendor === "string" &&
    DEFAULT_VISIBLE_LLM_VENDOR_ID_SET.has(vendor)
  );
}

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

export function isOpenAICompatiblePresetVendor(
  v: unknown,
): v is OpenAICompatiblePresetVendor {
  return typeof v === "string" && OPENAI_COMPATIBLE_PRESET_VENDOR_SET.has(v);
}

export function isOpenAICompatibleVendor(v: LLMVendor): boolean {
  return v === "openai-compatible" || isOpenAICompatiblePresetVendor(v);
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

const RETIRED_LLM_MODEL_IDS = new Set(["gpt-4o"]);

const CORE_DEFAULT_MODEL = {
  claude: "claude-sonnet-4-6",
  openai: "gpt-5.4-mini",
  gemini: "gemini-2.5-flash",
  copilot: "gpt-5.4-mini",
  "azure-foundry": "gpt-5.4-mini",
  "vertex-ai": "gemini-2.5-flash",
  "openai-compatible": "Qwen3.6-35B-A3B-NVFP4",
} as const;

const DEFAULT_MODEL: Record<LLMVendor, string> = Object.freeze({
  ...CORE_DEFAULT_MODEL,
  ...Object.fromEntries(
    OPENAI_COMPATIBLE_PRESET_VENDOR_IDS.map((vendor) => [
      vendor,
      OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].defaultModel,
    ]),
  ),
} as Record<LLMVendor, string>);

const CORE_VENDOR_MODEL_OPTIONS = {
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
    ],
    gemini: [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
    ],
    copilot: [
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.4-nano",
      "gpt-4.1",
      "gpt-4.1-mini",
      "claude-sonnet-4-6",
    ],
    "azure-foundry": [
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.4-nano",
      "gpt-4.1",
      "gpt-4.1-mini",
    ],
    "vertex-ai": [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemini-2.5-flash-lite",
    ],
    // Self-hosted OpenAI-compatible endpoints (vLLM / SGLang / llama.cpp …),
    // including a LiteLLM gateway that fronts several backends behind one /v1
    // and routes by model id. The list seeds the dropdown with the known LVIS
    // cluster models; users point baseUrl at their own gateway/server.
    "openai-compatible": ["Qwen3.6-35B-A3B-NVFP4", "Nemotron-3-Nano-30B-A3B-FP8"],
  } as const;

const PRESET_VENDOR_MODEL_OPTIONS = Object.fromEntries(
  OPENAI_COMPATIBLE_PRESET_VENDOR_IDS.map((vendor) => [
    vendor,
    OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].modelOptions,
  ]),
) as Record<OpenAICompatiblePresetVendor, readonly string[]>;

export const LLM_VENDOR_MODEL_OPTIONS: Readonly<Record<LLMVendor, readonly string[]>> =
  Object.freeze({
    ...CORE_VENDOR_MODEL_OPTIONS,
    ...PRESET_VENDOR_MODEL_OPTIONS,
  }) as unknown as Readonly<Record<LLMVendor, readonly string[]>>;

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

export function isRetiredLlmModel(model: string): boolean {
  return RETIRED_LLM_MODEL_IDS.has(model.trim().toLowerCase());
}

export function normalizeLlmVendorModel(vendor: LLMVendor, model: string): string {
  return isRetiredLlmModel(model) ? DEFAULT_MODEL[vendor] : model;
}

function defaultBlock(vendor: LLMVendor): LLMVendorSettings {
  const model = DEFAULT_MODEL[vendor];
  const preset = isOpenAICompatiblePresetVendor(vendor)
    ? OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor]
    : null;
  return {
    model,
    ...(preset ? { baseUrl: preset.baseUrl } : {}),
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
