/**
 * Overlay trigger source pattern — single source of truth.
 *
 * Shared by the HostApi trigger gate, permission manager, and imported-trigger
 * envelope parser. The envelope tag name is intentionally
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
const IMPORTED_TRIGGER_ENVELOPE_PATTERN =
  /^<imported-from-proactive\s+source="(overlay:[a-z][a-z0-9-]*)"\s*>/;

const IMPORTED_TRIGGER_ENVELOPE_FULL_PATTERN =
  /^<imported-from-proactive\s+source="(overlay:[a-z][a-z0-9-]*)"\s*>\s*([\s\S]*?)\s*<\/imported-from-proactive>\s*$/;

export interface ImportedTriggerEnvelope {
  source: string;
  body: string;
}

/**
 * Parses an `<imported-from-proactive source="overlay:...">` envelope prefix.
 * Returns the source tag (e.g. `"overlay:meeting-detection"`) if present,
 * or `null` if the input does not begin with the envelope.
 */
export function parseImportedTriggerEnvelope(input: string): string | null {
  const m = input.trimStart().match(IMPORTED_TRIGGER_ENVELOPE_PATTERN);
  return m ? m[1] : null;
}

/**
 * Parses the full proactive import envelope into structured provenance and
 * prompt body. This is the transcript migration/parser used by persisted
 * history replay; new messages should persist the same shape in MessageMeta.
 */
export function parseImportedTriggerEnvelopePayload(input: string): ImportedTriggerEnvelope | null {
  const trimmed = input.trim();
  const full = trimmed.match(IMPORTED_TRIGGER_ENVELOPE_FULL_PATTERN);
  if (full) {
    return { source: full[1], body: full[2].trim() };
  }
  const source = parseImportedTriggerEnvelope(trimmed);
  if (!source) return null;
  return { source, body: trimmed.replace(IMPORTED_TRIGGER_ENVELOPE_PATTERN, "").trim() };
}
