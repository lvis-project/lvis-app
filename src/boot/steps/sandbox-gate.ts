/**
 * OS tool sandbox (ASRT) boot-gate policy — pure decision layer.
 *
 * Extracted from boot.ts so the EXPLICIT-vs-DEFAULT distinction is unit-testable
 * without standing up the full boot graph. boot.ts owns the SIDE EFFECTS
 * (checkAsrtDependencies / initializeAsrtSandbox / setActiveSandboxCapability /
 * log.warn|error|throw); THIS module owns only the BRANCH CHOICE.
 *
 * The gate has two independent on-signals:
 *   - settingOn   — `features.osToolSandbox` (now DEFAULT true; also the
 *                   Settings → 권한 toggle). The "ship it on" signal.
 *   - explicitEnv — `LVIS_SANDBOX_ENABLED=1`. A deliberate power-user/CI
 *                   "I really mean it" override.
 *
 * No-fallback REFINEMENT (this is NOT a blanket fallback — it preserves the
 * fail-closed guarantee for the deliberate case and only degrades the default):
 *   - EXPLICIT opt-in (`explicitEnv`) + sandbox can't activate → ABORT
 *     (fail-closed). The operator demanded the sandbox by name; running
 *     unsandboxed under that name would be the exact silent-downgrade the
 *     no-fallback rule forbids. (Windows is exempt — see below.)
 *   - DEFAULT / settings-on (`settingOn`, NOT `explicitEnv`) + sandbox can't
 *     activate → DEGRADE (non-bricking). With the flag now shipping ON, a host
 *     missing the Linux deps must NOT brick; it degrades to the SAME runtime
 *     posture as sandbox-OFF (a known-safe state) with a LOUD warning, leaving
 *     `isAsrtSandboxActive()` false.
 *   - Windows deps-missing → always DEGRADE regardless of `explicitEnv`:
 *     srt-win needs a one-time UAC install + re-login the user CANNOT complete
 *     before boot, so a throw would permanently brick first-run. The explicit
 *     fail-closed cannot apply where it leaves no recoverable state.
 *
 * "Can't activate" covers BOTH deps-missing (checkAsrtDependencies reported
 * errors) AND a runtime init failure (initializeAsrtSandbox threw): boot models
 * the latter by re-running this decision with `depsOk: false`, so the
 * explicit-vs-default branch lives in exactly one place.
 */

export type SandboxGateAction = "skip" | "activate" | "degrade" | "abort";

export type SandboxGateReason =
  | "gate-off"
  | "deps-present"
  | "degrade-windows-not-installed"
  | "degrade-default-cannot-activate"
  | "abort-explicit-cannot-activate";

export interface SandboxGateInputs {
  /** `features.osToolSandbox` — the shipped default (now true) or Settings toggle. */
  settingOn: boolean;
  /** `LVIS_SANDBOX_ENABLED=1` — the deliberate, fail-closed env override. */
  explicitEnv: boolean;
  /** `process.platform` at boot. */
  platform: NodeJS.Platform;
  /** Whether the sandbox CAN activate — `checkAsrtDependencies().errors.length === 0`
   *  (or, on the init-failure re-check, `false`). */
  depsOk: boolean;
}

export interface SandboxGateDecision {
  action: SandboxGateAction;
  /** Stable machine reason for the chosen branch (audit/log/test). */
  reason: SandboxGateReason;
}

/**
 * Decide the OS-sandbox boot branch. Pure — no side effects, no env/platform
 * reads of its own (everything comes through {@link SandboxGateInputs}).
 */
export function decideSandboxGate(input: SandboxGateInputs): SandboxGateDecision {
  const optIn = input.settingOn || input.explicitEnv;
  if (!optIn) {
    return { action: "skip", reason: "gate-off" };
  }
  if (input.depsOk) {
    return { action: "activate", reason: "deps-present" };
  }
  // From here the sandbox cannot activate (deps missing or init failed).
  if (input.platform === "win32") {
    // Windows is always non-bricking — even an explicit opt-in cannot abort
    // because the one-time install + re-login is unreachable before boot.
    return { action: "degrade", reason: "degrade-windows-not-installed" };
  }
  if (input.explicitEnv) {
    return { action: "abort", reason: "abort-explicit-cannot-activate" };
  }
  return { action: "degrade", reason: "degrade-default-cannot-activate" };
}

/**
 * Whether the host-classify ⇄ sandbox interlock warning must fire.
 *
 * `hostClassifiesRisk` removes the foreground per-call human approval for plugin
 * tools and gates them at the host-mediated effect boundary instead — but that
 * boundary does NOT observe off-hostApi mutations (direct `node:fs` / bare
 * `fetch` / detached async frames); only the OS sandbox contains that residual.
 * So whenever host-classify is ON yet the sandbox is NOT active — gate off, OR a
 * default/settings gate that DEGRADED because the sandbox could not activate —
 * the operator must be warned the residual is uncontained.
 *
 * Keyed on the ACTUAL sandbox-active state (not the `!optIn` proxy the
 * pre-default-on code used): with the default now ON, `optIn` is true on the
 * degraded path while the sandbox is inactive, so the old proxy would wrongly
 * stay silent. This fires on every sandbox-inactive path, the degraded one
 * included.
 */
export function shouldWarnHostClassifyInterlock(input: {
  hostClassifiesRisk: boolean;
  sandboxActive: boolean;
}): boolean {
  return input.hostClassifiesRisk && !input.sandboxActive;
}
