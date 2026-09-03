import { useCallback, useEffect, useRef, useState } from "react";
import type { getApi } from "../api-client.js";
import { useTranslation } from "../../../i18n/react.js";
import { LLM_VENDORS } from "../../../shared/llm-vendor-defaults.js";
import { hasSeenFirstBootTour } from "../onboarding/first-boot-tour-gate.js";
import { BLOCKING_SURFACE_SELECTOR } from "../../../shared/test-ids.js";

type Api = ReturnType<typeof getApi>;

export interface UseOnboardingTourControllerResult {
  onTourComplete: () => void;
  onTourDismiss: () => void;
  /** Probes and stores the currently active provider-key state. */
  checkApiKey: () => Promise<boolean>;
  /** Null only while the initial key probe is in progress. */
  effectiveHasApiKey: boolean | null;
}

/**
 * Starts the optional first-boot SpotlightTour without placing any setup flow
 * in front of the workspace. Profile, provider, plugin, and runtime settings
 * remain directly available from Settings and their normal main-window views.
 *
 * Also owns the gate that plugin onboarding proposals wait behind. The gate is
 * this hook's because the tour is: it opens when the tour is finished, and for
 * a returning user it is already open at the moment the boot probe decides not
 * to run the tour at all. Asking the host for pending proposals is what stages
 * the first card; the host chooses which, and there is exactly one such request
 * per launch.
 */
export function useOnboardingTourController(
  api: Api,
): UseOnboardingTourControllerResult {
  const { locale } = useTranslation();
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [proposalGateOpen, setProposalGateOpen] = useState(false);
  const firstBootTourStartedRef = useRef(false);
  const onboardingPersistedRef = useRef(false);
  const proposalsRequestedRef = useRef(false);

  const checkApiKey = useCallback(async () => {
    const hasKey = await api.hasApiKey();
    setHasApiKey(hasKey);
    return hasKey;
  }, [api]);

  const markOnboardingCompleted = useCallback(async () => {
    try {
      await api.updateSettings({ features: { onboardingCompleted: true } });
    } catch {
      // The tour is optional; a settings-write failure must not interrupt use.
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await checkApiKey();
        const [settings, tourState] = await Promise.all([
          api.getSettings(),
          api.tour.getState().catch(() => null),
        ]);
        if (cancelled) return;
        if (
          settings.features?.onboardingCompleted === true ||
          hasSeenFirstBootTour(tourState)
        ) {
          // Nothing to tour: the user has been here. Proposals are what is
          // left of onboarding for them, so the gate is open on arrival.
          setProposalGateOpen(true);
          return;
        }

        // Preserve the existing-install guard: users who configured a provider
        // before this tour was introduced are not sent through first-run help.
        const activeKey = await api.hasApiKey().catch(() => false);
        const configuredKeys = activeKey
          ? [true]
          : await Promise.all(
            LLM_VENDORS.map((vendor) => api.hasApiKey(vendor).catch(() => false)),
          );
        if (cancelled || configuredKeys.some(Boolean)) return;

        // The IPC handler broadcasts before its invoke response resolves. Mark
        // this first so a fast dismiss/complete callback cannot race past the
        // one-time settings persistence below.
        firstBootTourStartedRef.current = true;
        const started = await api.tour.start("first-boot-essentials");
        if (cancelled || !started.ok) firstBootTourStartedRef.current = false;
      } catch {
        // The tour can always be opened later with the help shortcut.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, checkApiKey]);

  const finishFirstBootTour = useCallback((completed: boolean) => {
    if (!firstBootTourStartedRef.current || onboardingPersistedRef.current) return;
    onboardingPersistedRef.current = true;
    // Only a COMPLETED tour opens the proposal gate. A user who dismissed the
    // tour said they did not want to be walked through the app; the gate opens
    // for them on the next launch, as a returning user.
    if (completed) setProposalGateOpen(true);
    void markOnboardingCompleted();
  }, [markOnboardingCompleted]);

  const onTourComplete = useCallback(() => {
    finishFirstBootTour(true);
  }, [finishFirstBootTour]);

  const onTourDismiss = useCallback(() => {
    finishFirstBootTour(false);
  }, [finishFirstBootTour]);

  useEffect(() => {
    if (!proposalGateOpen || proposalsRequestedRef.current) return;
    proposalsRequestedRef.current = true;
    void api.onboarding.listPending(locale).catch(() => {
      // Onboarding proposals are optional guidance; a failed request leaves the
      // workspace exactly as it is and the next launch asks again.
    });
  }, [api, locale, proposalGateOpen]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "?" && event.key !== "/") return;
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.isComposing) return;
      if (
        document.querySelector(
          BLOCKING_SURFACE_SELECTOR,
        )
      ) {
        return;
      }
      event.preventDefault();
      void api.tour.start("first-boot-essentials");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [api]);

  return {
    onTourComplete,
    onTourDismiss,
    checkApiKey,
    effectiveHasApiKey: hasApiKey,
  };
}
