/**
 * Permission policy C3 — Foundry + GCP playground reviewer LLM provider adapters.
 *
 * Both adapters implement {@link LlmReviewerProvider} directly via native
 * `fetch` — no host LLMProvider dependency — using API keys retrieved
 * through the settings-service secret store.
 *
 * Provider choices:
 *   - `foundry`       — Microsoft Azure AI Foundry (OpenAI-compatible REST
 *                       at `https://<endpoint>/models/<model>/chat/completions`).
 *                       API key in `reviewer.apiKey.foundry`.
 *                       Endpoint in `reviewer.endpoint.foundry`.
 *   - `gcp-playground` — Google AI Studio (Generative Language API) at
 *                       `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`.
 *                       API key in `reviewer.apiKey.gcp-playground`.
 *
 * Auth: both use API-key authentication, stored encrypted in the host
 * settings-service secret store (CLAUDE.md §Storage Namespace per Feature).
 * The caller supplies a `getSecret` accessor to preserve the main-process
 * secret boundary — adapters never call the Electron IPC directly.
 *
 * Fallback on error: adapters surface errors as thrown exceptions; the
 * enclosing {@link LlmRiskClassifier} applies its `fallbackOnError`
 * policy (`"deny"` | `"rule"`). Adapters do NOT silently swallow
 * provider errors.
 */
import type { LlmCompletionResult, LlmReviewerProvider } from "./risk-classifier.js";

// ─── Secret key constants ──────────────────────────────────────────────

/** Secret key under which the Azure AI Foundry API key is stored. */
export const FOUNDRY_API_KEY_SECRET = "reviewer.apiKey.foundry";
/** Secret key under which the Azure AI Foundry endpoint URL is stored. */
export const FOUNDRY_ENDPOINT_SECRET = "reviewer.endpoint.foundry";
/** Secret key under which the Google AI Studio API key is stored. */
export const GCP_PLAYGROUND_API_KEY_SECRET = "reviewer.apiKey.gcp-playground";

// ─── FoundryReviewerProvider ──────────────────────────────────────────

/**
 * Reviewer LLM provider for Microsoft Azure AI Foundry.
 *
 * Azure AI Foundry exposes an OpenAI-compatible chat-completions endpoint
 * at `POST <endpoint>/models/<model>/chat/completions?api-version=2024-05-01-preview`.
 * The API key is passed as the `Authorization: Bearer <key>` header
 * (Foundry serverless deployments; dedicated deployments use the same scheme).
 *
 * Secret keys:
 *   - `reviewer.apiKey.foundry`   — required; the Azure AI Foundry project API key.
 *   - `reviewer.endpoint.foundry` — required; the project endpoint URL
 *                                   (e.g. `https://<project>.services.ai.azure.com`).
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

function buildFoundryUrl(endpoint: string, model: string): string {
  // Normalize trailing slash
  const base = endpoint.replace(/\/+$/, "");
  return `${base}/models/${encodeURIComponent(model)}/chat/completions?api-version=2024-05-01-preview`;
}

interface FoundryCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// ─── GcpPlaygroundReviewerProvider ────────────────────────────────────

/**
 * Reviewer LLM provider for Google AI Studio (Generative Language API).
 *
 * Uses `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=<apiKey>`.
 * The API key is a Google AI Studio API key stored as:
 *   - `reviewer.apiKey.gcp-playground` — required.
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
    const url = buildGcpUrl(params.model, this.apiKey);
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: params.systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: params.userPrompt }] }],
      generationConfig: { maxOutputTokens: 256, temperature: 0 },
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

function buildGcpUrl(model: string, apiKey: string): string {
  return (
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
  );
}

interface GcpGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

// ─── Factory helpers ───────────────────────────────────────────────────

/**
 * Construct a {@link FoundryReviewerProvider} from secrets.
 * Returns `null` if the required API key is absent.
 */
export function createFoundryProvider(
  getSecret: (key: string) => string | null,
): FoundryReviewerProvider | null {
  const apiKey = getSecret(FOUNDRY_API_KEY_SECRET);
  if (!apiKey) return null;
  const endpoint = getSecret(FOUNDRY_ENDPOINT_SECRET);
  if (!endpoint) return null;
  return new FoundryReviewerProvider(apiKey, endpoint);
}

/**
 * Construct a {@link GcpPlaygroundReviewerProvider} from secrets.
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
 * Returns `true` when all required secrets for the provider exist.
 */
export function reviewerProviderKeyPresent(
  provider: string,
  getSecret: (key: string) => string | null,
): boolean {
  if (provider === "foundry") {
    return (
      getSecret(FOUNDRY_API_KEY_SECRET) !== null &&
      getSecret(FOUNDRY_ENDPOINT_SECRET) !== null
    );
  }
  if (provider === "gcp-playground") {
    return getSecret(GCP_PLAYGROUND_API_KEY_SECRET) !== null;
  }
  // openai / anthropic / google — checked via existing llm.apiKey.<vendor> convention
  return getSecret(`llm.apiKey.${provider}`) !== null;
}
