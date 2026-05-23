/**
 * Sandbox runner interface + boot-time registry.
 *
 * Spec ref: docs/research/sandbox-isolation.md
 * Issue: #691 sandbox foundation
 *
 * D4: SandboxCapabilityDescriptor uses a narrow allowlist
 *   ({ networkBlocked, fsReadPaths, fsWritePaths, processIsolated }).
 * D9: MCP child-process slot reserved in the registry (platform key
 *   "mcp" is a conventional key reserved for per-OS runner registration).
 *
 * Per-OS implementations cover Linux (bwrap) and macOS/Windows
 * (sandbox-exec + AppContainer). Boot detection wiring lives in the
 * per-OS runner modules. This file is the interface contract only.
 */

import type { SandboxKind, SandboxCapability } from "./sandbox-capability.js";
import { setActiveSandboxCapability, __resetActiveSandboxCapabilityForTest } from "./sandbox-capability.js";

// ─── Capability Descriptor ────────────────────────────────────────────────────

/**
 * Sandbox capability descriptor — D4 narrow allowlist.
 *
 * v1: 4 fields. v2 will add OCI extension via optional field.
 *
 *   - `networkBlocked`   — true when the runner prevents all outbound
 *     network egress for the spawned process.
 *   - `fsReadPaths`      — paths the child may read. `[]` = inherit host
 *     (no additional restriction). Absolute paths only.
 *   - `fsWritePaths`     — paths the child may write. Same convention.
 *   - `processIsolated`  — true when the runner places the child in a
 *     separate PID namespace or equivalent OS construct (so it cannot
 *     ptrace host processes).
 */
export interface SandboxCapabilityDescriptor {
  networkBlocked: boolean;
  fsReadPaths: string[];   // [] = inherit host
  fsWritePaths: string[];
  processIsolated: boolean;
}

// ─── SandboxedProcess ─────────────────────────────────────────────────────────

/**
 * Handle to a running sandboxed child process. Callers consume
 * `stdout`/`stderr` as async streams and await `exitCode` for the
 * termination result. `abort()` requests graceful shutdown followed by
 * SIGKILL if the process does not exit within an implementation-defined
 * grace period defined by each per-OS runner implementation.
 *
 * `stdout`/`stderr` are Web Streams (`ReadableStream<Uint8Array>`) following
 * the Fetch/WHATWG convention. Consumers pipe through
 * `TextDecoderStream` to obtain UTF-8 string chunks; this handles multi-byte
 * CJK split-chunk boundaries correctly.
 */
export interface SandboxedProcess {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exitCode: Promise<number>;
  abort(): Promise<void>;
}

// ─── SandboxRunnerDetect ──────────────────────────────────────────────────────

/**
 * Result of {@link SandboxRunner.detect}. Callers use `available` to
 * short-circuit and `kind`/`confidence` to populate a
 * {@link SandboxCapability} for the reviewer SOT.
 */
export interface SandboxRunnerDetect {
  available: boolean;
  reason: string;
  kind: SandboxKind;
  confidence: SandboxCapability["confidence"];
}

// ─── SandboxRunner ────────────────────────────────────────────────────────────

/**
 * Options bag for SandboxRunner.spawn — extensible without breaking
 * existing call-sites that pass capabilities + env positionally.
 */
export interface SandboxSpawnOptions {
  /** Environment variables for the child (runner uses --clearenv + --setenv to prevent env leakage). */
  env?: Record<string, string>;
  /**
   * Working directory for the child process. Runner MUST honour this via
   * its OS-specific mechanism (bwrap: --chdir) AND pass it to Node spawn's
   * `cwd` option so the bwrap wrapper itself starts in the right directory.
   * Omitting cwd causes child to inherit the host process cwd.
   */
  cwd?: string;
}

/**
 * Single sandbox runner abstraction. Per-OS implementations in runner modules.
 *
 * `spawn` MUST throw if the runner is not available — callers check
 * `detect()` at boot and store the result; they MUST NOT attempt to spawn
 * without a prior `detect()` returning `available: true`.
 *
 * `detect` is idempotent and cheap (binary presence check). Callers MAY
 * cache the result after the first successful boot-time probe.
 */
export interface SandboxRunner {
  /**
   * Spawn `cmd` with `args` under the runner's OS sandbox, applying the
   * requested `capabilities`. Partial descriptors are allowed — missing
   * fields fall back to the runner's default policy (see per-OS runner docs).
   *
   * @param cmd          Absolute path to the executable (no shell expansion).
   * @param args         Argument list. Immutable to prevent TOCTOU mutations.
   * @param capabilities Requested sandbox constraints (D4 narrow allowlist).
   * @param options      Optional env overrides and working directory.
   * @returns            A live {@link SandboxedProcess} handle.
   */
  spawn(
    cmd: string,
    args: readonly string[],
    capabilities: Partial<SandboxCapabilityDescriptor>,
    options?: SandboxSpawnOptions,
  ): Promise<SandboxedProcess>;

  /**
   * Probe whether this runner is available on the current host.
   * Returns a {@link SandboxRunnerDetect} that callers use to populate
   * the reviewer's {@link SandboxCapability} SOT.
   */
  detect(): Promise<SandboxRunnerDetect>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Registry key: either a `NodeJS.Platform` value (per-OS runners registered
 * by the platform runner modules) or the literal `"mcp"` for the cross-platform
 * MCP spawn path (D9 commitment). Using `"mcp"` here makes the D9 slot
 * type-system enforced rather than a docstring-only convention.
 */
export type SandboxRunnerKey = NodeJS.Platform | "mcp";

/**
 * Boot-time platform-keyed registry. Native platforms ('linux', 'darwin',
 * 'win32') are registered by per-OS runner modules; the conventional 'mcp'
 * key reserves a slot for D9 child-process integration.
 *
 * Consumers MAY explicitly retry with key 'mcp' when getSandboxRunner(process.platform)
 * returns undefined. (Automatic MCP-runner wrapper deferred pending the D9
 * native binding.)
 *
 * Registry is module-level so the same Map is shared across all callers
 * in the same process. Tests MUST call {@link __resetSandboxRunnersForTest}
 * in `afterEach` to avoid cross-test pollution.
 */
const runners = new Map<SandboxRunnerKey, SandboxRunner>();

/**
 * MAJOR-1 SOT fix: cache the detection result alongside the runner so
 * detectSandboxCapability() can read from this authoritative store instead of
 * always returning kind="none". registerSandboxRunner stores the result;
 * detectSandboxCapability reads it once per call (no perf cost: cached).
 */
const detections = new Map<SandboxRunnerKey, SandboxRunnerDetect>();

/**
 * Boot-phase lock. Set to `true` by {@link sealSandboxRunnerRegistry} after
 * all runners have been detected and registered at boot. Post-seal calls to
 * {@link registerSandboxRunner} throw in non-test environments to prevent
 * runtime injection of untrusted runners.
 *
 * Tests bypass the seal check when `NODE_ENV` includes `"test"`.
 */
let sealed = false;

/**
 * Lock the runner registry after boot-time detection is complete.
 *
 * Called once from `boot.ts` after all per-OS runners have been detected and
 * registered. Post-seal attempts to register runners throw in production
 * (guarded by `NODE_ENV !== "test"`) so runtime injection of untrusted
 * runners is caught immediately.
 *
 * Called from boot.ts immediately after all per-OS runners are registered.
 */
export function sealSandboxRunnerRegistry(): void {
  sealed = true;
}

/**
 * Register a sandbox runner for the given platform or MCP slot. Called once
 * per runner at boot. Subsequent registrations for the same key
 * overwrite the previous entry — this enables test injection.
 *
 * Throws after {@link sealSandboxRunnerRegistry} has been called, unless
 * `NODE_ENV` includes `"test"` (vitest / jest environments bypass the guard
 * so runner mocks can be injected per-test via `afterEach` reset).
 *
 * @param detection  Optional detection result from runner.detect(). When
 *   provided, stored alongside the runner so {@link getActiveCapability}
 *   returns the correct kind/confidence — fixes MAJOR-1 SOT staleness.
 */
export function registerSandboxRunner(
  platform: SandboxRunnerKey,
  runner: SandboxRunner,
  detection?: SandboxRunnerDetect,
): void {
  if (sealed && !(process.env["NODE_ENV"] ?? "").includes("test")) {
    throw new Error(
      `SandboxRunner registry is sealed after boot — cannot register runner for '${platform}' at runtime`,
    );
  }
  runners.set(platform, runner);
  if (detection) {
    detections.set(platform, detection);
    // MAJOR-1: update the SOT in sandbox-capability.ts so detectSandboxCapability()
    // returns the correct kind without re-probing the OS.
    setActiveSandboxCapability({
      kind: detection.kind,
      confidence: detection.confidence,
      platform: platform === "mcp" ? process.platform : platform as NodeJS.Platform,
      reason: detection.reason,
    });
  }
}

/**
 * Return the detection result stored by {@link registerSandboxRunner} for the
 * given platform, or `undefined` when no runner is registered.
 *
 * Used by {@link sandbox-capability.ts detectSandboxCapability} to provide an
 * accurate SOT without re-probing the OS on every reviewer call.
 */
export function getActiveDetection(platform: SandboxRunnerKey): SandboxRunnerDetect | undefined {
  return detections.get(platform);
}

/**
 * Retrieve the registered runner for the given platform or MCP slot.
 * Returns `undefined` when no runner has been registered (i.e. the
 * per-OS runner module has not run yet, or the host OS has no supported runner).
 */
export function getSandboxRunner(
  platform: SandboxRunnerKey,
): SandboxRunner | undefined {
  return runners.get(platform);
}

/**
 * For test isolation only. Clears all registered runners AND resets the
 * boot-phase seal so each test starts from a clean slate.
 *
 * MUST be called in `afterEach` for any test that calls
 * {@link registerSandboxRunner} or {@link sealSandboxRunnerRegistry}.
 *
 * @internal
 */
export function __resetSandboxRunnersForTest(): void {
  runners.clear();
  detections.clear();
  sealed = false;
  __resetActiveSandboxCapabilityForTest();
}
