import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getBashCapabilities, resolveShell, shellEnvForChild, shellPathForHostPath, shellQuote, type ResolvedShellCommand } from "../lib/shell-resolver.js";
import { createSandboxProcessHome, type SandboxProcessHome } from "../permissions/sandbox-process-home.js";
import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import type { ShellExecutionFacts } from "../shared/shell-execution.js";
import { buildHostShellChildEnv, buildSafeChildEnv, captureSandboxEnvironmentBaseline, FORWARD_ENV_KEYS, overlaySandboxChildEnv } from "./safe-env.js";

export interface ShellInvocationIdentity {
  readonly command: string;
  readonly requestedCwd?: string;
  readonly executionCwd: string;
  readonly resolvedCwd: string;
  readonly toolUseId?: string;
  readonly plan: HostShellExecutionPlan;
}

declare const preparedShellBrand: unique symbol;
/** An in-process host handle; input JSON and model-supplied analysis cannot issue it. */
export interface PreparedShellInvocation { readonly [preparedShellBrand]: true }
interface PreparedState {
  readonly identity: Readonly<ShellInvocationIdentity>;
  readonly shell: Readonly<ResolvedShellCommand>;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly wrapperBaseline: Readonly<NodeJS.ProcessEnv>;
  readonly facts: Readonly<ShellExecutionFacts>;
  readonly home?: SandboxProcessHome;
  readonly hostHome?: string;
  phase: "prepared" | "claimed" | "spawned" | "disposed";
}
const issued = new WeakMap<PreparedShellInvocation, PreparedState>();

export function prepareShellInvocation(identity: ShellInvocationIdentity, signal?: AbortSignal): PreparedShellInvocation {
  signal?.throwIfAborted();
  const selected = resolveShell("bash");
  const shell = Object.freeze({ ...selected });
  const wrapperBaseline = captureSandboxEnvironmentBaseline();
  const safe = shellEnvForChild(shell, identity.plan.mode === "plain" ? buildHostShellChildEnv() : buildSafeChildEnv());
  const hostHome = safe.HOME;
  let home: SandboxProcessHome | undefined;
  try {
    if (identity.plan.mode === "asrt") {
      home = createSandboxProcessHome();
      const temporary = join(home.path, "tmp");
      mkdirSync(temporary, { mode: 0o700 });
      Object.assign(safe, home.env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary });
    }
    // Bash initializes PWD from its actual cwd. Pin the same initial value for
    // analysis and the final inner shell, independently of the parent's alias.
    safe.PWD = shellPathForHostPath(shell, identity.resolvedCwd);
    const environment = Object.freeze(safe);
    const capabilities = getBashCapabilities(selected, environment, identity.resolvedCwd);
    const argv = Object.freeze([...shell.shellArgs(identity.command)]);
    signal?.throwIfAborted();
    const handle = Object.freeze({}) as PreparedShellInvocation;
    issued.set(handle, {
      identity: Object.freeze({ ...identity }), shell, argv, environment, wrapperBaseline,
      facts: Object.freeze({ dialect: "bash", environment, ...capabilities }),
      home, hostHome, phase: "prepared",
    });
    return handle;
  } catch (error) {
    home?.cleanup();
    throw error;
  }
}

function stateOf(handle: PreparedShellInvocation): PreparedState {
  const state = issued.get(handle);
  if (!state || state.phase === "disposed") throw new Error("Shell preparation was not issued or is no longer live");
  return state;
}

export function matchesPreparedShellInvocation(handle: PreparedShellInvocation, identity: ShellInvocationIdentity): boolean {
  const state = issued.get(handle);
  if (!state || state.phase !== "prepared") return false;
  const original = state.identity;
  return original.plan === identity.plan && original.command === identity.command
    && original.requestedCwd === identity.requestedCwd && original.executionCwd === identity.executionCwd
    && original.resolvedCwd === identity.resolvedCwd && original.toolUseId === identity.toolUseId;
}

export function preparedShellFacts(handle: PreparedShellInvocation): Readonly<ShellExecutionFacts> { return stateOf(handle).facts; }
export function preparedShellCommand(handle: PreparedShellInvocation): Readonly<{
  shell: Readonly<ResolvedShellCommand>; argv: readonly string[]; environment: Readonly<Record<string, string>>; homePath?: string; hostHome?: string;
}> {
  const state = stateOf(handle);
  return Object.freeze({ shell: state.shell, argv: state.argv, environment: state.environment, homePath: state.home?.path, hostHome: state.hostHome });
}

/** The wrapper runs only this launcher; original text is one exact inner -c argument. */
export function preparedSandboxBootstrap(handle: PreparedShellInvocation): string {
  const state = stateOf(handle);
  if (!state.home) throw new Error("Sandbox shell preparation has no owned HOME");
  const unset = FORWARD_ENV_KEYS.filter((key) => state.environment[key] === undefined);
  const exported = Object.entries(state.environment).map(([key, value]) => `${key}=${shellQuote(value)}`);
  return [
    ...(unset.length ? [`unset ${unset.join(" ")}`] : []),
    `export ${exported.join(" ")}`,
    `exec ${[shellPathForHostPath(state.shell, state.shell.cmd), ...state.argv].map(shellQuote).join(" ")}`,
  ].join("; ");
}

export function preparedSandboxEnvironment(handle: PreparedShellInvocation, wrappedEnv: NodeJS.ProcessEnv): Record<string, string> {
  const state = stateOf(handle);
  return overlaySandboxChildEnv(wrappedEnv, state.environment, state.wrapperBaseline);
}

/** Release only preparation-owned resources; a spawned child has a separate owner. */
export function disposePreparedShellInvocation(handle: PreparedShellInvocation | undefined): void {
  if (!handle) return;
  const state = issued.get(handle);
  if (!state || state.phase !== "prepared") return;
  state.phase = "disposed";
  state.home?.cleanup();
}

/** Claim once, synchronously before wrapper/native effects. The helper retaining
 * this cleanup owns pending preparation even if its caller settles or cancels.
 */
export function claimPreparedShellInvocation(handle: PreparedShellInvocation): () => void {
  const state = stateOf(handle);
  if (state.phase !== "prepared") throw new Error("Shell preparation has already been claimed");
  state.phase = "claimed";
  return () => {
    if (state.phase !== "claimed") return;
    state.phase = "disposed";
    state.home?.cleanup();
  };
}

/** Call immediately after successful spawn; invoke the returned cleanup only after termination. */
export function transferPreparedShellInvocation(handle: PreparedShellInvocation): () => void {
  const state = stateOf(handle);
  if (state.phase !== "claimed") throw new Error("Shell preparation was not claimed by this execution");
  state.phase = "spawned";
  return () => {
    if (state.phase !== "spawned") return;
    state.phase = "disposed";
    state.home?.cleanup();
  };
}
