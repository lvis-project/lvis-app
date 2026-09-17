export const PROCESSING_DISPLAY_LEVELS = ["tools", "reasoning", "full"] as const;

export type ProcessingDisplayLevel = (typeof PROCESSING_DISPLAY_LEVELS)[number];

/** Keep the existing transcript behavior when the preference is unavailable. */
export const DEFAULT_PROCESSING_DISPLAY_LEVEL: ProcessingDisplayLevel = "full";
