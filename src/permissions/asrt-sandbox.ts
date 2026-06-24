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
}

/**
 * Per-command wrap options. `cwd` scopes filesystem jailing; `customConfig` is
 * merged on top of the initialized config by ASRT for this command only.
 */
export interface WrapOptions {
  readonly cwd?: string;
  readonly customConfig?: Partial<SandboxRuntimeConfig>;
  readonly abortSignal?: AbortSignal;
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
  enableLogMonitor = false,
): Promise<void> {
  const SandboxManager = await loadSandboxManager();
  const config = buildSandboxConfig(trustedSettings);
  await SandboxManager.initialize(config, undefined, enableLogMonitor);
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
  const SandboxManager = await loadSandboxManager();
  return SandboxManager.wrapWithSandboxArgv(
    command,
    undefined,
    options.customConfig,
    options.abortSignal,
  );
}

/**
 * Wrap a WORKER command for sandboxed execution, returning the `{ argv, env }`
 * the host must spawn. Same wrapping primitive as {@link wrapToolCommand};
 * kept separate so tool- and worker-specific policy can diverge later without
 * touching call sites.
 */
export async function wrapWorkerCommand(
  command: string,
  options: WrapOptions = {},
): Promise<SandboxWrapResult> {
  const SandboxManager = await loadSandboxManager();
  return SandboxManager.wrapWithSandboxArgv(
    command,
    undefined,
    options.customConfig,
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
}

/**
 * Introspection: whether the current platform supports ASRT sandboxing.
 * Pass-through to `SandboxManager.isSupportedPlatform`.
 */
export async function isAsrtSandboxSupported(): Promise<boolean> {
  const SandboxManager = await loadSandboxManager();
  return SandboxManager.isSupportedPlatform();
}
