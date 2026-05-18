/**
 * Live Auto-play activation hook.
 *
 * Probes `getSettings()` + the env-derived `LVIS_DEMO_VENDOR` flag exposed
 * by preload (`window.lvis.env.demoVendorPresent`) and returns the active
 * scripted turn when the demo should run. Owns the *decision* only — the
 * actual playback lives in `DemoAutoplayView`.
 *
 * Proposal: `docs/architecture/proposals/live-autoplay.md` §7 + §8.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LvisApi } from "../types.js";
import {
  shouldActivateDemoAutoplay,
  type ScriptedTurn,
} from "../../../engine/demo-autoplay/types.js";
import meetingSummaryDemo from "../../../engine/demo-autoplay/scripts/meeting-summary-demo.json" with { type: "json" };

const DEFAULT_DEMO_SCRIPT: ScriptedTurn = meetingSummaryDemo as ScriptedTurn;

interface DemoEnvProbe {
  demoVendorPresent: boolean;
}

function readDemoEnv(): DemoEnvProbe {
  const w = window as unknown as {
    lvis?: { env?: { demoVendor?: string | null } };
  };
  const vendor = w?.lvis?.env?.demoVendor;
  return { demoVendorPresent: typeof vendor === "string" && vendor.length > 0 };
}

interface DemoAuditApi {
  audit?: {
    logDemoAutoplay?: (payload: {
      scriptId: string;
      phase: string;
      detail?: string;
    }) => Promise<unknown>;
  };
}

export interface UseDemoAutoplayResult {
  /** Active scripted turn when the demo is running. `null` otherwise. */
  turn: ScriptedTurn | null;
  /** Call when the engine finishes (any reason) — flips the flag off. */
  onFinished: (reason: string) => void;
  /** Audit emitter — wires renderer events into the main-process audit log. */
  emitAuditEvent: (event: { scriptId: string; phase: string; detail?: string }) => void;
}

/**
 * Returns the active demo turn (or null) based on the activation predicate.
 * The hook flips `features.demoAutoplayEnabled = false` + `onboardingCompleted = true`
 * after the first emit so the demo is one-shot per install.
 */
export function useDemoAutoplay(api: LvisApi): UseDemoAutoplayResult {
  const [turn, setTurn] = useState<ScriptedTurn | null>(null);
  const env = useMemo(() => readDemoEnv(), []);

  // Probe once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled) return;
        const flagEnabled = settings.features?.demoAutoplayEnabled;
        const onboardingCompleted = settings.features?.onboardingCompleted;
        const active = shouldActivateDemoAutoplay({
          flagEnabled,
          onboardingCompleted,
          demoVendorPresent: env.demoVendorPresent,
        });
        if (!active) return;
        setTurn(DEFAULT_DEMO_SCRIPT);
      } catch {
        // Probe failure → no demo. Safer than activating speculatively.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, env.demoVendorPresent]);

  const onFinished = useCallback(
    (reason: string) => {
      setTurn(null);
      // One-shot consumption — flip the flag off so the demo never re-runs.
      // Always set `demoAutoplayEnabled: false` *and* `onboardingCompleted: true`
      // so the next mount of <App> skips both the onboarding dialog and the demo.
      void api
        .updateSettings({
          features: { demoAutoplayEnabled: false, onboardingCompleted: true },
        })
        .catch(() => {
          // Persist failure is non-fatal; demo will simply re-prompt next boot.
        });
      // Fire-and-forget audit row for the abort reason.
      const auditApi = window as unknown as DemoAuditApi;
      void auditApi.audit?.logDemoAutoplay?.({
        scriptId: DEFAULT_DEMO_SCRIPT.id,
        phase: "finished",
        detail: reason,
      });
    },
    [api],
  );

  const emitAuditEvent = useCallback(
    (event: { scriptId: string; phase: string; detail?: string }) => {
      const auditApi = window as unknown as DemoAuditApi;
      void auditApi.audit?.logDemoAutoplay?.(event)?.catch?.(() => {
        // Audit failure must not block the demo loop.
      });
    },
    [],
  );

  return { turn, onFinished, emitAuditEvent };
}
