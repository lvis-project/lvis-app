/**
 * Overlay trigger source pattern — single source of truth.
 *
 * Shared by the HostApi trigger gate, permission manager, host ingress, and
 * imported-trigger envelope parser. The envelope tag name is intentionally
 * unchanged because plugins may already author that wrapper, but the canonical
 * source namespace is `overlay:*`.
 */

export const OVERLAY_TRIGGER_SOURCE_PATTERN = /^overlay:[a-z][a-z0-9-]*$/;

/**
 * Returns true iff `source` is a valid overlay trigger origin tag.
 * Strict — rejects "overlay:", "overlay:_x", "overlay:Bad/Path".
 */
export function isOverlayTriggerOrigin(source: string | null | undefined): boolean {
  return typeof source === "string" && OVERLAY_TRIGGER_SOURCE_PATTERN.test(source);
}

/** Envelope tag that wraps imported overlay trigger text. */
const IMPORTED_TRIGGER_ENVELOPE_FULL_PATTERN =
  /^<imported-from-proactive\s+source="(overlay:[a-z][a-z0-9-]*)"\s*>\s*([\s\S]*?)\s*<\/imported-from-proactive>\s*$/;
const IMPORTED_TRIGGER_ENVELOPE_CLOSE_PATTERN = /<\/\s*imported-from-proactive\s*>/i;

export interface ImportedTriggerEnvelope {
  source: string;
  body: string;
}

/**
 * Parses a complete `<imported-from-proactive source="overlay:...">` envelope.
 * Prefixes, unclosed wrappers, and trailing non-envelope text are rejected so a
 * staged origin cannot be inferred from only part of untrusted input.
 */
export function parseImportedTriggerEnvelope(input: string): string | null {
  return parseImportedTriggerEnvelopePayload(input)?.source ?? null;
}

/**
 * Parses the complete proactive import envelope into structured provenance and
 * prompt body. This is the transcript migration/parser used by persisted history
 * replay; new messages should persist the same shape in MessageMeta.
 */
export function parseImportedTriggerEnvelopePayload(input: string): ImportedTriggerEnvelope | null {
  const trimmed = input.trim();
  const full = trimmed.match(IMPORTED_TRIGGER_ENVELOPE_FULL_PATTERN);
  if (!full || IMPORTED_TRIGGER_ENVELOPE_CLOSE_PATTERN.test(full[2])) return null;
  return { source: full[1], body: full[2].trim() };
}
