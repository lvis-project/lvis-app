/**
 * Anthropic extended-thinking signature extraction shim — P0 stub.
 *
 * Context: Vercel AI SDK has historically had edge cases where the reasoning
 * `signature` field was not consistently surfaced on stream parts, which breaks
 * Anthropic's requirement that thinking blocks be echoed verbatim (with
 * signature) when a tool_use is in-flight.
 *
 * Issue trail:
 *   - #11688 (MERGED into ai@6.0.132): fixes signature loss on the smoothStream
 *     primary path. Our pin `ai@~6.0.168` includes this.
 *   - #12433 (OPEN): empty-buffer edge case where final reasoning chunk has
 *     no text but still carries a signature — can still be dropped in niche
 *     conditions. This shim guards that path.
 *   - #11602 (OPEN, parent tracker): umbrella issue for signature handling;
 *     several sub-issues already resolved via #11688. We do NOT rely on this
 *     being closed.
 *
 * Current behavior (P0): log-and-skip thinking blocks whose signature is
 * missing. Safer than sending a tampered echo. P1 will add richer recovery
 * (e.g. buffering raw SSE to dig the signature out).
 *
 * TODO(P1): Actual extraction logic over Vercel reasoning part shape.
 * TODO(P1): Metric counter for skipped blocks (visibility into #12433 impact).
 */

export function extractSignatureSafely(
  _reasoningPart: unknown,
): string | null {
  // TODO(P1): inspect `_reasoningPart.providerMetadata.anthropic.signature`
  //           and fallback paths as #12433 evolves.
  return null;
}
