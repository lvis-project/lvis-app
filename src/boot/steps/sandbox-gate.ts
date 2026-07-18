




export type SandboxGateAction = "skip" | "activate" | "degrade" | "abort";

export type SandboxGateReason =
  | "gate-off"
  | "deps-present"
  | "degrade-windows-not-installed"
  | "degrade-default-cannot-activate"
  | "abort-explicit-cannot-activate"
  | "degrade-linux-runtime-probe-failed"
  | "abort-linux-runtime-probe-failed";

export interface SandboxGateInputs {
  /** `features.osToolSandbox` — staged default value or Settings toggle. */
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
    // because the one-time UAC setup is unreachable before boot reaches the UI.
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
 * older `!optIn` proxy): a settings-enabled degraded path has `optIn === true`
 * while the sandbox is inactive, so the old proxy would wrongly stay silent.
 * This fires on every sandbox-inactive path, the degraded one included.
 */
export function shouldWarnHostClassifyInterlock(input: {
  hostClassifiesRisk: boolean;
  sandboxActive: boolean;
}): boolean {
  return input.hostClassifiesRisk && !input.sandboxActive;
}
