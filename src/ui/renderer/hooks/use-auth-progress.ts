/**
 * Tutorial-X1 — Auth progress subscription hook.
 *
 * Subscribes to `api.auth.onProgress` and exposes a tracker map keyed by
 * `step` with the latest `status`. The LoginModal variants use this to
 * paint a checklist that animates against real main-process events:
 *
 *   credentials-validating → llm-key-issuing → sandbox-preparing → complete
 *
 * The hook is variant-agnostic — both the L-X1 (conversational) and L-X2
 * (CLI agent) shells consume the same state. Returning a stable array of
 * `(step, status, vendor?)` entries also lets the consumer render in
 * either checkbox-style or terminal-transcript-style without diverging.
 *
 * Vendor is captured separately because the host doesn't broadcast it on
 * every event; the renderer only learns the vendor once `llm-key-issuing`
 * fires its first `running` payload. Subsequent events on different steps
 * may omit `vendor`, so we hold it in component state once observed.
 */
import { useCallback, useEffect, useState } from "react";
import type { LvisApi } from "../types.js";
import { t } from "../../../i18n/runtime.js";

export type AuthProgressStep =
  | "credentials-validating"
  | "llm-key-issuing"
  | "sandbox-preparing"
  | "complete";

export type AuthProgressStatus = "running" | "done" | "failed";

export interface AuthProgressEvent {
  step: AuthProgressStep;
  status: AuthProgressStatus;
  vendor?: string;
  error?: string;
}

export interface AuthProgressState {
  /** Per-step latest status. Undefined = the step has not started yet. */
  steps: Record<AuthProgressStep, AuthProgressStatus | undefined>;
  /** Vendor reported by any progress event (or null until observed). */
  vendor: string | null;
  /** Latest error code reported by any `failed` event. */
  lastError: string | null;
  /** True iff any step has begun (used to gate the checklist render). */
  active: boolean;
  /** Reset all state — call when the modal closes or a new login starts. */
  reset: () => void;
}

const INITIAL_STEPS: Record<AuthProgressStep, AuthProgressStatus | undefined> = {
  "credentials-validating": undefined,
  "llm-key-issuing": undefined,
  "sandbox-preparing": undefined,
  complete: undefined,
};

export function useAuthProgress(
  api: Pick<LvisApi, "auth">,
  open: boolean,
): AuthProgressState {
  const [stepsState, setStepsState] = useState<
    Record<AuthProgressStep, AuthProgressStatus | undefined>
  >({ ...INITIAL_STEPS });
  const [vendor, setVendor] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  const reset = useCallback(() => {
    setStepsState({ ...INITIAL_STEPS });
    setVendor(null);
    setLastError(null);
    setActive(false);
  }, []);

  // Reset every time the modal re-opens so a previous run's checklist
  // doesn't bleed into the next attempt.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  useEffect(() => {
    // Subset-API tests stub only what they need. When `auth.onProgress`
    // is missing we still mount cleanly — the checklist simply stays
    // inactive, matching the original mockup that animated locally.
    const onProgress = api.auth?.onProgress;
    if (typeof onProgress !== "function") return;
    const unsubscribe = onProgress((event: AuthProgressEvent) => {
      setActive(true);
      setStepsState((prev) => ({ ...prev, [event.step]: event.status }));
      if (event.vendor) setVendor(event.vendor);
      if (event.status === "failed" && event.error) {
        setLastError(event.error);
      }
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* unsubscribe must never throw */
      }
    };
  }, [api]);

  return { steps: stepsState, vendor, lastError, active, reset };
}

/** Localised label for each step. Kept renderer-side per CLAUDE.md. */
export function getAuthStepLabels(): Record<AuthProgressStep, string> {
  return {
    "credentials-validating": t("useAuthProgress.credentialsValidating"),
    "llm-key-issuing": t("useAuthProgress.llmKeyIssuing"),
    "sandbox-preparing": t("useAuthProgress.sandboxPreparing"),
    complete: t("useAuthProgress.complete"),
  };
}

/** Ordered step list for renderer iteration. */
export const AUTH_STEP_ORDER: readonly AuthProgressStep[] = [
  "credentials-validating",
  "llm-key-issuing",
  "sandbox-preparing",
  "complete",
] as const;
