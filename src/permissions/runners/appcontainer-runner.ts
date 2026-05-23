/**
 * Windows AppContainer sandbox runner — detect-only implementation.
 *
 * Spec ref: docs/research/sandbox-isolation.md
 * Issue: #691
 *
 * Decision refs:
 *   D3: Windows AppContainer only (no WSL2 fallback). Verified-kernel via
 *       capability SID model. Full native Win32 spawn (CreateProcess +
 *       CreateAppContainerProfile) requires node-ffi or N-API binding —
 *       deferred to a future native-binding deliverable.
 *   D8: detect-only. detect() returns available=false with a clear reason so
 *       boot skips registration. Windows tools fall through to isolation=none
 *       with the composition rule + reviewer no-downgrade safety net.
 *
 * Future native-binding deliverable (out of scope here):
 *   Native CreateProcess + CreateAppContainerProfile via N-API binding that
 *   replaces this stub. detect() will then return available=true and spawn()
 *   will launch the child inside a named AppContainer profile.
 *
 * Why detect-only rather than a PowerShell wrapper:
 *   A PowerShell-based AppContainer launcher adds a process layer without
 *   actually enforcing the AppContainer capability SID — it provides a false
 *   sense of isolation. This implementation chooses honesty (available=false)
 *   over a leaky wrapper that misrepresents the sandbox kind.
 */

import type {
  SandboxRunner,
  SandboxCapabilityDescriptor,
  SandboxedProcess,
  SandboxRunnerDetect,
  SandboxSpawnOptions,
} from "../sandbox-runner.js";

export class AppContainerRunner implements SandboxRunner {
  /**
   * Probe whether Windows AppContainer spawn is available.
   *
   * Always returns available=false because the native Win32 binding
   * (CreateProcess + CreateAppContainerProfile) is not yet implemented.
   * Boot skips registration; Windows tools run with isolation=none.
   *
   * The native binding will replace this to:
   *   1. Check process.platform === "win32"
   *   2. Verify Windows 8+ (AppContainer introduced in 8.0.6000)
   *   3. Probe capability SID availability via the native binding
   *   4. Return available=true with kind="appcontainer" + confidence="verified"
   */
  async detect(): Promise<SandboxRunnerDetect> {
    if (process.platform !== "win32") {
      return {
        available: false,
        reason: "AppContainerRunner only supports win32",
        kind: "none",
        confidence: "verified",
      };
    }
    // D3: native Win32 binding not yet implemented.
    // Return available=false so boot skips registration and Windows tools
    // fall through to isolation=none — no false sense of isolation.
    return {
      available: false,
      reason:
        "AppContainer spawn requires native Win32 binding " +
        "(CreateProcess + CreateAppContainerProfile via N-API — pending native binding). " +
        "Windows tools run with isolation=none until the native binding lands.",
      kind: "none",
      confidence: "verified",
    };
  }

  /**
   * NOT IMPLEMENTED — throws always.
   *
   * Boot does not call spawn() because detect() returns available=false,
   * so registration is skipped and no caller reaches this method.
   * This throw is a safety backstop in case registration is attempted via
   * test injection or future refactor.
   *
   * The native binding will implement: spawn a child process inside a named
   * AppContainer profile via CreateProcess with
   * PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, exposing stdout/stderr as
   * WHATWG ReadableStream<Uint8Array> (matching BwrapRunner +
   * SandboxExecRunner conventions).
   */
  async spawn(
    _cmd: string,
    _args: readonly string[],
    _capabilities: Partial<SandboxCapabilityDescriptor>,
    _options?: SandboxSpawnOptions,
  ): Promise<SandboxedProcess> {
    throw new Error(
      "AppContainerRunner.spawn: Windows native AppContainer spawn requires " +
      "N-API binding (pending native binding deliverable). " +
      "detect() returns available=false so this path should not be reached in production.",
    );
  }
}
