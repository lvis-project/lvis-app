/**
 * First-boot tour gate — decides whether the boot probe should skip the
 * optional first-boot tour because the user has ALREADY seen it.
 *
 * Why this exists (the bug it fixes):
 *   The boot probe in App.tsx skipped the tour only when
 *   `settings.features.onboardingCompleted === true` or an LLM vendor key
 *   was present. A user who finished the SpotlightTour but quit before the
 *   completion setting was stored could see the tour again on the next launch.
 *   Tour completion is recorded separately in
 *   the tour-state store
 *   (`completedScenarios`), which the boot probe never consulted.
 *
 *   This helper closes that gap: if the tour-state store says the user
 *   completed `first-boot-essentials`, the boot probe treats them as a
 *   returning user and skips the tour — independent of the
 *   `onboardingCompleted` flag.
 *
 * The argument is the raw result of `api.tour.getState()` (a discriminated
 * union, or `null` when the IPC call itself failed). Keeping the union
 * un-narrowed here — rather than at the call site — means the boot probe
 * stays a flat sequence of skip-guards and this module owns the one place
 * that knows the tour-state shape.
 */
import type { LvisApi } from "../types.js";

/**
 * Canonical id of the first-login tour scenario. Must match the scenario
 * registered in `default-tour-scenarios.ts` (`first-boot-essentials`).
 * Centralised here so the gate and any future caller share one literal.
 */
export const FIRST_BOOT_SCENARIO_ID = "first-boot-essentials";

/** The shape `api.tour.getState()` resolves to, plus `null` for IPC failure. */
export type TourStateResult = Awaited<ReturnType<LvisApi["tour"]["getState"]>> | null;

/**
 * True iff the tour-state result shows the user has completed the
 * first-boot tour. Must defend the full union: `result` may be `null`
 * (IPC threw), `{ ok: false, ... }` (host returned an error), or
 * `{ ok: true, state: { completedScenarios: string[], ... } }`. Only the
 * `ok: true` branch exposes `state.completedScenarios`.
 */
export function hasSeenFirstBootTour(result: TourStateResult): boolean {
  return (
    result?.ok === true &&
    result.state.completedScenarios.includes(FIRST_BOOT_SCENARIO_ID)
  );
}
