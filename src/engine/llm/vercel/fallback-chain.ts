/**
 * D1a — Multi-model fallback chain for transient LLM errors.
 *
 * Wraps any LLMProvider's streamTurn so that on a transient failure (5xx,
 * 429, or network-level errors) the caller retries the same provider up to
 * five times before being handed events from the next entry in the fallback
 * chain.
 *
 * Design constraints:
 *   - AbortError is NOT retried — user cancellation must propagate immediately.
 *   - Auth / 4xx errors are NOT retried — those indicate config bugs, fail fast.
 *   - Fallback only fires BEFORE the first stream event reaches the caller
 *     (pre-stream failure). Mid-stream recovery is not attempted because we
 *     cannot replay partial output deterministically.
 */
import type {
  LLMProvider,
  ProviderRequestInputProjection,
  ProviderRequestInputProjectionParams,
  StreamEvent,
  StreamTurnParams,
} from "../types.js";
import type { LLMVendor } from "../types.js";
import type { ProviderConfig } from "../types.js";
import type { SubscriptionChatRuntimeSelection } from "../../../shared/subscription-runtime.js";
import { createProvider as defaultCreateProvider } from "../provider-factory.js";
import { createLogger } from "../../../lib/logger.js";
const log = createLogger("fallback-chain");

export interface FallbackEntry {
  provider: LLMVendor;
  model: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
}

export interface FallbackCallbacks {
  onFallback?: (from: string, to: string) => void;
  onStatus?: (status: FallbackStatus) => void;
}

export interface FallbackStatus {
  phase: "attempt" | "retry" | "fallback";
  label?: string;
  provider?: LLMVendor;
  model?: string;
  attempt?: number;
  maxAttempts?: number;
  from?: string;
  to?: string;
  reason?: string;
}

const MIN_RETRY_WINDOW_MS = 1_000;
const MAX_ATTEMPTS_PER_PROVIDER = 5;

type ErrorStreamEvent = Extract<StreamEvent, { type: "error" }>;

/**
 * Retains a retryable pre-stream event while it travels through the retry
 * loop. The normal primary/fallback path still throws after exhaustion, but
 * a subscription-only primary returns this original event to the engine so
 * provider-as-oracle schema recovery and TPM recovery keep their structured
 * diagnostics. The subscription adapter owns the renderer-safe `error`
 * string; this class never creates or widens an error surface.
 */
class RetryableStreamEventError extends Error {
  constructor(readonly event: ErrorStreamEvent) {
    super(event.error);
    this.name = "RetryableStreamEventError";
  }
}

/** Error categories that must NOT trigger fallback (config bugs → fail fast). */
function isNonRetryable(err: unknown): boolean {
  // User cancellation — sacred, never fallback.
  if (err instanceof Error && err.name === "AbortError") return true;

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  // Auth errors (401/403), validation errors (400), model-not-found (404).
  if (/\b(400|401|403|404)\b/.test(msg)) return true;
  if (/api_key|authentication|unauthorized|forbidden|invalid_model|model_not_found/.test(lower)) return true;
  if (/baseurl is required|project is required|location is required/.test(lower)) return true;
  return false;
}

function isNonRetryableStreamEvent(event: ErrorStreamEvent): boolean {
  // Error events carry richer provider diagnostics than a thrown Error. Keep
  // deterministic request failures on their first attempt so the query loop
  // can apply its bounded schema-drop/context recovery rather than burning
  // the transient retry budget first. A 429 remains explicitly retryable.
  const classification = event.classification ?? event.providerError?.classification;
  const diagnosticClassification = event.providerError?.classification;
  if (
    classification === "api-key"
    || classification === "model"
    || classification === "context-length"
    || diagnosticClassification === "api-key"
    || diagnosticClassification === "model"
    || diagnosticClassification === "context-length"
  ) {
    return true;
  }
  const diagnostics = event.providerError;
  if (diagnostics?.isRetryable === false) return true;
  const status = diagnostics?.statusCode;
  return status !== undefined && status !== 429 && status >= 400 && status < 500;
}

/**
 * Collect events from the primary provider's stream. If the first event is
 * an `error` with a retryable classification, throw so the caller can fallback.
 * Otherwise yield all events normally.
 */
async function* attemptStream(
  provider: LLMProvider,
  params: StreamTurnParams,
): AsyncIterable<StreamEvent> {
  let firstEvent = true;
  for await (const ev of provider.streamTurn(params)) {
    if (firstEvent && ev.type === "error") {
      if (isNonRetryableStreamEvent(ev)) {
        yield ev;
        return;
      }
      // Retryable error event (network / rate-limit / unknown) — retain the
      // complete structured event across retries. The terminal subscription
      // path returns it without exposing any new provider text.
      throw new RetryableStreamEventError(ev);
    }
    firstEvent = false;
    yield ev;
  }
}

async function* attemptStreamWithRetries(
  provider: LLMProvider,
  params: StreamTurnParams,
  label: string,
  identity: { provider: LLMVendor; model: string },
  callbacks?: FallbackCallbacks,
): AsyncIterable<StreamEvent> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PROVIDER; attempt += 1) {
    throwIfAborted(params.abortSignal);
    const attemptStartedAt = Date.now();
    callbacks?.onStatus?.({
      phase: "attempt",
      label,
      provider: identity.provider,
      model: identity.model,
      attempt,
      maxAttempts: MAX_ATTEMPTS_PER_PROVIDER,
    });
    try {
      yield* attemptStream(provider, params);
      return;
    } catch (err) {
      throwIfAborted(params.abortSignal);
      if (isNonRetryable(err)) throw err;
      lastErr = err;
      await waitForAttemptWindow(attemptStartedAt, err, params.abortSignal);
      if (attempt >= MAX_ATTEMPTS_PER_PROVIDER) break;
      callbacks?.onStatus?.({
        phase: "retry",
        label,
        provider: identity.provider,
        model: identity.model,
        attempt: attempt + 1,
        maxAttempts: MAX_ATTEMPTS_PER_PROVIDER,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw lastErr;
}

function makeAbortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) throw makeAbortError();
}

function waitForAttemptWindow(
  startedAt: number,
  _err: unknown,
  abortSignal?: AbortSignal,
): Promise<void> {
  const remainingMs = Math.max(0, MIN_RETRY_WINDOW_MS - (Date.now() - startedAt));
  if (abortSignal?.aborted) return Promise.reject(makeAbortError());
  if (remainingMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timeout) clearTimeout(timeout);
      reject(makeAbortError());
    };
    timeout = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, remainingMs);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Build a provider for a fallback entry. Reuses the same API key lookup
 * that the primary path uses (secretKeyFor → getSecret injected by caller).
 */
export type ApiKeyGetter = (vendor: LLMVendor) => string;
export type ProviderFactory = (config: ProviderConfig) => LLMProvider;

/**
 * Wraps a primary LLMProvider with fallback-chain semantics.
 * Delegates streamTurn to streamWithFallback — transparent to all callers.
 */
export class FallbackProvider implements LLMProvider {
  readonly vendor: LLMVendor;
  readonly subscriptionRuntime?: SubscriptionChatRuntimeSelection;
  constructor(
    private readonly primary: LLMProvider,
    private readonly chain: FallbackEntry[],
    private readonly getApiKey: ApiKeyGetter,
    private readonly factory?: ProviderFactory,
  ) {
    this.vendor = primary.vendor;
    this.subscriptionRuntime = primary.subscriptionRuntime;
  }

  withCallbacks(callbacks: FallbackCallbacks): LLMProvider {
    return {
      vendor: this.vendor,
      ...(this.subscriptionRuntime ? { subscriptionRuntime: this.subscriptionRuntime } : {}),
      projectRequestInput: (input) => this.projectRequestInput(input),
      streamTurn: (params) => this.streamTurnWithCallbacks(params, callbacks),
    };
  }

  projectRequestInput(
    input: ProviderRequestInputProjectionParams,
  ): ProviderRequestInputProjection | undefined {
    return this.primary.projectRequestInput?.(input);
  }

  streamTurnWithCallbacks(
    params: StreamTurnParams,
    callbacks?: FallbackCallbacks,
  ): AsyncIterable<StreamEvent> {
    return streamWithFallback(
      this.primary,
      params,
      this.chain,
      this.getApiKey,
      this.factory,
      callbacks,
    );
  }

  streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    return this.streamTurnWithCallbacks(params);
  }
}

export async function* streamWithFallback(
  primary: LLMProvider,
  params: StreamTurnParams,
  chain: FallbackEntry[],
  getApiKey: ApiKeyGetter,
  _createProvider: ProviderFactory = defaultCreateProvider,
  callbacks?: FallbackCallbacks,
): AsyncIterable<StreamEvent> {
  // Attempt 0: primary provider.
  // Attempts 1..N: lazily-constructed fallback providers (built only when needed).
  const totalAttempts = 1 + chain.length;

  const getAttempt = (i: number): {
    provider: LLMProvider;
    label: string;
    identity: { provider: LLMVendor; model: string };
    attemptParams: StreamTurnParams;
  } => {
    if (i === 0) {
      return {
        provider: primary,
        label: `${primary.vendor}/${params.model}`,
        identity: { provider: primary.vendor, model: params.model },
        attemptParams: params,
      };
    }
    const entry = chain[i - 1]!;
    const apiKey = getApiKey(entry.provider);
    return {
      provider: _createProvider({
        vendor: entry.provider,
        apiKey,
        model: entry.model,
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
        ...(entry.vertexProject ? { vertexProject: entry.vertexProject } : {}),
        ...(entry.vertexLocation ? { vertexLocation: entry.vertexLocation } : {}),
      }),
      label: `${entry.provider}/${entry.model}`,
      identity: { provider: entry.provider, model: entry.model },
      attemptParams: { ...params, model: entry.model },
    };
  };

  let lastErr: unknown;
  for (let i = 0; i < totalAttempts; i++) {
    const { provider, label, identity, attemptParams } = getAttempt(i);
    try {
      throwIfAborted(params.abortSignal);
      yield* attemptStreamWithRetries(provider, attemptParams, label, identity, callbacks);
      return;
    } catch (err) {
      throwIfAborted(params.abortSignal);
      if (isNonRetryable(err)) throw err;
      lastErr = err;
      if (i + 1 >= totalAttempts) break;
      const nextEntry = chain[i]; // chain[i] is the (i+1)-th attempt's entry
      const nextLabel = nextEntry ? `${nextEntry.provider}/${nextEntry.model}` : "??";
      const reason = err instanceof Error ? err.message : String(err);
      const msg = `fallback: ${label}→${nextLabel} reason=${reason}`;
      log.warn(`${msg}`);
      callbacks?.onFallback?.(label, nextLabel);
      callbacks?.onStatus?.({ phase: "fallback", from: label, to: nextLabel, reason });
    }
  }
  // A subscription provider is deliberately wrapped with an empty chain: it
  // may retry its own connected runtime, but must never construct an API-key
  // fallback. Preserve the original structured event for the ordinary query
  // loop after that bounded retry budget is exhausted. API-key chains retain
  // their existing throw-on-exhaustion contract.
  if (primary.subscriptionRuntime && lastErr instanceof RetryableStreamEventError) {
    yield lastErr.event;
    return;
  }
  throw lastErr;
}
