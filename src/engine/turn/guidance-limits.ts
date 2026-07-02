/**
 * Guidance-queue bounds — the mid-stream guide buffer limits
 * shared by ConversationLoop.queueGuidance and the queryLoop drain site.
 */
export const GUIDE_MAX_ENTRIES = 16;
export const GUIDE_MAX_CHARS = 8_000;
export const GUIDE_JOINED_MAX_CHARS = 16_000;
