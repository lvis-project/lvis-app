/**
 * Provider-as-oracle: identify the tool a provider rejected.
 *
 * OpenAI / Azure validate the *whole* chat request and reject it with a hard
 * `400 invalid_function_parameters` if ANY single function schema violates
 * their strict-mode subset (e.g. an `array` property without `items`) — which
 * would otherwise take down the entire turn for every flow that loaded the
 * offending tool (#1182).
 *
 * Rather than hand-rolling a growing local mirror of every provider strict-mode
 * rule, we let the provider BE the source of truth: when it 400s, we parse the
 * offending function name out of the error, drop just that tool, and retry the
 * turn. This function does the parsing — pure, provider-agnostic, never throws.
 *
 * The companion plugin-load lint (`plugins/tool-schema-lint.ts`) stays as a
 * cheap fast-path for the one high-frequency offender so the common case never
 * pays a failed round-trip; THIS path is the completeness guarantee for every
 * other strict-mode violation we don't (and shouldn't) enumerate by hand.
 */
import type { ProviderErrorDiagnostics } from "./provider-error-diagnostics.js";

/** Provider error codes / message fragments that mean "one function schema is invalid". */
const SCHEMA_REJECTION_MESSAGE_RE =
  /invalid[_ ]function[_ ]parameters|invalid schema for (?:function|tool)/i;

/**
 * The offending function name, as the provider names it in the error
 * ("Invalid schema for function 'foo_bar': ..."). Quote style varies by
 * provider, so accept ', " or `.
 */
const REJECTED_FUNCTION_NAME_RE =
  /(?:function|tool)\s+['"`]([A-Za-z0-9_.-]+)['"`]/i;

/**
 * If `providerError` represents a strict-mode tool-schema rejection AND names a
 * function that is currently in `knownToolNames`, return that tool name so the
 * caller can drop it and retry. Returns undefined otherwise — meaning "don't
 * retry" (not a schema rejection, name unparseable, or names a tool we aren't
 * sending, so dropping it wouldn't help).
 *
 * Intersecting with `knownToolNames` is what guarantees the caller's drop+retry
 * loop terminates: it only ever returns a name present in the current set, and
 * dropping it strictly shrinks that finite set.
 */
export function rejectedToolNameFromError(
  providerError: ProviderErrorDiagnostics | undefined,
  knownToolNames: readonly string[],
): string | undefined {
  if (!providerError) return undefined;

  const code = providerError.providerCode ?? "";
  const message = providerError.messagePreview ?? "";
  const isSchemaRejection =
    code.toLowerCase().includes("invalid_function_parameters") ||
    SCHEMA_REJECTION_MESSAGE_RE.test(message);
  if (!isSchemaRejection) return undefined;

  const named = message.match(REJECTED_FUNCTION_NAME_RE)?.[1];
  if (!named) return undefined;

  return knownToolNames.includes(named) ? named : undefined;
}
