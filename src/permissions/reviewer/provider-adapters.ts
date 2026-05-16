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
 * MAJOR-1: apiKey and endpoint are resolved lazily on each `complete()` call via
 * accessor functions — not snapshotted at construction time. This ensures that
 * when the user rotates their Azure AI Foundry API key or changes the endpoint
 * via chat settings, the reviewer picks up the new value on the next call
 * without requiring a manual `/permission reviewer` rewire.
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
    private readonly getApiKey: () => string | null,
    private readonly getEndpoint: () => string | null,
  ) {}

  async complete(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    abortSignal?: AbortSignal;
  }): Promise<LlmCompletionResult> {
    // Lazy-resolve at call time so key/endpoint rotation takes effect immediately.
    const apiKey = this.getApiKey();
    const endpoint = this.getEndpoint();
    if (!apiKey) throw new Error("FoundryReviewerProvider: apiKey not configured");
    if (!endpoint) throw new Error("FoundryReviewerProvider: endpoint not configured");
    // Validate at use-time so an invalid endpoint fails the call, not the wiring.
    validateFoundryEndpoint(endpoint);

    const url = buildFoundryUrl(endpoint, params.model);
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
          Authorization: `Bearer ${apiKey}`,
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
 * Validate that the Foundry endpoint is HTTPS, ends with one of the approved
 * Azure suffixes, and has a well-formed subdomain (LOW-1: tightened check).
 * Throws on invalid input so the caller fails closed (atomic cutover).
 *
 * Subdomain takeover analysis: both accepted suffixes are managed by the
 * Azure control plane. A dangling CNAME attack requires an attacker to claim
 * the exact Azure resource, which requires the user's subscription credentials.
 *
 * LOW-1: subdomain regex rejects double-dot, percent-encoded dots, and other
 * malformed label sequences that pass the suffix-only check.
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
  const matchedSuffix = FOUNDRY_VALID_SUFFIXES.find((s) => url.hostname.endsWith(s));
  if (!matchedSuffix) {
    throw new Error(
      `FoundryReviewerProvider: endpoint hostname must end with ` +
      `.services.ai.azure.com or .openai.azure.com ` +
      `(got ${url.hostname}). Provide the full Foundry project endpoint, ` +
      `e.g. https://<project>.services.ai.azure.com`,
    );
  }
  // LOW-1: validate the subdomain portion (everything before the matched suffix).
  // Rejects: bare suffix (no subdomain), double-dot sequences, invalid label chars.
  const subdomain = url.hostname.slice(0, url.hostname.length - matchedSuffix.length);
  if (
    subdomain.length === 0 ||
    !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(subdomain)
  ) {
    throw new Error(
      `FoundryReviewerProvider: invalid subdomain '${subdomain}' in endpoint '${endpoint}'. ` +
      `Subdomain must consist of valid DNS labels (alphanumeric + hyphens, no leading/trailing hyphens).`,
    );
  }
}

/**
 * Build the chat-completions fetch URL for a Foundry endpoint.
 *
 * Two URL shapes are supported:
 *   - **Azure OpenAI deployment** (hostname ends with `.openai.azure.com` AND
 *     path starts with `/openai/deployments/`):
 *     The model is embedded in the deployment path; only the
 *     `chat/completions?api-version=…` suffix is appended.
 *     Example: `https://res.openai.azure.com/openai/deployments/gpt-4o/`
 *              → `https://res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=…`
 *   - **Foundry-native** (serverless / project endpoint):
 *     The model is added as `/models/<model>/chat/completions?api-version=…`.
 *     Example: `https://proj.services.ai.azure.com`
 *              → `https://proj.services.ai.azure.com/models/gpt-4o/chat/completions?api-version=…`
 *
 * HIGH-1: Detection uses URL.pathname path-segment check + hostname-suffix check
 * rather than a plain substring `.includes("/openai/deployments/")`, which could
 * be fooled by a Foundry-native endpoint whose base path contains that string.
 */
export function buildFoundryUrl(endpoint: string, model: string): string {
  // Normalize trailing slash
  const base = endpoint.replace(/\/+$/, "");
  // HIGH-1: detect Azure OpenAI deployment shape via path segment + hostname suffix.
  // Both conditions must be true: the hostname belongs to openai.azure.com AND
  // the path starts with /openai/deployments/.
  let isAzureOAIDeployment = false;
  try {
    const u = new URL(endpoint);
    const segs = u.pathname.split("/").filter(Boolean);
    isAzureOAIDeployment =
      u.hostname.endsWith(".openai.azure.com") &&
      segs[0] === "openai" &&
      segs[1] === "deployments";
  } catch {
    // Malformed endpoint — fall through to Foundry-native path; validateFoundryEndpoint
    // will catch and throw before we reach fetch().
  }
  if (isAzureOAIDeployment) {
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
 * MAJOR-1: apiKey is resolved lazily on each `complete()` call via an accessor
 * function — not snapshotted at construction time. This ensures that when the
 * user rotates their Gemini API key via chat settings, the reviewer picks up
 * the new value on the next call without requiring a manual rewire.
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
  constructor(private readonly getApiKey: () => string | null) {}

  async complete(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    abortSignal?: AbortSignal;
  }): Promise<LlmCompletionResult> {
    // Lazy-resolve at call time so key rotation takes effect immediately.
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("GcpPlaygroundReviewerProvider: apiKey not configured");

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
          "x-goog-api-key": apiKey,
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
 * MAJOR-1: Performs a pre-flight check at creation time (both key and endpoint
 * must be present and valid), but stores the *accessors* — not the resolved
 * values — on the adapter. This means subsequent `complete()` calls always
 * read the current key/endpoint, so chat-key rotation propagates automatically.
 *
 * @param getSecret   - Reads encrypted secrets (API key).
 * @param getEndpoint - Reads the plain `llm.vendors.azure-foundry.baseUrl`
 *                      setting (not a secret). Keeping them separate respects
 *                      the secret-store boundary.
 *
 * Returns `null` if either the API key or endpoint is absent or invalid at
 * creation time (pre-flight check ensures the provider is activatable).
 */
export function createFoundryProvider(
  getSecret: (key: string) => string | null,
  getEndpoint: () => string | null,
): FoundryReviewerProvider | null {
  // Pre-flight: both must exist at creation time so the factory returns null
  // (rather than wiring an adapter that always fails on first use).
  const apiKey = getSecret(FOUNDRY_API_KEY_SECRET);
  if (!apiKey) return null;
  const endpoint = getEndpoint();
  if (!endpoint) return null;
  try {
    validateFoundryEndpoint(endpoint);
  } catch (err) {
    log.warn("createFoundryProvider: invalid endpoint — %s", (err as Error).message);
    return null;
  }
  // Adapter holds accessors, not values — key/endpoint rotation is transparent.
  return new FoundryReviewerProvider(
    () => getSecret(FOUNDRY_API_KEY_SECRET),
    () => getEndpoint(),
  );
}

/**
 * Construct a {@link GcpPlaygroundReviewerProvider} from the chat LLM config.
 *
 * MAJOR-1: Performs a pre-flight key check at creation time, but stores the
 * accessor — not the resolved value — on the adapter. Key rotation propagates
 * automatically on the next `complete()` call.
 *
 * Returns `null` if the required API key is absent at creation time.
 */
export function createGcpPlaygroundProvider(
  getSecret: (key: string) => string | null,
): GcpPlaygroundReviewerProvider | null {
  // Pre-flight: key must exist at creation time.
  const apiKey = getSecret(GCP_PLAYGROUND_API_KEY_SECRET);
  if (!apiKey) return null;
  // Adapter holds accessor — key rotation is transparent.
  return new GcpPlaygroundReviewerProvider(
    () => getSecret(GCP_PLAYGROUND_API_KEY_SECRET),
  );
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
 *
 * MEDIUM-3: Built with `Object.create(null)` so prototype-chain properties
 * (`__proto__`, `constructor`, `hasOwnProperty`, etc.) cannot be looked up
 * as if they were valid vendor mappings. Combined with `hasOwnProperty`-safe
 * access in `reviewerProviderKeyPresent` to close prototype-pollution risk.
 */
export const REVIEWER_VENDOR_MAP: Readonly<Record<string, string>> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    openai: "openai",
    anthropic: "claude",
    google: "gemini",
    "azure-foundry": "azure-foundry",
    gemini: "gemini",
  },
);

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
  // openai / anthropic / google — resolve UI name → canonical vendor, then check secret.
  // MEDIUM-3: use hasOwnProperty-safe lookup to avoid prototype-chain traversal on the
  // null-prototype REVIEWER_VENDOR_MAP (Object.create(null) has no .hasOwnProperty method).
  const vendor = Object.prototype.hasOwnProperty.call(REVIEWER_VENDOR_MAP, provider)
    ? REVIEWER_VENDOR_MAP[provider]
    : provider;
  return getSecret(`llm.apiKey.${vendor}`) !== null;
}
