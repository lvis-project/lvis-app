import { createLogger } from "../../../lib/logger.js";
const log = createLogger("signature-shim");

/**
 * Anthropic extended-thinking signature extraction shim.
 *
 * Context: Vercel AI SDK has had edge cases where the reasoning `signature`
 * field was not consistently surfaced on stream parts, breaking Anthropic's
 * requirement that thinking blocks be echoed verbatim (with signature) when a
 * tool_use is in-flight.
 *
 * Issue trail:
 *   - #11688 (MERGED into ai@6.0.132): fixes signature loss on the smoothStream
 *     primary path. Our pin `ai@~6.0.168` includes this.
 *   - #12433 (OPEN): empty-buffer edge case where final reasoning chunk has
 *     no text but still carries a signature — can still be dropped in niche
 *     conditions. This shim guards that path.
 *
 * Behavior: log-and-skip thinking blocks whose signature is missing/empty.
 * Safer than sending a tampered echo.
 */

/**
 * Extract signature from a Vercel reasoning stream part or reasoning content
 * part. Returns null (and logs a warning) if the signature is missing — the
 * thinking block must then be skipped in the next-turn echo, since Anthropic
 * rejects thinking blocks without verbatim signatures.
 */
export function extractSignatureSafely(
  reasoningPart: unknown,
): string | null {
  const sig = (reasoningPart as {
    providerMetadata?: { anthropic?: { signature?: unknown } };
  })?.providerMetadata?.anthropic?.signature;
  if (typeof sig !== "string" || sig.length === 0) {
    // eslint-disable-next-line no-console
    log.warn(
      "reasoning block missing signature — skipping (#12433 edge case)",
    );
    return null;
  }
  return sig;
}
