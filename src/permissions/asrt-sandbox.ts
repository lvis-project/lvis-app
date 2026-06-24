/**
 * Anthropic Sandbox Runtime (ASRT) host adapter — DORMANT.
 *
 * This module is the foundation for migrating LVIS process sandboxing onto
 * `@anthropic-ai/sandbox-runtime`. Nothing imports it yet: it is additive and
 * has ZERO runtime effect until a future PR wires it into the boot sequence and
 * the sandbox-runner registry. Do not add behavior that runs at import time.
 *
 * ASRT does NOT spawn the workload. It validates a config (zod), starts its
 * proxy/helper machinery on `initialize`, and `wrapWith*Argv` returns the
 * `{ argv, env }` the HOST must spawn itself. The bundled vendor binaries
 * (Linux seccomp loader, Windows srt-win) live under
 * `node_modules/@anthropic-ai/sandbox-runtime/vendor/**` and are executed as
 * separate processes — packaging must `asarUnpack` that glob (see
 * `package.json` build.asarUnpack) or the binaries cannot exec from an asar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESM-in-Electron note: ASRT is ESM-only (`"type": "module"`). The LVIS main
 * process is built by esbuild as a single ESM bundle. A top-level *static*
 * `import` of the package would inline its source into the main bundle, which
 * breaks ASRT's filesystem-relative resolution of its own vendor binaries (the
 * same failure mode pino hit — see scripts/build-main-esbuild.mjs `external`).
 * To keep ASRT a real `node_modules` entry that resolves its vendor dir at
 * runtime — and to keep this module genuinely dormant — the runtime values are
 * pulled in via a dynamic `await import(...)`. Only `import type` is used at the
 * top level; type-only imports are erased by the compiler and never reach the
 * emitted bundle.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  SandboxRuntimeConfig,
  NetworkConfig,
  FilesystemConfig,
  SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";

/**
 * The subset of ASRT configuration that is ONLY ever permitted to originate
 * from TRUSTED host/user settings.
 *
 * ⚠️ TRUST BOUNDARY — READ BEFORE EDITING ⚠️
 * The fields below WEAKEN the sandbox:
 *   - `allowAppleEvents`              — lets the child send Apple Events /
 *                                       Launch Services open requests (macOS).
 *   - `enableWeakerNetworkIsolation`  — opens `com.apple.trustd.agent`; a
 *                                       documented data-exfiltration vector.
 *   - `network.allowAllUnixSockets`   — removes the per-socket allow-list.
 *
 * These MUST be sourced exclusively from trusted user/host configuration. They
 * MUST NEVER be derived from plugin manifests, project-local config, MCP server
 * input, or any other untrusted/attacker-influenced surface. Do not add a code
 * path that lets plugin/project config set any of these flags. Network is
 * deny-by-default: an empty `allowedDomains` means the sandboxed process has no
 * network egress.
 */
export interface TrustedSandboxSettings {
  /** Domains the sandboxed process may reach. Empty/omitted ⇒ no network. */
  readonly allowedDomains?: readonly string[];
  /** Domains explicitly denied (takes precedence over allow). */
  readonly deniedDomains?: readonly string[];
  /** Enforce the allow-list strictly (no implicit infra domains). */
  readonly strictAllowlist?: boolean;
  /** Paths the child may read. */
  readonly allowRead?: readonly string[];
  /** Paths the child is denied reading (takes precedence). */
  readonly denyRead?: readonly string[];
  /** Paths the child may write. */
  readonly allowWrite?: readonly string[];
  /** Paths the child is denied writing (takes precedence). */
  readonly denyWrite?: readonly string[];
  /**
   * Sandbox-weakening flags. TRUSTED-ONLY (see the trust-boundary note above).
   * Never wire a plugin/project-config path to any field in this object.
   */
  readonly weakening?: {
    readonly allowAppleEvents?: boolean;
    readonly enableWeakerNetworkIsolation?: boolean;
    readonly allowAllUnixSockets?: boolean;
  };
  /**
   * Upstream HTTP/HTTPS proxy the sandbox's egress proxy should chain through
   * for outbound connections (corporate-proxy passthrough). TRUSTED-ONLY.
   *
   * SECURITY (PR #1356 MINOR -- parentProxy explicit):
   * ASRT's `resolveParentProxy` SILENTLY inherits the HOST process's
   * `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` env vars when `network.parentProxy`
   * is absent. That implicit inheritance is a covert egress channel: a
   * sandboxed child's traffic would tunnel through whatever proxy the host
   * happened to have configured. We therefore set `network.parentProxy`
   * EXPLICITLY in {@link buildSandboxConfig} on every initialize:
   *   - default (this field omitted): empty proxy config so ASRT connects
   *     directly and does NOT chain through the host proxy (the secure floor);
   *   - present: only the explicit, trusted corporate-proxy URLs below are
   *     used -- never the ambient host env.
   * This field is the ONLY way to opt a sandbox into a parent proxy.
   */
  readonly corporateProxy?: {
    readonly http?: string;
    readonly https?: string;
    readonly noProxy?: string;
  };
}

/**
 * Per-command filesystem scoping. This is the ONLY config a caller may vary
 * per command, and it can only ever NARROW or RE-SHAPE the filesystem jail —
 * it cannot widen network egress and cannot carry any sandbox-weakening flag.
 *
 * ⚠️ TRUST BOUNDARY (security MINOR from the PR #1355 cluster review) ⚠️
 * `wrapWithSandboxArgv` accepts a `customConfig: Partial<SandboxRuntimeConfig>`
 * that ASRT merges over the initialized config for this command only — that is
 * the single channel through which a per-command call could otherwise smuggle
 * a weakening flag (`allowAppleEvents`, `enableWeakerNetworkIsolation`,
 * `network.allowAllUnixSockets`) past the trusted-settings gate. To keep that
 * channel safe by construction, callers pass ONLY this narrow filesystem shape;
 * {@link toCustomConfig} maps it to the exact `{ filesystem }` slice handed to
 * ASRT. There is deliberately no field here for network or weakening flags, so
 * a plugin/project-influenced call site cannot reach them.
 */
export interface PerCommandFilesystem {
  /** Paths the child may write for this command (the derived write-jail). */
  readonly allowWrite?: readonly string[];
  /** Paths the child may read (e.g. cwd re-allowed after a HOME-wide deny). */
  readonly allowRead?: readonly string[];
  /** Paths the child is denied reading (e.g. $HOME, to fix the read-jail leak). */
  readonly denyRead?: readonly string[];
  /** Paths the child is denied writing (takes precedence over allowWrite). */
  readonly denyWrite?: readonly string[];
}

/**
 * Per-command wrap options. `filesystem` scopes the per-command read/write jail
 * (the only thing allowed to vary per command — see {@link PerCommandFilesystem}).
 */
export interface WrapOptions {
  readonly filesystem?: PerCommandFilesystem;
  readonly abortSignal?: AbortSignal;
}

/**
 * Map the trust-safe {@link PerCommandFilesystem} to the `customConfig` slice
 * ASRT merges for this command. Only the `filesystem` section is ever produced
 * here: network and weakening flags are intentionally unreachable from a
 * per-command call so the trusted-settings gate cannot be bypassed.
 */
function toCustomConfig(
  filesystem: PerCommandFilesystem | undefined,
): Partial<SandboxRuntimeConfig> | undefined {
  if (filesystem === undefined) return undefined;
  const fs: FilesystemConfig = {
    denyRead: [...(filesystem.denyRead ?? [])],
    allowWrite: [...(filesystem.allowWrite ?? [])],
    denyWrite: [...(filesystem.denyWrite ?? [])],
    ...(filesystem.allowRead !== undefined
      ? { allowRead: [...filesystem.allowRead] }
      : {}),
  };
  return { filesystem: fs };
}

/** The host spawns this; ASRT never spawns the workload itself. */
export interface SandboxWrapResult {
  readonly argv: string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Dynamically import the ESM-only ASRT package. Kept in one place so the
 * dynamic-import shape (and the ESM-in-Electron rationale above) lives in a
 * single spot. Resolved lazily — importing this module has no side effects.
 */
async function loadSandboxManager() {
  const mod = await import("@anthropic-ai/sandbox-runtime");
  return mod.SandboxManager;
}

/**
 * Whether {@link initializeAsrtSandbox} has run to completion in this process.
 *
 * This is the host-tool spawn path's gate: tool code (bash.ts/powershell.ts)
 * asks THIS module — not the settings service — whether to route through ASRT,
 * so the gate is decided once at boot and cannot be re-evaluated mid-run. That
 * preserves the seal-after-boot security property the §691 registry had: there
 * is no runtime channel to flip the sandbox on/off after boot. Set to `true`
 * only on a successful `initialize`; stays `false` after {@link resetAsrtSandbox}.
 */
let active = false;

/** Host-tool spawn gate. True once {@link initializeAsrtSandbox} succeeds. */
export function isAsrtSandboxActive(): boolean {
  return active;
}

/**
 * Build a fully-resolved {@link SandboxRuntimeConfig} from TRUSTED settings.
 *
 * Deny-by-default: when no `allowedDomains` are supplied the network section
 * has an empty allow-list, which ASRT treats as "no egress". Weakening flags
 * default to `false`/absent and are only set when explicitly present in the
 * trusted `weakening` object.
 */
function buildSandboxConfig(trustedSettings: TrustedSandboxSettings): SandboxRuntimeConfig {
  const network: NetworkConfig = {
    // Deny-by-default — empty allow-list ⇒ no network egress.
    allowedDomains: [...(trustedSettings.allowedDomains ?? [])],
    deniedDomains: [...(trustedSettings.deniedDomains ?? [])],
    ...(trustedSettings.strictAllowlist !== undefined
      ? { strictAllowlist: trustedSettings.strictAllowlist }
      : {}),
    // TRUSTED-ONLY weakening: only ever from trusted host/user settings.
    ...(trustedSettings.weakening?.allowAllUnixSockets !== undefined
      ? { allowAllUnixSockets: trustedSettings.weakening.allowAllUnixSockets }
      : {}),
    // parentProxy EXPLICIT (PR #1356 security MINOR). ASRT's resolveParentProxy
    // silently inherits the host HTTP_PROXY/HTTPS_PROXY/NO_PROXY env when this
    // is absent — a covert egress channel. We always set it: empty {} ⇒ no
    // parent-proxy chaining (direct connect, the secure floor); only an
    // explicit trusted corporateProxy ever populates it.
    parentProxy: {
      ...(trustedSettings.corporateProxy?.http !== undefined
        ? { http: trustedSettings.corporateProxy.http }
        : {}),
      ...(trustedSettings.corporateProxy?.https !== undefined
        ? { https: trustedSettings.corporateProxy.https }
        : {}),
      ...(trustedSettings.corporateProxy?.noProxy !== undefined
        ? { noProxy: trustedSettings.corporateProxy.noProxy }
        : {}),
    },
  };

  const filesystem: FilesystemConfig = {
    denyRead: [...(trustedSettings.denyRead ?? [])],
    allowWrite: [...(trustedSettings.allowWrite ?? [])],
    denyWrite: [...(trustedSettings.denyWrite ?? [])],
    ...(trustedSettings.allowRead !== undefined
      ? { allowRead: [...trustedSettings.allowRead] }
      : {}),
  };

  return {
    network,
    filesystem,
    // TRUSTED-ONLY weakening flags (see TrustedSandboxSettings trust-boundary
    // note). Only set when explicitly supplied by trusted settings.
    ...(trustedSettings.weakening?.allowAppleEvents !== undefined
      ? { allowAppleEvents: trustedSettings.weakening.allowAppleEvents }
      : {}),
    ...(trustedSettings.weakening?.enableWeakerNetworkIsolation !== undefined
      ? {
          enableWeakerNetworkIsolation:
            trustedSettings.weakening.enableWeakerNetworkIsolation,
        }
      : {}),
  };
}

/**
 * Initialize the ASRT {@link SandboxManager} singleton from TRUSTED settings.
 *
 * Builds the config from trusted host/user settings ONLY (never plugin/project
 * config — see {@link TrustedSandboxSettings}) and calls `initialize`, which
 * starts ASRT's proxy/helper machinery. Idempotent re-initialization is the
 * caller's responsibility; prefer {@link updateAsrtSandboxConfig} to change a
 * live config.
 *
 * @param enableLogMonitor  Forwarded to ASRT (violation log monitor). Default
 *                          off to avoid surprising background activity.
 */
export async function initializeAsrtSandbox(
  trustedSettings: TrustedSandboxSettings,
  askCb?: SandboxAskCallback,
  enableLogMonitor = false,
): Promise<void> {
  // Idempotency guard (PR #1356 NIT). The boot gate must decide exactly once;
  // a double-initialize means two boot paths raced or a runtime channel tried
  // to re-seal the sandbox with a different config. Fail loud rather than
  // silently overwriting the live config — use updateAsrtSandboxConfig to
  // change a live config.
  if (active) {
    throw new Error(
      "initializeAsrtSandbox: already active — refusing to re-initialize (use updateAsrtSandboxConfig to change a live config)",
    );
  }
  const SandboxManager = await loadSandboxManager();
  const config = buildSandboxConfig(trustedSettings);
  await SandboxManager.initialize(config, askCb, enableLogMonitor);
  active = true;
}

/**
 * Check that the platform's sandbox dependencies are present (Linux: bwrap +
 * socat + ripgrep). Returns ASRT's `{ errors, warnings }` — a non-empty
 * `errors` means the sandbox CANNOT run on this host. Boot uses this to
 * fail-closed (refuse to run unsandboxed) when the gate is ON but the deps are
 * missing, rather than silently downgrading to isolation=none.
 */
export async function checkAsrtDependencies(): Promise<{
  errors: string[];
  warnings: string[];
}> {
  const SandboxManager = await loadSandboxManager();
  return SandboxManager.checkDependencies();
}

/**
 * Wrap a TOOL command for sandboxed execution, returning the `{ argv, env }`
 * the host must spawn. Uses `wrapWithSandboxArgv` (the cross-platform form;
 * unlike `wrapWithSandbox` it does not throw on Windows).
 */
export async function wrapToolCommand(
  command: string,
  options: WrapOptions = {},
): Promise<SandboxWrapResult> {
  // Self-enforcing gate (PR #1356 NIT). Do not depend on the caller to check
  // isAsrtSandboxActive() first — a wrap with no initialized SandboxManager is
  // a bug, so throw rather than silently wrapping against an uninitialized
  // singleton.
  if (!isAsrtSandboxActive()) {
    throw new Error("wrapToolCommand: ASRT sandbox is not active (initialize at boot first)");
  }
  const SandboxManager = await loadSandboxManager();
  return SandboxManager.wrapWithSandboxArgv(
    command,
    undefined,
    toCustomConfig(options.filesystem),
    options.abortSignal,
  );
}

/**
 * Per-worker network policy. Workers (Python uv/runtime spawns) are
 * NON-INTERACTIVE, so they get a strict, hard-deny allow-list fed from the
 * owning plugin's `manifest.networkAccess.allowedDomains` — NOT the host-tool
 * askCb prompt. This narrow network slice is the only network channel a worker
 * wrap may carry; it can only ever NARROW egress to the worker's declared
 * domains, never widen it or carry a sandbox-weakening flag.
 */
export interface WorkerNetworkPolicy {
  /** The worker's declared egress allow-list (manifest.networkAccess.allowedDomains). */
  readonly allowedDomains: readonly string[];
  /**
   * Hard-deny outside the allow-list (no implicit infra domains, no askCb
   * prompt). Always true for workers — they cannot answer an interactive
   * prompt. Defaults to true when omitted.
   */
  readonly strictAllowlist?: boolean;
}

/** Per-worker wrap options: the filesystem jail plus the worker network policy. */
export interface WorkerWrapOptions extends WrapOptions {
  readonly network?: WorkerNetworkPolicy;
}

/**
 * Map a {@link WorkerNetworkPolicy} + filesystem slice to the per-command
 * `customConfig` ASRT merges. Unlike {@link toCustomConfig} (filesystem-only,
 * used by the host-tool path), the worker path additionally carries a `network`
 * slice so each worker is confined to ITS plugin's declared `allowedDomains`
 * under a strict hard-deny — distinct from the boot-time host-tool policy.
 */
function toWorkerCustomConfig(
  options: WorkerWrapOptions,
): Partial<SandboxRuntimeConfig> | undefined {
  const fsConfig = toCustomConfig(options.filesystem);
  if (options.network === undefined) return fsConfig;
  const network: NetworkConfig = {
    allowedDomains: [...options.network.allowedDomains],
    deniedDomains: [],
    // Workers are non-interactive: strict hard-deny by default (no askCb).
    strictAllowlist: options.network.strictAllowlist ?? true,
  };
  return { ...(fsConfig ?? {}), network };
}

/**
 * Wrap a WORKER command for sandboxed execution, returning the `{ argv, env }`
 * the host must spawn. Same wrapping primitive as {@link wrapToolCommand}, but
 * carries a per-worker {@link WorkerNetworkPolicy}: the worker's egress is
 * confined to its owning plugin's declared `allowedDomains` under a strict
 * hard-deny (NON-INTERACTIVE — no askCb prompt), and its filesystem jail is
 * scoped to the worker's plugin sandbox root + needed dirs.
 */
export async function wrapWorkerCommand(
  command: string,
  options: WorkerWrapOptions = {},
): Promise<SandboxWrapResult> {
  // Self-enforcing gate (PR #1356 NIT) — same rationale as wrapToolCommand.
  if (!isAsrtSandboxActive()) {
    throw new Error("wrapWorkerCommand: ASRT sandbox is not active (initialize at boot first)");
  }
  const SandboxManager = await loadSandboxManager();
  return SandboxManager.wrapWithSandboxArgv(
    command,
    undefined,
    toWorkerCustomConfig(options),
    options.abortSignal,
  );
}

/**
 * Replace the live ASRT config (TRUSTED settings only). Pass-through to
 * `SandboxManager.updateConfig`.
 */
export async function updateAsrtSandboxConfig(
  trustedSettings: TrustedSandboxSettings,
): Promise<void> {
  const SandboxManager = await loadSandboxManager();
  SandboxManager.updateConfig(buildSandboxConfig(trustedSettings));
}

/**
 * Per-command cleanup pass-through (`SandboxManager.cleanupAfterCommand`).
 * Call after a wrapped command finishes.
 */
export async function cleanupAsrtSandboxAfterCommand(): Promise<void> {
  const SandboxManager = await loadSandboxManager();
  SandboxManager.cleanupAfterCommand();
}

/**
 * Full teardown pass-through (`SandboxManager.reset`). Stops proxy servers and
 * clears state.
 */
export async function resetAsrtSandbox(): Promise<void> {
  const SandboxManager = await loadSandboxManager();
  await SandboxManager.reset();
  active = false;
}

/**
 * Introspection: whether the current platform supports ASRT sandboxing.
 * Pass-through to `SandboxManager.isSupportedPlatform`.
 */
export async function isAsrtSandboxSupported(): Promise<boolean> {
  const SandboxManager = await loadSandboxManager();
  return SandboxManager.isSupportedPlatform();
}
