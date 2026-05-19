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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import {
  shouldActivateDemoAutoplay,
  type ScriptedTurn,
} from "../../../engine/demo-autoplay/types.js";
import {
  nextRotationIndex,
  pickScript,
} from "../../../engine/demo-autoplay/scripts-registry.js";

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
 * The hook flips `features.demoAutoplayEnabled = false` after the first emit
 * so the demo is one-shot per install. The onboarding chain
 * (`onboardingCompleted`) is intentionally NOT touched here — chain
 * completion is the responsibility of the explicit ScenarioShowcase →
 * MemorySeed → tour → plugins path in `App.tsx` (`markOnboardingCompleted`).
 * Coupling the two paths previously caused the demo to terminate the
 * onboarding chain before ScenarioShowcase could mount on fresh installs.
 */
export function useDemoAutoplay(api: LvisApi): UseDemoAutoplayResult {
  const [turn, setTurn] = useState<ScriptedTurn | null>(null);
  // Single-call guard on onFinished — the engine's idempotent abort()
  // only protects engine-internal emission; the React side still needs
  // to defend against double-finalization racing the settings patch.
  const finishedRef = useRef(false);
  const env = useMemo(() => readDemoEnv(), []);

  // Probe once on mount. Tutorial-X3 picks the script from the rotation
  // catalog and stores the script ref in state so onFinished can audit
  // with the correct id.
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
        const rotationIndex = settings.features?.demoAutoplayRotationIndex;
        const picked = pickScript(rotationIndex);
        setTurn(picked);
        // Bump the rotation index immediately so a refresh/reboot before
        // onFinished still progresses to the next script. The settings
        // store dedupes redundant writes so this is cheap.
        const nextIndex = nextRotationIndex(rotationIndex);
        void api
          .updateSettings({
            features: { demoAutoplayRotationIndex: nextIndex },
          })
          .catch(() => {
            /* rotation persistence is best-effort — worst case the
               same script plays twice */
          });
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
      if (finishedRef.current) return;
      finishedRef.current = true;
      const finishedScriptId = turn?.id ?? "unknown";
      setTurn(null);
      // One-shot consumption — flip `demoAutoplayEnabled` off so the demo
      // never re-runs. `onboardingCompleted` is deliberately NOT set here:
      // demoAutoplay and the Z onboarding chain (ScenarioShowcase →
      // MemorySeed → tour → plugins) are separate paths and only the
      // explicit chain completion (`markOnboardingCompleted` in App.tsx)
      // is allowed to mark onboarding as done. Previously the demo
      // terminated the chain before ScenarioShowcase could mount on a
      // fresh install.
      void api
        .updateSettings({
          features: { demoAutoplayEnabled: false },
        })
        .catch(() => {
          // Persist failure is non-fatal; demo will simply re-prompt next boot.
        });
      // Fire-and-forget audit row for the abort reason.
      const auditApi = window as unknown as DemoAuditApi;
      void auditApi.audit?.logDemoAutoplay?.({
        scriptId: finishedScriptId,
        phase: "finished",
        detail: reason,
      });
    },
    [api, turn],
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
