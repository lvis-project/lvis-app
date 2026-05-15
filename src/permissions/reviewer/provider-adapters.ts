/**
 * Permission policy C3 — Foundry + GCP playground reviewer LLM provider adapters.
 *
 * Both adapters implement {@link LlmReviewerProvider} directly via native
 * `fetch` — no host LLMProvider dependency — inheriting API keys from the
 * existing chat LLM provider configuration:
 *
 * Provider choices:
 *   - `foundry`       — Microsoft Azure AI Foundry (OpenAI-compatible REST
 *                       at `https://<endpoint>/models/<model>/chat/completions`).
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

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
      signal: params.abortSignal,
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
  }
}

/**
 * Validate that the Foundry endpoint is HTTPS and ends with `.azure.com`
 * (suffix match — catches all `*.services.ai.azure.com`,
 * `*.openai.azure.com`, etc. without subdomain enumeration).
 * Throws on invalid input so the caller fails closed (atomic cutover).
 *
 * Subdomain takeover analysis: because we suffix-match `.azure.com` we
 * accept any subdomain of azure.com. Subdomain takeover of azure.com itself
 * is not feasible — Microsoft controls the apex domain and all its
 * NS/MX records. Individual `<project>.services.ai.azure.com` slots are
 * managed by the Azure control plane; a dangling CNAME attack requires
 * an attacker to claim the exact Azure resource, which they cannot do
 * without the user's subscription credentials.
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
  if (!url.hostname.endsWith(".azure.com") && url.hostname !== "azure.com") {
    throw new Error(
      `FoundryReviewerProvider: endpoint hostname must end with .azure.com ` +
      `(got ${url.hostname}). Provide the full Foundry project endpoint, ` +
      `e.g. https://<project>.services.ai.azure.com`,
    );
  }
}

function buildFoundryUrl(endpoint: string, model: string): string {
  // Normalize trailing slash
  const base = endpoint.replace(/\/+$/, "");
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

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // API key passed as a request header, not a query parameter,
        // to avoid key exposure in server logs and HTTP Referer headers.
        "x-goog-api-key": this.apiKey,
      },
      body,
      signal: params.abortSignal,
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
  } catch {
    // Invalid endpoint URL — surface null so callers throw a clear message.
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
 * Secret-presence predicate used by both the boot wiring and the
 * settings-UI IPC handler to determine whether a provider is activatable.
 *
 * For `foundry`: checks that `llm.apiKey.azure-foundry` is present AND
 * that a non-empty endpoint is available (`getEndpoint` returns truthy).
 * For `gcp-playground`: checks that `llm.apiKey.gemini` is present.
 * For `openai` / `anthropic` / `google`: checks `llm.apiKey.<vendor>`.
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
  // openai / anthropic / google — checked via existing llm.apiKey.<vendor> convention
  return getSecret(`llm.apiKey.${provider}`) !== null;
}
