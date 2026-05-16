/**
 * Sandbox runner interface + boot-time registry.
 *
 * Spec ref: docs/research/sandbox-isolation.md
 * Issue: #691 PR-A1 Foundation
 *
 * D4: SandboxCapabilityDescriptor uses a narrow allowlist
 *   ({ networkBlocked, fsReadPaths, fsWritePaths, processIsolated }).
 * D9: MCP child-process slot reserved in the registry (platform key
 *   "mcp" is a conventional key reserved for PR-A2/A3 registration).
 *
 * Per-OS implementations land in PR-A2 (Linux bwrap) and PR-A3
 * (macOS sandbox-exec + Windows AppContainer). Boot detection wiring
 * lands in PR-A2. This file is the interface contract only.
 */

import type { SandboxKind, SandboxCapability } from "./sandbox-capability.js";

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
 * grace period (PR-A2/A3 will document the exact timeout).
 *
 * `stdout`/`stderr` are Web Streams (`ReadableStream<Uint8Array>`) following
 * the Fetch/WHATWG convention. PR-A2/A3 consumers pipe through
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
 * Single sandbox runner abstraction. Per-OS implementations in PR-A2/A3.
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
   * fields fall back to the runner's default policy (see PR-A2/A3 docs).
   *
   * @param cmd          Absolute path to the executable (no shell expansion).
   * @param args         Argument list. Immutable to prevent TOCTOU mutations.
   * @param capabilities Requested sandbox constraints (D4 narrow allowlist).
   * @param env          Optional environment overrides for the child.
   * @returns            A live {@link SandboxedProcess} handle.
   */
  spawn(
    cmd: string,
    args: readonly string[],
    capabilities: Partial<SandboxCapabilityDescriptor>,
    env?: Record<string, string>,
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
 * by PR-A2/A3) or the literal `"mcp"` for the cross-platform MCP spawn path
 * (D9 commitment). Using `"mcp"` here makes the D9 slot type-system enforced
 * rather than a docstring-only convention.
 */
export type SandboxRunnerKey = NodeJS.Platform | "mcp";

/**
 * Boot-time registry keyed by {@link SandboxRunnerKey}.
 *
 * Per-OS PR-A2/A3 will call {@link registerSandboxRunner} during the
 * boot sequence (§4.2 step 3). The MCP spawn path (D9) registers under
 * the conventional key "mcp" — handled by the caller as a cross-platform
 * override; the platform key lookup falls through to "mcp" when no native
 * runner is registered.
 *
 * Registry is module-level so the same Map is shared across all callers
 * in the same process. Tests MUST call {@link __resetSandboxRunnersForTest}
 * in `afterEach` to avoid cross-test pollution.
 */
const runners = new Map<SandboxRunnerKey, SandboxRunner>();

/**
 * Register a sandbox runner for the given platform or MCP slot. Called once
 * per runner at boot (PR-A2/A3). Subsequent registrations for the same key
 * overwrite the previous entry — this enables test injection.
 */
export function registerSandboxRunner(
  platform: SandboxRunnerKey,
  runner: SandboxRunner,
): void {
  runners.set(platform, runner);
}

/**
 * Retrieve the registered runner for the given platform or MCP slot.
 * Returns `undefined` when no runner has been registered (i.e. PR-A2/A3
 * have not run yet, or the host OS has no supported runner).
 */
export function getSandboxRunner(
  platform: SandboxRunnerKey,
): SandboxRunner | undefined {
  return runners.get(platform);
}

/**
 * For test isolation only. Clears all registered runners so each test
 * starts from a clean slate.
 *
 * @internal
 */
export function __resetSandboxRunnersForTest(): void {
  runners.clear();
}
