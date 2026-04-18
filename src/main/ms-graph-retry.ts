/**
 * MS Graph 401 one-shot retry helper (Sprint 4-D T1).
 *
 * Plugins (calendar, email) wrap their Graph API calls with this helper so a
 * stale access token that slipped past `MsGraphService.getAccessToken()`
 * (e.g. token expired mid-flight) auto-recovers via a single silent refresh
 * round-trip instead of surfacing as a user-visible error.
 *
 * Usage (plugin-side):
 *
 *   await withMsGraphRetry(
 *     (token) => fetch("https://graph.microsoft.com/v1.0/me", {
 *       headers: { Authorization: `Bearer ${token}` },
 *     }),
 *     () => hostApi.getMsGraphToken(),
 *   );
 *
 * Contract:
 *   - Calls `getToken()` once; if null → throws `MsGraphAuthRequiredError`.
 *   - Calls `fn(token)`. If it throws/resolves a 401-shaped error, refetches
 *     the token (which by now should have silently refreshed host-side) and
 *     retries exactly once.
 *   - If the second attempt also surfaces a 401 — throw the original error.
 *   - Non-401 errors are propagated immediately (no retry).
 */

export class MsGraphAuthRequiredError extends Error {
  constructor(message = "MS Graph access token unavailable — user re-auth required") {
    super(message);
    this.name = "MsGraphAuthRequiredError";
  }
}

/**
 * A value shaped like a 401. Accepts:
 *  - `{ status: 401 }` (fetch Response, Axios error.response)
 *  - `{ statusCode: 401 }` (older node-fetch style)
 *  - Error messages containing "401"
 */
export function is401(err: unknown): boolean {
  if (!err) return false;
  const any = err as {
    status?: number;
    statusCode?: number;
    response?: { status?: number; statusCode?: number };
    message?: string;
  };
  if (any.status === 401) return true;
  if (any.statusCode === 401) return true;
  if (any.response?.status === 401) return true;
  if (any.response?.statusCode === 401) return true;
  if (typeof any.message === "string" && /\b401\b/.test(any.message)) return true;
  return false;
}

export interface WithMsGraphRetryOptions {
  /**
   * Treat the successful resolution value of `fn` as a 401 (e.g. when `fn`
   * returns a `Response` object and you don't want the caller to throw).
   * If provided and returns true for the first call's result, the retry
   * path is taken.
   */
  isResult401?: (result: unknown) => boolean;
}

/**
 * Run `fn` with a fresh Graph token; on 401 failure, refresh once and retry.
 *
 * @param fn           The Graph-calling function. Receives the current token.
 * @param getToken     Token provider (typically `hostApi.getMsGraphToken`).
 * @param options      Optional result-level 401 detection.
 * @throws MsGraphAuthRequiredError if `getToken()` returns null on the first
 *         call. If the first call threw 401 and the refetch returns null, the
 *         original 401 is re-thrown.
 */
export async function withMsGraphRetry<T>(
  fn: (token: string) => Promise<T>,
  getToken: () => Promise<string | null>,
  options: WithMsGraphRetryOptions = {},
): Promise<T> {
  const firstToken = await getToken();
  if (!firstToken) throw new MsGraphAuthRequiredError();

  let firstResult: T | undefined;
  let firstError: unknown;
  try {
    firstResult = await fn(firstToken);
    if (!options.isResult401 || !options.isResult401(firstResult)) {
      return firstResult;
    }
    // Result looks like a 401 — fall through to retry path
  } catch (err) {
    if (!is401(err)) throw err;
    firstError = err;
  }

  // One-shot retry: refetch token (getAccessToken should have silently
  // refreshed by now) and try again.
  const secondToken = await getToken();
  if (!secondToken) {
    if (firstError !== undefined) throw firstError;
    throw new MsGraphAuthRequiredError();
  }

  try {
    const secondResult = await fn(secondToken);
    if (options.isResult401 && options.isResult401(secondResult)) {
      // Still 401 after refresh — give up and return the second result so
      // caller sees the authoritative failure.
      return secondResult;
    }
    return secondResult;
  } catch (err) {
    if (is401(err)) {
      // Both attempts were 401 — throw original for stable error identity.
      throw firstError ?? err;
    }
    throw err;
  }
}
