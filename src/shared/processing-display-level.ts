export const PROCESSING_DISPLAY_LEVELS = ["tools", "reasoning", "full"] as const;

export type ProcessingDisplayLevel = (typeof PROCESSING_DISPLAY_LEVELS)[number];

/** Runtime boundary guard for persisted settings and IPC payloads. */
export function isProcessingDisplayLevel(value: unknown): value is ProcessingDisplayLevel {
  return typeof value === "string" && PROCESSING_DISPLAY_LEVELS.includes(value as ProcessingDisplayLevel);
}

/** Keep the existing transcript behavior when the preference is unavailable. */
export const DEFAULT_PROCESSING_DISPLAY_LEVEL: ProcessingDisplayLevel = "full";
