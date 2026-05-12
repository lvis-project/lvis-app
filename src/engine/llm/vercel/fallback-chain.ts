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
 *   - auditLogger is optional; absence is silently ignored.
 */
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../types.js";
import type { LLMVendor } from "../types.js";
import type { ProviderConfig } from "../types.js";
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

export interface FallbackAuditLogger {
  log(entry: {
    type: "warn";
    sessionId: string;
    input: string;
  }): void;
}

export interface FallbackCallbacks {
  onFallback?: (from: string, to: string) => void;
  onStatus?: (status: FallbackStatus) => void;
}

export interface FallbackStatus {
  phase: "attempt" | "retry" | "fallback";
  label?: string;
  attempt?: number;
  maxAttempts?: number;
  from?: string;
  to?: string;
  reason?: string;
}

const MIN_RETRY_WINDOW_MS = 1_000;
const MAX_ATTEMPTS_PER_PROVIDER = 5;

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
      // Retryable error event (network / rate-limit / unknown) — throw to trigger retry/fallback.
      throw Object.assign(new Error(ev.error), { _lvisRetryable: true });
    }
    firstEvent = false;
    yield ev;
  }
}

async function* attemptStreamWithRetries(
  provider: LLMProvider,
  params: StreamTurnParams,
  label: string,
  callbacks?: FallbackCallbacks,
): AsyncIterable<StreamEvent> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PROVIDER; attempt += 1) {
    const attemptStartedAt = Date.now();
    callbacks?.onStatus?.({
      phase: "attempt",
      label,
      attempt,
      maxAttempts: MAX_ATTEMPTS_PER_PROVIDER,
    });
    try {
      yield* attemptStream(provider, params);
      return;
    } catch (err) {
      if (isNonRetryable(err)) throw err;
      lastErr = err;
      await waitForAttemptWindow(attemptStartedAt, err, params.abortSignal);
      if (attempt >= MAX_ATTEMPTS_PER_PROVIDER) break;
      callbacks?.onStatus?.({
        phase: "retry",
        label,
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

function waitForAttemptWindow(
  startedAt: number,
  err: unknown,
  abortSignal?: AbortSignal,
): Promise<void> {
  const remainingMs = Math.max(0, MIN_RETRY_WINDOW_MS - (Date.now() - startedAt));
  if (remainingMs <= 0) return Promise.resolve();
  if (abortSignal?.aborted) return Promise.reject(makeAbortError());
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
  constructor(
    private readonly primary: LLMProvider,
    private readonly chain: FallbackEntry[],
    private readonly getApiKey: ApiKeyGetter,
    private readonly auditLogger?: FallbackAuditLogger,
    private readonly factory?: ProviderFactory,
  ) {
    this.vendor = primary.vendor;
  }

  withCallbacks(callbacks: FallbackCallbacks): LLMProvider {
    return {
      vendor: this.vendor,
      streamTurn: (params) => this.streamTurnWithCallbacks(params, callbacks),
    };
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
      this.auditLogger,
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
      provider: _createProvider({
        vendor: entry.provider,
        apiKey,
        model: entry.model,
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
        ...(entry.vertexProject ? { vertexProject: entry.vertexProject } : {}),
        ...(entry.vertexLocation ? { vertexLocation: entry.vertexLocation } : {}),
      }),
      label: `${entry.provider}/${entry.model}`,
      attemptParams: { ...params, model: entry.model },
    };
  };

  let lastErr: unknown;
  for (let i = 0; i < totalAttempts; i++) {
    const { provider, label, attemptParams } = getAttempt(i);
    try {
      yield* attemptStreamWithRetries(provider, attemptParams, label, callbacks);
      return;
    } catch (err) {
      if (isNonRetryable(err)) throw err;
      lastErr = err;
      if (i + 1 >= totalAttempts) break;
      const nextEntry = chain[i]; // chain[i] is the (i+1)-th attempt's entry
      const nextLabel = nextEntry ? `${nextEntry.provider}/${nextEntry.model}` : "??";
      const reason = err instanceof Error ? err.message : String(err);
      const msg = `fallback: ${label}→${nextLabel} reason=${reason}`;
      log.warn(`${msg}`);
      try {
        auditLogger?.log({ type: "warn", sessionId: "", input: msg });
      } catch {
        // audit failure must never block the fallback path
      }
      callbacks?.onFallback?.(label, nextLabel);
      callbacks?.onStatus?.({ phase: "fallback", from: label, to: nextLabel, reason });
    }
  }
  throw lastErr;
}
