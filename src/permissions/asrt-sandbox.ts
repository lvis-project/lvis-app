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
  WindowsConfig,
  SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";

/**
 * The loopback PERMIT port range srt-win's egress proxy binds on Windows.
 *
 * SINGLE SOURCE OF TRUTH (Windows network model): the value the install flow
 * WFP-permits (`installWindowsSandbox({ proxyPortRange })`) MUST equal the value
 * the runtime config sets (`config.windows.proxyPortRange`), or the proxy binds
 * a port the WFP filter blocks and ALL egress hard-fails. Both sides reference
 * THIS one constant — {@link buildSandboxConfig} sources the runtime value from
 * it; the Windows install/relogin UX (a separate follow-up) sources the WFP
 * value from the same export.
 *
 * Why not `export … from "@anthropic-ai/sandbox-runtime"`: ASRT is ESM-only and
 * deliberately NOT statically imported (a static import inlines its source into
 * the main bundle and breaks its vendor-binary resolution — see the module
 * header). So this mirrors ASRT 0.0.59's `DEFAULT_WINDOWS_PROXY_PORT_RANGE`
 * value `[60080, 60089]` as a plain literal. A unit test (asrt-sandbox.test.ts)
 * pins this against ASRT's REAL exported constant so any upstream drift fails
 * CI rather than silently desyncing the proxy bind from the WFP permit.
 */
export const DEFAULT_WINDOWS_PROXY_PORT_RANGE: readonly [number, number] = [
  60080, 60089,
];

/**
 * The local discriminator group srt-win keys its WFP filters on. Mirrors ASRT
 * 0.0.59's `DEFAULT_WINDOWS_GROUP_NAME` (= `sandbox-runtime-net`) for the same
 * single-source-of-truth reason as {@link DEFAULT_WINDOWS_PROXY_PORT_RANGE}: the
 * runtime config and the install flow must name the SAME group. Pinned as a
 * literal (ASRT is dynamically imported, never statically) and verified against
 * ASRT's real export by a unit test so upstream drift fails CI.
 */
export const DEFAULT_WINDOWS_GROUP_NAME = "sandbox-runtime-net";

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
   * SECURITY (PR #1356 MINOR -- parentProxy explicit, corrected here):
   * ASRT's `resolveParentProxy` (parent-proxy.js:46) does
   * `cfg?.http ?? process.env.HTTP_PROXY ?? process.env.http_proxy`. An EMPTY
   * object `{}` has no `http` key, so `cfg?.http` is `undefined` and the `??`
   * chain STILL inherits the HOST `HTTP_PROXY`/`HTTPS_PROXY` env — a covert
   * egress channel identical to passing no config at all. Only an EXPLICIT
   * EMPTY STRING short-circuits the chain (`'' ?? x` ⇒ `''`) and yields genuine
   * direct-connect. {@link buildSandboxConfig} therefore ALWAYS sets
   * `network.parentProxy.http`/`.https` explicitly:
   *   - default (this field omitted): empty strings ⇒ ASRT connects directly
   *     and does NOT chain through the host proxy (the secure floor);
   *   - present: only the explicit, trusted corporate-proxy URLs below are
   *     used -- never the ambient host env.
   * This field is the ONLY way to opt a sandbox into a parent proxy.
   */
  readonly corporateProxy?: {
    readonly http?: string;
    readonly https?: string;
    readonly noProxy?: string;
  };
  /**
   * Windows-only sandbox settings (srt-win network backend). TRUSTED-ONLY —
   * the proxy port range must agree with what the install flow WFP-permits.
   *
   * `proxyPortRange`: the loopback PERMIT range srt-win's egress proxy binds.
   * Defaults to {@link DEFAULT_WINDOWS_PROXY_PORT_RANGE} when omitted (which is
   * also what the install WFP-permits by default), so the proxy bind range
   * always matches the WFP rule. Set explicitly only when an enterprise install
   * used a non-default range. Has no effect off win32.
   */
  readonly windows?: {
    readonly proxyPortRange?: readonly [number, number];
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
  /**
   * The INNER shell ASRT should run the command under. Cross-platform string
   * surface forwarded verbatim to `wrapWithSandboxArgv(command, binShell, …)`:
   *   - Windows: `'powershell'` | `'pwsh'` | `'cmd'` | an absolute Git Bash /
   *     sh.exe path — ASRT's `parseWindowsBinShell` renders the executable
   *     ITSELF (e.g. `powershell.exe -NoProfile -Command <command>`). The caller
   *     therefore passes the BARE command, NOT a pre-rendered `powershell.exe
   *     -Command '…'` string (pre-rendering + a default `cmd` binShell produced
   *     a `cmd /c "powershell.exe -Command …"` DOUBLE shell).
   *   - macOS/Linux: the POSIX shell to run `-c <wrapped>` under (defaults to
   *     `/bin/bash` inside ASRT when omitted). LVIS leaves this undefined on
   *     POSIX — the wrapped command already names the shell — so the historical
   *     mac/linux behaviour is unchanged.
   *
   * TRUST: on Windows the inner shell runs INSIDE the restricted-token sandbox,
   * so an unexpected value is not a sandbox escape; but a bash `path` must still
   * originate from trusted host shell-detection (never workspace content) — it
   * is an arbitrary-exec footgun otherwise. LVIS only ever passes the fixed
   * shell-name discriminants here or a trusted resolved shell path.
   */
  readonly binShell?: string;
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
 *
 * @internal Exported for unit tests only (the Windows-logic tests assert the
 * win32 `windows.proxyPortRange` emission with `process.platform` forced). Not
 * part of the module's runtime API — boot uses {@link initializeAsrtSandbox}.
 */
export function buildSandboxConfig(trustedSettings: TrustedSandboxSettings): SandboxRuntimeConfig {
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
    // parentProxy EXPLICIT (PR #1356 security MINOR — corrected). ASRT's
    // resolveParentProxy (dist/sandbox/parent-proxy.js:46) reads
    //   `cfg?.http ?? process.env.HTTP_PROXY ?? process.env.http_proxy`.
    // An EMPTY object `{}` has no `http` key ⇒ `cfg?.http` is `undefined` ⇒ the
    // `??` chain STILL falls through to the host `process.env.HTTP_PROXY`
    // (identical to passing no parentProxy at all). Only an EXPLICIT EMPTY
    // STRING short-circuits the `??` chain (`'' ?? x` ⇒ `''`), yielding genuine
    // direct-connect with NO host-proxy chaining. So the secure floor is
    // `{ http: '', https: '' }`, NOT `{}`.
    //
    // We therefore always set http/https explicitly:
    //   - default (no trusted corporateProxy): empty strings ⇒ direct-connect,
    //     the secure floor — ASRT never inherits the ambient host proxy;
    //   - present: only the explicit, trusted corporate-proxy URLs are used.
    // `noProxy` carries no inheritance hazard (its only effect is to BYPASS the
    // proxy, never to add egress), so it is set only when explicitly supplied.
    parentProxy: {
      http: trustedSettings.corporateProxy?.http ?? "",
      https: trustedSettings.corporateProxy?.https ?? "",
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

  // Windows-only: pin the egress proxy bind range so it matches the WFP permit
  // (the install flow permits the SAME range — see DEFAULT_WINDOWS_PROXY_PORT_RANGE).
  // Always emitted on win32 (default range when not supplied) so the runtime
  // config and the WFP rule never desync. Inert on mac/linux — ASRT ignores the
  // `windows` section off Windows, but we only emit it on win32 to keep the
  // config minimal and the non-Windows config shape unchanged.
  const windows: WindowsConfig | undefined =
    process.platform === "win32"
      ? {
          // Name the SAME discriminator group the install WFP-keyed on, so the
          // restricted-token child resolves to the installed filter set.
          groupName: DEFAULT_WINDOWS_GROUP_NAME,
          proxyPortRange: [
            ...(trustedSettings.windows?.proxyPortRange ??
              DEFAULT_WINDOWS_PROXY_PORT_RANGE),
          ] as [number, number],
        }
      : undefined;

  return {
    network,
    filesystem,
    ...(windows !== undefined ? { windows } : {}),
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
 * @param askCb  RESERVED FOR NON-STRICT; INERT UNDER STRICT. The shipped model
 *               always sets `strictAllowlist: true`, where ASRT bypasses the
 *               callback entirely (hard-deny). Kept so a future non-strict
 *               configuration has a hook; boot does not pass it. The wiring
 *               test passes a recording callback purely to PROVE strict never
 *               consults it.
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
    options.binShell,
    toCustomConfig(options.filesystem),
    options.abortSignal,
  );
}

/**
 * Wrap a WORKER command (the long-lived plugin worker — MCP/python — that
 * actually performs runtime network egress) for sandboxed execution, returning
 * the `{ argv, env }` the host must spawn. Same wrapping primitive as
 * {@link wrapToolCommand}: the per-command channel carries ONLY the filesystem
 * jail (scoped to the worker's plugin sandbox root + needed dirs).
 *
 * STAGED FOR THE WORKER-EGRESS FOLLOW-UP — NO CALLER YET. This is intentionally
 * exported-but-unused: closing the long-lived-worker network egress gap is a
 * deliberately-separated follow-up PR (it needs per-plugin domain declaration +
 * dynamic user-configured-endpoint plumbing wired through the actual worker
 * spawn in mcp-client.ts). The Python SETUP spawns (python-runtime.ts
 * runUv/runPython) are NOT the egress doer — they run at boot before the gate
 * is active and legitimately need PyPI egress, so they plain-spawn. Do not
 * treat this as accidental dead code; the follow-up wires the real caller.
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
    options.binShell,
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
 * Align an allow-list with ASRT's domain-matching semantics so it enforces the
 * SAME hosts LVIS's host-fetch allow-list does.
 *
 * SEMANTICS DIVERGENCE (PR #1356 MINOR): ASRT's `matchesDomainPattern`
 * (dist/sandbox/domain-pattern.js:23) matches a BARE `example.com` EXACTLY —
 * `h === pattern` — so `sub.example.com` is NOT covered; a strict subdomain
 * needs the explicit `*.example.com` pattern (`h.endsWith('.' + base)`). LVIS's
 * own `urlHostMatchesAllowList` (host-allow-list.ts) instead treats a bare
 * `example.com` as a DOT-BOUNDARY SUFFIX — it allows `sub.example.com` too.
 * Passing the manifest union RAW would therefore enforce a STRICTER set under
 * ASRT than the host fetch path advertises (a plugin that declared
 * `example.com` and reaches `api.example.com` via hostFetch would be silently
 * hard-denied by the sandbox).
 *
 * Normalization: for each BARE domain `d` we emit BOTH `d` (the apex, exact
 * match) AND `*.d` (every strict subdomain) so ASRT's two matcher branches
 * together reproduce LVIS's dot-boundary suffix match. Entries already in
 * wildcard form (`*.d`) pass through unchanged; the deny-all `*` (only valid in
 * deniedDomains) and empty entries are dropped. Deduped, order-stable (apex
 * before its wildcard).
 */
export function normalizeUnionForAsrt(
  domains: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (entry: string): void => {
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  };
  for (const raw of domains) {
    if (typeof raw !== "string") continue;
    const d = raw.trim().toLowerCase();
    if (d.length === 0 || d === "*") continue;
    if (d.startsWith("*.")) {
      // Already a wildcard — pass through (no apex implied by a bare `*.d`).
      add(d);
      continue;
    }
    // Bare domain: emit apex + every strict subdomain to mirror LVIS's
    // dot-boundary suffix match against ASRT's exact/`*.` two-branch matcher.
    add(d);
    add(`*.${d}`);
  }
  return out;
}

/**
 * The TRUSTED host-settings slice {@link computeDynamicEndpointHosts} reads.
 * Intentionally a structural subset of `AppSettings` (not an import of it) so
 * the function is pure, unit-testable in isolation, and tolerant of partial
 * settings shapes (test doubles, pre-migration files). Only the LLM vendor
 * blocks' user-configured `baseUrl`s are consulted — the dynamic endpoints a
 * sandboxed worker actually reaches.
 */
export interface DynamicEndpointSettings {
  readonly llm?: {
    readonly vendors?: Record<string, { readonly baseUrl?: string } | undefined>;
  };
}

/**
 * Extract the host-resolved DYNAMIC endpoint HOSTNAMES from TRUSTED settings, so
 * the shared strict-union allow-list reflects not just static manifest domains
 * but ALSO the user-configured endpoints a sandboxed worker actually reaches.
 *
 * WHY THIS EXISTS — the union gap this closes:
 * The boot union is built from each loaded plugin's
 * `manifest.networkAccess.allowedDomains`. But some plugins' REAL egress host is
 * NOT a static manifest domain — it is USER-CONFIGURED. The concrete case:
 * local-indexer's embedding + image-caption calls go to the host's Azure OpenAI
 * resource, resolved host-side as `settings.llm.vendors["azure-foundry"].baseUrl`
 * (the same value `hostApi.resolveApiKey({ vendor: "azure-openai" })` returns —
 * see main/host-api/resolve-api-key.ts, where "azure-openai" maps to
 * "azure-foundry"). The indexer's manifest `networkAccess` is null, so it
 * contributes NOTHING to the static union — its endpoint would be hard-denied
 * under strict enforcement. The host-resolved endpoint string is the DYNAMIC
 * source of truth that must feed the union. A user-set custom `baseUrl` on ANY
 * vendor block is treated the same way (a custom endpoint a worker would reuse).
 *
 * DYNAMIC SOURCE: every `llm.vendors[*].baseUrl` present in trusted settings.
 * This is the ONLY place the host holds a configured-endpoint URL string that a
 * worker would reach; there is no separate host-side embedding/caption endpoint
 * setting (the indexer resolves both through the same Azure resource baseUrl).
 *
 * NO-FALLBACK (deny-by-default): each URL is reduced to `new URL(s).hostname`.
 * A malformed/empty/whitespace `baseUrl` (or a parse that yields no hostname)
 * contributes NOTHING — it is NOT a wildcard and NOT an "allow all" fallback. A
 * missing endpoint simply isn't in the union, so strict enforcement hard-denies
 * it and the plugin surfaces its own "endpoint not configured" error. Deduped,
 * order-stable.
 *
 * @param settings  TRUSTED host/user settings (or a structural subset). Never a
 *                  plugin/project/MCP-influenced surface — these hosts widen the
 *                  enforced allow-list, so they must originate from trusted
 *                  settings only (same trust seam as the manifest union).
 * @returns bare hostnames (e.g. `my-resource.openai.azure.com`), ready to feed
 *          {@link computeUnionAllowedDomains} alongside the manifest allow-lists
 *          (then {@link normalizeUnionForAsrt} for ASRT's matcher).
 */
export function computeDynamicEndpointHosts(
  settings: DynamicEndpointSettings | undefined,
): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  const vendors = settings?.llm?.vendors;
  if (!vendors) return hosts;
  for (const block of Object.values(vendors)) {
    const raw = block?.baseUrl;
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    let hostname: string;
    try {
      hostname = new URL(trimmed).hostname;
    } catch {
      // Malformed endpoint — NOT a wildcard, NOT an allow-all fallback. It
      // simply contributes no host (deny-by-default per the no-fallback rule).
      continue;
    }
    const host = hostname.trim().toLowerCase();
    if (host.length === 0 || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
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
