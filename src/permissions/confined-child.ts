/**
 * Spawn a child process confined by ASRT.
 *
 * Extracted from `worker-spawn.ts`, where the identical sequence — wrap the
 * argv, mark the process as genuinely wrapped, check managed-child admission,
 * spawn with the composed environment, register the child — was written twice,
 * once for Windows and once for POSIX. Only two things actually differed
 * between them, and both are parameters here.
 *
 * A separate module rather than another export from `worker-spawn.ts`: that
 * file is dominated by the Python worker's Unix-socket control channel, which
 * has nothing to do with confinement. A JS plugin child will need this and
 * must not import a module whose subject is the Python worker's socket.
 *
 * THE DENY FLOOR IS OWNED HERE, and that is the point of the extraction.
 * In ASRT a per-command `denyRead`/`denyWrite` REPLACES the shared boot floor
 * rather than adding to it — an empty-but-present array is not nullish — so a
 * caller that omits it silently hands the child back read of `~/.lvis/secrets`,
 * `~/.ssh`, `~/.aws`. Six call sites restate that floor today and each one is
 * correct, but nothing tells the seventh. Callers of this primitive pass allow
 * paths only; the floor is not theirs to forget.
 */
import { spawn, type ChildProcess } from "node:child_process";

import {
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  wrapWorkerCommand,
} from "./asrt-sandbox.js";
import { buildSandboxedChildEnv } from "../tools/safe-env.js";
import {
  assertManagedChildProcessAdmissionOpen,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";
import { shellQuote } from "../lib/shell-resolver.js";

/**
 * How the child's filesystem access is granted.
 *
 * `allow-list` puts the paths in the ASRT command itself (macOS seatbelt,
 * Linux bwrap `--bind`). `deny-only` is Windows, where reachability is granted
 * out of band by ACLs against a holder process, so the wrap carries the deny
 * floor and nothing else — passing allow paths there would imply a
 * confinement the wrap does not perform.
 */
type ConfinementGrantMode = "allow-list" | "deny-only";

export interface ConfinedChildSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Used for the managed-child registration and in errors. */
  readonly label: string;
  readonly grantMode: ConfinementGrantMode;
  /** Ignored under `deny-only`, where ACLs grant reachability instead. */
  readonly allowRead?: readonly string[];
  readonly allowWrite?: readonly string[];
  /** Secret-stripped base environment the child starts from. */
  readonly baseEnv: NodeJS.ProcessEnv;
  /** Overlaid last — the sandbox process HOME, which must win. */
  readonly extraEnv?: Record<string, string>;
  /**
   * Checked before and after the wrap. Throw to abort.
   *
   * Windows uses this for holder-process liveness: the ACL grant is only real
   * while the holder is alive, so a holder that died between the grant and the
   * spawn would otherwise produce a child believed to be confined by a grant
   * that no longer exists.
   */
  readonly assertStillValid?: () => void;
  /**
   * Called the instant the wrap succeeds, BEFORE the spawn.
   *
   * The wrap increments ASRT per-command state (the Linux active-sandbox count
   * and proxy refcount). From that moment a later failure must decrement it,
   * and only the caller knows how its own cleanup is arranged — so this is
   * where the caller records that the wrap happened.
   */
  readonly onWrapped?: () => void;
}

/**
 * Wrap, spawn, and register a confined child.
 *
 * Throws with the ASRT per-command state already incremented if the failure
 * happens after {@link ConfinedChildSpec.onWrapped} fires; the caller's
 * cleanup owns the decrement.
 */
export async function spawnConfinedChild(spec: ConfinedChildSpec): Promise<ChildProcess> {
  spec.assertStillValid?.();

  const { cmdline, binShell } = buildConfinedCommandLine(spec.command, spec.args);
  const { argv, env } = await wrapWorkerCommand(cmdline, {
    filesystem: buildFilesystemConfinement(spec),
    ...(binShell !== undefined ? { binShell } : {}),
  });
  spec.onWrapped?.();
  spec.assertStillValid?.();

  const [executable, ...wrappedArgs] = argv;
  if (executable === undefined) {
    throw new Error(`[confined-child] ASRT returned an empty argv for ${spec.label}`);
  }

  assertManagedChildProcessAdmissionOpen(spec.label);
  const child = spawn(executable, wrappedArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    env: composeConfinedEnv(spec.baseEnv, env, spec.extraEnv ?? {}),
  });
  trackManagedChildProcess(child, { label: spec.label });
  return child;
}

/**
 * The filesystem section of the ASRT command.
 *
 * The deny floor is restated unconditionally in BOTH modes, because a
 * per-command array replaces the shared one rather than extending it.
 */
function buildFilesystemConfinement(spec: ConfinedChildSpec): {
  allowRead?: string[];
  allowWrite?: string[];
  denyRead: string[];
  denyWrite: string[];
} {
  const floor = {
    denyRead: getDefaultSensitiveReadDenyPaths(),
    denyWrite: getDefaultSensitiveWriteDenyPaths(),
  };
  if (spec.grantMode === "deny-only") return floor;
  return {
    allowRead: [...(spec.allowRead ?? [])],
    allowWrite: [...(spec.allowWrite ?? [])],
    ...floor,
  };
}

/**
 * Assemble the command line ASRT will run.
 *
 * Every token is quoted so a path containing spaces or shell metacharacters
 * cannot mis-split: ASRT runs this through a shell on both platforms.
 */
function buildConfinedCommandLine(
  command: string,
  args: readonly string[],
): { readonly cmdline: string; readonly binShell?: string } {
  if (process.platform === "win32") {
    return {
      cmdline: ["&", powershellQuote(command), ...args.map((part) => powershellQuote(part))].join(" "),
      binShell: "powershell",
    };
  }
  return { cmdline: [command, ...args].map((part) => shellQuote(part)).join(" ") };
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Compose the child's environment.
 *
 * Only the variables ASRT actually CHANGED are overlaid. Taking its whole
 * composed environment would drag in this process's own values under the guise
 * of proxy configuration, so it is diffed against a baseline composed from
 * `process.env` and only the differences carry over.
 */
function composeConfinedEnv(
  baseEnv: NodeJS.ProcessEnv,
  wrappedEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const asrtComposed: Record<string, string> = buildSandboxedChildEnv(wrappedEnv);
  const safeBaseline: Record<string, string> = buildSandboxedChildEnv(process.env);
  const proxyOverlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(asrtComposed)) {
    if (value === undefined) continue;
    if (safeBaseline[key] === value) continue;
    proxyOverlay[key] = value;
  }
  return { ...baseEnv, ...proxyOverlay, ...extraEnv };
}
