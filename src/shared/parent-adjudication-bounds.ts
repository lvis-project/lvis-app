/**
 * Numeric bounds for the sub-agent parent-adjudication block — shared by the
 * permission settings store (main) and the Permissions settings form (renderer).
 *
 * WHY `shared/`. These are a CONTRACT between the store, which clamps a
 * hand-edited settings file into range on read, and the form, which is the
 * only place a user normally types these numbers. A form that accepted a value
 * the store then silently clamped would show the user a ceiling that is not the
 * one in force — so the two layers cannot declare their own copies. The store
 * remains the authority: the form mirrors these bounds, it does not re-derive
 * them.
 *
 * Pure: no imports, so it stays importable from every process.
 */

/** Bounds for `parentAdjudication.timeoutMs` (milliseconds). */
export const PARENT_ADJUDICATION_TIMEOUT_MS_MIN = 1_000;
export const PARENT_ADJUDICATION_TIMEOUT_MS_MAX = 120_000;
/** Bounds for `parentAdjudication.maxPerChildRun`. */
export const PARENT_ADJUDICATION_MAX_PER_CHILD_RUN_MIN = 1;
export const PARENT_ADJUDICATION_MAX_PER_CHILD_RUN_MAX = 1_000;
/** Bounds for `parentAdjudication.includeParentContextTurns`. */
export const PARENT_ADJUDICATION_CONTEXT_TURNS_MIN = 0;
export const PARENT_ADJUDICATION_CONTEXT_TURNS_MAX = 5;
