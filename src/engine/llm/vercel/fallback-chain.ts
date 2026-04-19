/**
 * D1a — Multi-model fallback chain for transient LLM errors.
 *
 * Wraps any LLMProvider's streamTurn so that on a transient failure (5xx,
 * 429, or network-level errors) the caller is transparently handed events
 * from the next entry in the fallback chain.
 *
 * Design constraints:
 *   - AbortError is NOT retried — user cancellation must propagate immediately.
 *   - Auth / 4xx errors are NOT retried — those indicate config bugs, fail fast.
 *   - Fallback only fires BEFORE the first stream event reaches the caller
 *     (pre-stream failure). Mid-stream recovery is not attempted because we
 *     cannot replay partial output deterministically.
 *   - auditLogger is optional; absence is silently ignored.
 */
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../types.js";
import type { LLMVendor } from "../types.js";
import type { ProviderConfig } from "../types.js";
import { createProvider as defaultCreateProvider } from "../provider-factory.js";

export interface FallbackEntry {
  provider: LLMVendor;
  model: string;
}

export interface FallbackAuditLogger {
  log(entry: {
    type: "warn";
    sessionId: string;
    input: string;
  }): void;
}

export interface FallbackCallbacks {
  onFallback?: (from: string, to: string) => void;
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
  return false;
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
      // classification "api-key" or "model" = non-retryable
      const cls = (ev as { type: "error"; classification?: string }).classification ?? "";
      if (cls === "api-key" || cls === "model") {
        yield ev;
        return;
      }
      // Retryable error event (network / rate-limit / unknown) — throw to trigger fallback.
      throw Object.assign(new Error(ev.error), { _lvisRetryable: true });
    }
    firstEvent = false;
    yield ev;
  }
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
  private callbacks?: FallbackCallbacks;
  constructor(
    private readonly primary: LLMProvider,
    private readonly chain: FallbackEntry[],
    private readonly getApiKey: ApiKeyGetter,
    private readonly auditLogger?: FallbackAuditLogger,
    private readonly factory?: ProviderFactory,
  ) {
    this.vendor = primary.vendor;
  }

  setCallbacks(callbacks: FallbackCallbacks): void {
    this.callbacks = callbacks;
  }

  streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    return streamWithFallback(
      this.primary,
      params,
      this.chain,
      this.getApiKey,
      this.auditLogger,
      this.factory,
      this.callbacks,
    );
  }
}

export async function* streamWithFallback(
  primary: LLMProvider,
  params: StreamTurnParams,
  chain: FallbackEntry[],
  getApiKey: ApiKeyGetter,
  auditLogger?: FallbackAuditLogger,
  _createProvider: ProviderFactory = defaultCreateProvider,
  callbacks?: FallbackCallbacks,
): AsyncIterable<StreamEvent> {
  // Attempt 0: primary provider.
  // Attempts 1..N: lazily-constructed fallback providers (built only when needed).
  const totalAttempts = 1 + chain.length;

  const getAttempt = (i: number): { provider: LLMProvider; label: string; attemptParams: StreamTurnParams } => {
    if (i === 0) {
      return { provider: primary, label: `${primary.vendor}/${params.model}`, attemptParams: params };
    }
    const entry = chain[i - 1]!;
    const apiKey = getApiKey(entry.provider);
    return {
      provider: _createProvider({ vendor: entry.provider, apiKey }),
      label: `${entry.provider}/${entry.model}`,
      attemptParams: { ...params, model: entry.model },
    };
  };

  let lastErr: unknown;
  for (let i = 0; i < totalAttempts; i++) {
    const { provider, label, attemptParams } = getAttempt(i);
    try {
      yield* attemptStream(provider, attemptParams);
      return;
    } catch (err) {
      if (isNonRetryable(err)) throw err;
      lastErr = err;
      if (i + 1 >= totalAttempts) break;
      const nextEntry = chain[i]; // chain[i] is the (i+1)-th attempt's entry
      const nextLabel = nextEntry ? `${nextEntry.provider}/${nextEntry.model}` : "??";
      const reason = err instanceof Error ? err.message : String(err);
      const msg = `fallback: ${label}→${nextLabel} reason=${reason}`;
      console.warn(`[LLM fallback] ${msg}`);
      try {
        auditLogger?.log({ type: "warn", sessionId: "", input: msg });
      } catch {
        // audit failure must never block the fallback path
      }
      callbacks?.onFallback?.(label, nextLabel);
    }
  }
  throw lastErr;
}
