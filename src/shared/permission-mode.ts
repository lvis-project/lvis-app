/**
 * Permission execution mode — the one spelling of the mode union.
 *
 * Owned here rather than in `permissions/permission-manager.ts` because the
 * renderer (status row, mode badge, settings tab) and the slash-command parser
 * name the same set, and the renderer must not import the permission manager
 * runtime. Both processes derive their types from this module.
 */
export const EXECUTION_MODES = ["default", "strict", "auto", "allow"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * Mode as a renderer surface shows it: the host mode once a read has landed,
 * `"unknown"` before the first read or when the host answers with a value the
 * renderer does not recognise.
 */
export type ExecutionModeDisplay = ExecutionMode | "unknown";

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && (EXECUTION_MODES as readonly string[]).includes(value);
}

/** Narrow a host-reported mode (an IPC value, so anything) to the display union. */
export function normalizeExecutionMode(raw: unknown): ExecutionModeDisplay {
  return isExecutionMode(raw) ? raw : "unknown";
}
