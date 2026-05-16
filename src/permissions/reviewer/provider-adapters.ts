/**
 * Permission policy C3 — Foundry + GCP playground reviewer LLM provider adapters.
 *
 * Both adapters implement {@link LlmReviewerProvider} directly via native
 * `fetch` — no host LLMProvider dependency — inheriting API keys from the
 * existing chat LLM provider configuration:
 *
 * Provider choices:
 *   - `foundry`       — Microsoft Azure AI Foundry (OpenAI-compatible REST).
 *                       Two URL shapes are supported:
 *                         • Foundry-native (serverless):
 *                             `https://<project>.services.ai.azure.com`
 *                             → appends `/models/<model>/chat/completions?api-version=…`
 *                         • Azure OpenAI deployment (chat-shape):
 *                             `https://<resource>.openai.azure.com/openai/deployments/<deployment>/`
 *                             → appends `chat/completions?api-version=…` only
 *                               (model is determined by the deployment)
 *                       API key  → `llm.apiKey.azure-foundry` (same key used by
 *                                   the chat azure-foundry LLM provider).
 *                       Endpoint → `llm.vendors.azure-foundry.baseUrl` setting
 *                                   (plain JSON, not a secret; same field the
 *                                   chat provider uses via `settingsService.get`).
 *   - `gcp-playground` — Google AI Studio (Generative Language API) at
 *                       `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`.
 *                       API key  → `llm.apiKey.gemini` (Google gen-AI key that
 *                                   works for both Gemini chat and Generative
 *                                   Language API).
 *
 * Key inheritance eliminates separate reviewer secret storage: a user who has
 * chat working with Azure AI Foundry or Google Gemini gets the reviewer
 * provider automatically — no new UI required.
 *
 * Auth: keys are retrieved through the host settings-service secret store.
 * The caller supplies a `getSecret` accessor to preserve the main-process
 * secret boundary — adapters never call the Electron IPC directly.
 *
 * Foundry endpoint is supplied via `getEndpoint` (reads the non-secret
 * `llm.vendors.azure-foundry.baseUrl` JSON setting). Keeping it separate
 * from `getSecret` respects the secret-store boundary — plain settings
 * values should not be stored encrypted.
 *
 * Fallback on error: adapters surface errors as thrown exceptions; the
 * enclosing {@link LlmRiskClassifier} applies its `fallbackOnError`
 * policy (`"deny"` | `"rule"`). Adapters do NOT silently swallow
 * provider errors.
 */
import type { LlmCompletionResult, LlmReviewerProvider } from "./risk-classifier.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("reviewer-adapters");

// ─── Pinned API version ────────────────────────────────────────────────
// Bump when Microsoft drops support for the preview version.
// Pinned here rather than inlined so a single grep catches all usages.
const FOUNDRY_API_VERSION = "2024-05-01-preview";

// ─── Secret key constants (chat-provider inheritance) ─────────────────

/**
 * Secret key for the Azure AI Foundry API key — inherits from the chat
 * `azure-foundry` LLM provider (`secretKeyFor("azure-foundry")`).
 */
export const FOUNDRY_API_KEY_SECRET = "llm.apiKey.azure-foundry";

/**
 * Secret key for the Google Gemini API key — inherits from the chat
 * `gemini` LLM provider (`secretKeyFor("gemini")`). The same Google
 * gen-AI key authorises both Gemini chat and the Generative Language API
 * used by the reviewer.
 */
export const GCP_PLAYGROUND_API_KEY_SECRET = "llm.apiKey.gemini";

// ─── FoundryReviewerProvider ──────────────────────────────────────────

/**
 * Reviewer LLM provider for Microsoft Azure AI Foundry.
 *
 * Azure AI Foundry exposes an OpenAI-compatible chat-completions endpoint
 * at `POST <endpoint>/models/<model>/chat/completions?api-version=<ver>`.
 * The API key is passed as the `Authorization: Bearer <key>` header
 * (Foundry serverless deployments; dedicated deployments use the same scheme).
 *
 * Inherited from chat config:
 *   - `llm.apiKey.azure-foundry`             — required; the Azure AI Foundry project API key.
 *   - `llm.vendors.azure-foundry.baseUrl`    — required; the project endpoint URL
 *                                              (e.g. `https://<project>.services.ai.azure.com`).
 *                                              Must be HTTPS and end with `.azure.com`.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/model-inference/openai-model-inference-api
 */
export class FoundryReviewerProvider implements LlmReviewerProvider {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint: string,
  ) {
    if (!apiKey) throw new Error("FoundryReviewerProvider: apiKey is required");
    if (!endpoint) throw new Error("FoundryReviewerProvider: endpoint is required");
    validateFoundryEndpoint(endpoint);
  }

  async complete(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    abortSignal?: AbortSignal;
  }): Promise<LlmCompletionResult> {
    const url = buildFoundryUrl(this.endpoint, params.model);
    const body = JSON.stringify({
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
      max_tokens: 256,
      temperature: 0,
    });

    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(new Error("Foundry reviewer timeout 15s")), 15_000);
    const signal = params.abortSignal
      ? AbortSignal.any([params.abortSignal, ac.signal])
      : ac.signal;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => String(response.status));
        throw new Error(`Foundry reviewer HTTP ${response.status}: ${errText.slice(0, 120)}`);
      }

      const data = (await response.json()) as FoundryCompletionResponse;
      const text = data.choices?.[0]?.message?.content ?? "";
      const usage = data.usage;
      return {
        text,
        tokensIn: usage?.prompt_tokens ?? 0,
        tokensOut: usage?.completion_tokens ?? 0,
        costUsd: 0, // Foundry pricing varies by deployment; not surfaced here.
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Allowed hostname suffixes for Foundry endpoints.
 * Matches TRUSTED_NETWORK_HOST_SUFFIXES in risk-classifier.ts.
 *   - `.services.ai.azure.com` — Foundry serverless / project endpoints
 *   - `.openai.azure.com`      — Azure OpenAI deployment endpoints
 */
const FOUNDRY_VALID_SUFFIXES = [".services.ai.azure.com", ".openai.azure.com"] as const;

/**
 * Validate that the Foundry endpoint is HTTPS and ends with one of the
 * approved Azure suffixes (`.services.ai.azure.com` or `.openai.azure.com`).
 * Throws on invalid input so the caller fails closed (atomic cutover).
 *
 * Subdomain takeover analysis: both accepted suffixes are managed by the
 * Azure control plane. A dangling CNAME attack requires an attacker to claim
 * the exact Azure resource, which requires the user's subscription credentials.
 */
export function validateFoundryEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      `FoundryReviewerProvider: endpoint is not a valid URL: ${endpoint}`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `FoundryReviewerProvider: endpoint must use HTTPS (got ${url.protocol}): ${endpoint}`,
    );
  }
  if (!FOUNDRY_VALID_SUFFIXES.some((s) => url.hostname.endsWith(s))) {
    throw new Error(
      `FoundryReviewerProvider: endpoint hostname must end with ` +
      `.services.ai.azure.com or .openai.azure.com ` +
      `(got ${url.hostname}). Provide the full Foundry project endpoint, ` +
      `e.g. https://<project>.services.ai.azure.com`,
    );
  }
}

/**
 * Build the chat-completions fetch URL for a Foundry endpoint.
 *
 * Two URL shapes are supported:
 *   - **Azure OpenAI deployment** (contains `/openai/deployments/`):
 *     The model is embedded in the deployment path; only the
 *     `chat/completions?api-version=…` suffix is appended.
 *     Example: `https://res.openai.azure.com/openai/deployments/gpt-4o/`
 *              → `https://res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=…`
 *   - **Foundry-native** (serverless / project endpoint):
 *     The model is added as `/models/<model>/chat/completions?api-version=…`.
 *     Example: `https://proj.services.ai.azure.com`
 *              → `https://proj.services.ai.azure.com/models/gpt-4o/chat/completions?api-version=…`
 */
export function buildFoundryUrl(endpoint: string, model: string): string {
  // Normalize trailing slash
  const base = endpoint.replace(/\/+$/, "");
  if (base.includes("/openai/deployments/")) {
    // Chat-shape: deployment already encodes the model; do not add /models/<model>.
    return `${base}/chat/completions?api-version=${FOUNDRY_API_VERSION}`;
  }
  // Foundry-native: model is specified explicitly in the path.
  return `${base}/models/${encodeURIComponent(model)}/chat/completions?api-version=${FOUNDRY_API_VERSION}`;
}

interface FoundryCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// ─── GcpPlaygroundReviewerProvider ────────────────────────────────────

/**
 * Reviewer LLM provider for Google AI Studio (Generative Language API).
 *
 * Uses `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`.
 * The API key is passed as the `x-goog-api-key` request header (not as a
 * URL query parameter — query params appear in server access logs and
 * HTTP referrer headers, creating an unnecessary key-leak surface).
 *
 * Inherited from chat config:
 *   - `llm.apiKey.gemini` — required; the Google gen-AI API key that
 *                           authorises both Gemini chat and the
 *                           Generative Language API.
 *
 * The system prompt is passed as a `systemInstruction` field (Gemini-native).
 *
 * @see https://ai.google.dev/api/generate-content
 */
export class GcpPlaygroundReviewerProvider implements LlmReviewerProvider {
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("GcpPlaygroundReviewerProvider: apiKey is required");
  }

  async complete(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    abortSignal?: AbortSignal;
  }): Promise<LlmCompletionResult> {
    const url = buildGcpUrl(params.model);
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: params.systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: params.userPrompt }] }],
      generationConfig: { maxOutputTokens: 256, temperature: 0 },
    });

    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(new Error("GCP reviewer timeout 15s")), 15_000);
    const signal = params.abortSignal
      ? AbortSignal.any([params.abortSignal, ac.signal])
      : ac.signal;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // API key passed as a request header, not a query parameter,
          // to avoid key exposure in server logs and HTTP Referer headers.
          "x-goog-api-key": this.apiKey,
        },
        body,
        signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => String(response.status));
        throw new Error(`GCP reviewer HTTP ${response.status}: ${errText.slice(0, 120)}`);
      }

      const data = (await response.json()) as GcpGenerateContentResponse;
      const text =
        data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const usage = data.usageMetadata;
      return {
        text,
        tokensIn: usage?.promptTokenCount ?? 0,
        tokensOut: usage?.candidatesTokenCount ?? 0,
        costUsd: 0, // Google AI Studio pricing is not surfaced per-call here.
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function buildGcpUrl(model: string): string {
  return (
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent`
  );
}

interface GcpGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

// ─── Factory helpers ───────────────────────────────────────────────────

/**
 * Construct a {@link FoundryReviewerProvider} from the chat LLM config.
 *
 * @param getSecret   - Reads encrypted secrets (API key).
 * @param getEndpoint - Reads the plain `llm.vendors.azure-foundry.baseUrl`
 *                      setting (not a secret). Keeping them separate respects
 *                      the secret-store boundary.
 *
 * Returns `null` if either the API key or endpoint is absent or invalid.
 */
export function createFoundryProvider(
  getSecret: (key: string) => string | null,
  getEndpoint: () => string | null,
): FoundryReviewerProvider | null {
  const apiKey = getSecret(FOUNDRY_API_KEY_SECRET);
  if (!apiKey) return null;
  const endpoint = getEndpoint();
  if (!endpoint) return null;
  try {
    return new FoundryReviewerProvider(apiKey, endpoint);
  } catch (err) {
    log.warn("createFoundryProvider: invalid endpoint — %s", (err as Error).message);
    return null;
  }
}

/**
 * Construct a {@link GcpPlaygroundReviewerProvider} from the chat LLM config.
 * Returns `null` if the required API key is absent.
 */
export function createGcpPlaygroundProvider(
  getSecret: (key: string) => string | null,
): GcpPlaygroundReviewerProvider | null {
  const apiKey = getSecret(GCP_PLAYGROUND_API_KEY_SECRET);
  if (!apiKey) return null;
  return new GcpPlaygroundReviewerProvider(apiKey);
}

/**
 * Maps UI-facing provider names to canonical vendor secret key suffixes.
 *
 * The UI uses provider names that differ from the canonical secret-store
 * vendor names used by the chat LLM providers (boot.ts vendorMap).
 * This map aligns them so `reviewerProviderKeyPresent` looks up the
 * correct secret key for each provider.
 *
 * Canonical vendor names match the keys used in `llm.apiKey.<vendor>`
 * (e.g. `llm.apiKey.claude`, `llm.apiKey.gemini`).
 */
export const REVIEWER_VENDOR_MAP: Readonly<Record<string, string>> = {
  openai: "openai",
  anthropic: "claude",
  google: "gemini",
  "azure-foundry": "azure-foundry",
  gemini: "gemini",
};

/**
 * Secret-presence predicate used by both the boot wiring and the
 * settings-UI IPC handler to determine whether a provider is activatable.
 *
 * For `foundry`: checks that `llm.apiKey.azure-foundry` is present AND
 * that a non-empty endpoint is available (`getEndpoint` returns truthy).
 * For `gcp-playground`: checks that `llm.apiKey.gemini` is present.
 * For `openai` / `anthropic` / `google`: resolves via REVIEWER_VENDOR_MAP
 * then checks `llm.apiKey.<canonical-vendor>`.
 *
 * Returns `true` when all required config for the provider exists.
 */
export function reviewerProviderKeyPresent(
  provider: string,
  getSecret: (key: string) => string | null,
  getEndpoint?: () => string | null,
): boolean {
  if (provider === "foundry") {
    const hasKey = getSecret(FOUNDRY_API_KEY_SECRET) !== null;
    const hasEndpoint = getEndpoint ? (getEndpoint() ?? null) !== null : false;
    return hasKey && hasEndpoint;
  }
  if (provider === "gcp-playground") {
    return getSecret(GCP_PLAYGROUND_API_KEY_SECRET) !== null;
  }
  // openai / anthropic / google — resolve UI name → canonical vendor, then check secret
  const vendor = REVIEWER_VENDOR_MAP[provider] ?? provider;
  return getSecret(`llm.apiKey.${vendor}`) !== null;
}
