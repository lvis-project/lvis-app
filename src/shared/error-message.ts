/**
 * The one place that turns a thrown value into a string.
 *
 * WHY THIS IS ITS OWN MODULE. `err instanceof Error ? err.message : String(err)`
 * was spelled out in seventy-odd files across five domains, plus seven named
 * copies. There is no existing string-utility leaf in `shared/` to host it
 * (the same reason `escape-reg-exp.ts` stands alone), and it must be a leaf:
 * error reporting runs inside `catch` blocks in boot, shutdown, IPC, tools,
 * and plugin isolation, where an import that drags anything heavy in would be
 * the wrong dependency direction.
 *
 * Two functions, not one, because the callers ask two different questions:
 *
 *  - {@link errorMessage}: "what did this throw say?" — the log-line form.
 *    Anything that is not an `Error` is rendered with `String()`, so an object
 *    becomes `[object Object]`. That is fine for a diagnostic tail and is what
 *    every inline copy did.
 *  - {@link errorMessageOrSerialized}: "what did the provider send back?" — the
 *    form the LLM error diagnostics use, where the thrown value is often a
 *    plain response body (a string, or a record carrying `.message`) rather
 *    than an `Error`. It reads the message off records and serialises anything
 *    else so the diagnostic keeps the payload instead of `[object Object]`.
 */
import { isRecord } from "./is-record.js";

/** Message of an `Error`; `String()` of anything else. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Message of a thrown value, plus the transport code the runtime hid on
 * `cause`.
 *
 * `fetch` reports every transport failure as the same three words — "fetch
 * failed" — and puts what actually happened (`SELF_SIGNED_CERT_IN_CHAIN`,
 * `ENOTFOUND`, `ECONNREFUSED`) on `error.cause.code`. A diagnostic that drops
 * it tells the reader only that something went wrong, which is the difference
 * between naming a misconfigured network in one glance and bisecting for it.
 *
 * The CODE only, never the cause's own message: `cause` can carry the request
 * that produced it, and that message may repeat a URL a diagnostic field is
 * not entitled to widen.
 */
export function errorMessageWithCauseCode(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof Error) || !isRecord(error.cause)) return message;
  const code = error.cause.code;
  return typeof code === "string" && code.length > 0
    ? `${message} (${code})`
    : message;
}

/**
 * Message of an `Error`, a string as-is, `.message` of a record that carries
 * one, otherwise the JSON form of the value (`String()` when it cannot be
 * serialised — cyclic structures, BigInt).
 */
export function errorMessageOrSerialized(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
