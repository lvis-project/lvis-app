/**
 * Overlay trigger source pattern — single source of truth.
 *
 * Shared by the HostApi trigger gate and the permission manager. The ENVELOPE
 * around imported trigger text is not parsed here: every staged origin's
 * envelope is owned by `shared/staged-origins.ts`, so a consumer that reads
 * provenance out of the text reads one table instead of chaining one parser
 * per origin. The envelope tag name (`imported-from-proactive`) stays as-is
 * because plugins may already author that wrapper, but the canonical source
 * namespace is `overlay:*`.
 */

export const OVERLAY_TRIGGER_SOURCE_PATTERN = /^overlay:[a-z][a-z0-9-]*$/;

/**
 * Returns true iff `source` is a valid overlay trigger origin tag.
 * Strict — rejects "overlay:", "overlay:_x", "overlay:Bad/Path".
 */
export function isOverlayTriggerOrigin(source: string | null | undefined): boolean {
  return typeof source === "string" && OVERLAY_TRIGGER_SOURCE_PATTERN.test(source);
}
