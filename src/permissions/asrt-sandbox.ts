/**
 * Anthropic Sandbox Runtime (ASRT) host adapter.
 *
 * This module wires LVIS process sandboxing onto
 * `@anthropic-ai/sandbox-runtime`. It is gated DEFAULT-OFF: nothing runs through
 * it until boot opts in (Settings → 권한 'OS 도구 샌드박스' or
 * `LVIS_SANDBOX_ENABLED=1`) and `initializeAsrtSandbox` succeeds. Do not add
 * behavior that runs at import time.
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
 * NETWORK ENFORCEMENT MODEL — READ BEFORE EDITING (ASRT 0.0.59 constraint) ⚠️
 * ASRT's runtime egress decision lives in `filterNetworkRequest()`
 * (dist/sandbox/sandbox-manager.js). The proxy filter closures are bound as
 * `filter: (port, host) => filterNetworkRequest(port, host, sandboxAskCallback)`
 * and that function reads ONLY the module-level SHARED `config`:
 *     for (const d of config.network.deniedDomains) …   // deny first
 *     for (const d of config.network.allowedDomains) …  // then allow
 *     if (!sandboxAskCallback || config.network.strictAllowlist) return false; // strict ⇒ hard-deny
 * The SHARED `config` is assigned ONLY by `initialize()` (`config = runtimeConfig`)
 * and `updateConfig()` (`config = structuredClone(...)`).
 *
 * The `customConfig` argument to `wrapWithSandboxArgv(command, binShell,
 * customConfig)` is NEVER consulted by `filterNetworkRequest` — it only decides
 * whether to route the command through the proxy (`hasNetworkConfig`) and scopes
 * credential `injectHosts`. So a per-command `customConfig.network` cannot
 * enforce egress; it is INERT for allow/deny. Therefore network egress is
 * enforced by setting the SHARED config (allowedDomains UNION + strictAllowlist)
 * at {@link initializeAsrtSandbox} / {@link updateAsrtSandboxConfig}, NOT per
 * wrap. Per-command `customConfig` carries ONLY the filesystem jail, which IS
 * enforced (macOS bakes it into the seatbelt profile per wrap; Linux into the
 * bwrap binds).
 *
 * TRADE-OFF (honest): the enforced model is a UNION allow-list — strictAllowlist
 * + the union of every loaded plugin's `manifest.networkAccess.allowedDomains`
 * (∪ an optional trusted host baseline). A sandboxed worker can therefore reach
 * any domain declared by ANY loaded plugin, not only its own. This is acceptable
 * under LVIS's 1st-party plugin trust model. TRUE per-worker network isolation
 * would require a future ASRT with per-process proxies / distinct egress auth
 * tokens; 0.0.59's single shared proxy + single shared config cannot express it.
 * Do NOT claim per-worker network isolation.
 * ─────────────────────────────────────────────────────────────────────────────
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
 * The WEAKENING fields MUST be sourced exclusively from trusted user/host
 * configuration. They MUST NEVER be derived from plugin manifests,
 * project-local config, MCP server input, or any other
 * untrusted/attacker-influenced surface. Do not add a code path that lets
 * plugin/project config set any of these flags. Network is deny-by-default: an
 * empty `allowedDomains` means the sandboxed process has no network egress.
 *
 * NOTE on `allowedDomains`: this is the SHARED, enforced egress allow-list
 * (see the NETWORK ENFORCEMENT MODEL header). Boot computes it as the UNION of
 * every loaded, host-validated `manifest.networkAccess.allowedDomains` (∪ an
 * optional trusted host baseline) via {@link computeUnionAllowedDomains}. The
 * union itself is derived from manifests — a trusted seam (the host validated
 * those manifests at install) — but the WEAKENING flags above never are.
 */
export interface TrustedSandboxSettings {
  /**
   * The SHARED, ENFORCED egress allow-list. Empty/omitted ⇒ no network egress
   * (deny-by-default). Set this to the manifest UNION (+ trusted baseline) so
   * `filterNetworkRequest` allows exactly those domains. With
   * `strictAllowlist: true` any host not on this list is hard-denied with no
   * askCb fallthrough. See {@link computeUnionAllowedDomains}.
   */
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
 * Builds the config from trusted settings (network `allowedDomains` is the
 * manifest UNION via {@link computeUnionAllowedDomains}; the WEAKENING flags
 * come from trusted host/user settings ONLY — see {@link TrustedSandboxSettings})
 * and calls `initialize`, which starts ASRT's proxy/helper machinery and
 * assigns the SHARED `config` that `filterNetworkRequest` enforces against.
 * Idempotent re-initialization is the caller's responsibility; prefer
 * {@link updateAsrtSandboxConfig} to change a live config.
 *
 * askCb SUPERSESSION (corrects WIRING-A #1356): the enforced model is GLOBAL
 * strict hard-deny — boot sets `strictAllowlist: true`. Under strict,
 * `filterNetworkRequest` NEVER calls the askCb (it hard-denies on any
 * out-of-union host: `if (!sandboxAskCallback || config.network.strictAllowlist)
 * return false`). The interactive host-tool askCb prompt added in WIRING-A is
 * therefore inert under strict and is NOT passed at boot anymore. `askCb` stays
 * an optional param only for a NON-strict configuration (not used by the
 * shipped enforced model); when `strictAllowlist` is true it is dead weight by
 * design.
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
 * Wrap a WORKER command (Python uv/runtime spawns) for sandboxed execution,
 * returning the `{ argv, env }` the host must spawn. Same wrapping primitive as
 * {@link wrapToolCommand}: the per-command channel carries ONLY the filesystem
 * jail (scoped to the worker's plugin sandbox root + needed dirs).
 *
 * NETWORK: workers do NOT carry a per-command network override — that channel
 * is INERT in ASRT 0.0.59 (`filterNetworkRequest` reads the SHARED config, not
 * `customConfig`; see the module header). Worker egress is ENFORCED by the
 * shared config set at boot: `strictAllowlist: true` + the UNION of every
 * loaded plugin's manifest allow-list. Workers are NON-INTERACTIVE; strict
 * hard-denies any out-of-union host with no askCb fallthrough. The owning
 * plugin's declared domains reach the worker only by being part of that union.
 */
export async function wrapWorkerCommand(
  command: string,
  options: WrapOptions = {},
): Promise<SandboxWrapResult> {
  // Self-enforcing gate — same rationale as wrapToolCommand.
  if (!isAsrtSandboxActive()) {
    throw new Error("wrapWorkerCommand: ASRT sandbox is not active (initialize at boot first)");
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
 * Compute the SHARED, enforced egress allow-list as the UNION of every loaded,
 * host-validated plugin manifest's `networkAccess.allowedDomains` plus an
 * optional TRUSTED host baseline (default empty). Deduped, order-stable.
 *
 * This is the trusted seam for the network enforcement model: the host
 * validated these manifests at install, so the union is a trusted input to the
 * SHARED ASRT config (set via {@link initializeAsrtSandbox} /
 * {@link updateAsrtSandboxConfig}). Because ASRT's `filterNetworkRequest` reads
 * that shared config, the union is genuinely enforced for BOTH workers and host
 * tools under `strictAllowlist: true`.
 *
 * TRADE-OFF: this is a union, NOT per-worker isolation — see the module header.
 *
 * @param manifestAllowLists  one entry per loaded plugin: its
 *                            `manifest.networkAccess.allowedDomains` (or `[]`).
 * @param trustedBaseline     optional trusted host-settings allow-list for host
 *                            tools; defaults to empty (no baseline egress).
 */
export function computeUnionAllowedDomains(
  manifestAllowLists: readonly (readonly string[])[],
  trustedBaseline: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const domain of trustedBaseline) {
    if (typeof domain === "string" && domain.length > 0 && !seen.has(domain)) {
      seen.add(domain);
      union.push(domain);
    }
  }
  for (const list of manifestAllowLists) {
    for (const domain of list) {
      if (typeof domain === "string" && domain.length > 0 && !seen.has(domain)) {
        seen.add(domain);
        union.push(domain);
      }
    }
  }
  return union;
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
