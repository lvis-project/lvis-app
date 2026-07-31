/**
 * Guidance-queue bounds — the mid-stream guide buffer limits
 * shared by ConversationLoop.queueGuidance and the queryLoop drain site.
 */
export const GUIDE_MAX_ENTRIES = 16;
export const GUIDE_MAX_CHARS = 8_000;
export const GUIDE_JOINED_MAX_CHARS = 16_000;

const MULTIPLE_SUB_AGENT_APPROVAL_PREFIX = "[Sub-Agent: multiple sources]";

/** Merge the approval provenance carried by guidance entries for the next round. */
export function mergeGuidanceApprovalReasonPrefixes(
  current: string | undefined,
  queued: readonly (string | undefined)[],
): string | undefined {
  const values = new Set(
    [current, ...queued].filter((value): value is string => Boolean(value)),
  );
  if (values.size === 0) return undefined;
  if (values.size === 1) return values.values().next().value;
  return MULTIPLE_SUB_AGENT_APPROVAL_PREFIX;
}
