/**
 * Linux bubblewrap (bwrap) sandbox runner — PR-A2 implementation.
 *
 * Spec ref: docs/research/sandbox-isolation.md
 * Issue: #691 PR-A2
 *
 * Decision refs:
 *   D1: bwrap OS-only — no bundled binary, requires OS package (dnf install bubblewrap).
 *   D8: detect-and-skip — if /usr/bin/bwrap absent, runner stays unregistered;
 *       Linux tools run with isolation=none. R-1 composition rule + reviewer
 *       judgment provide the safety net.
 *
 * bwrap flags used:
 *   --unshare-net       CLONE_NEWNET — verified-kernel egress block (D1)
 *   --unshare-pid       separate PID namespace so child cannot ptrace host
 *   --new-session       new session (setsid) isolates from terminal signals
 *   --ro-bind-try       bind-mount a path read-only (silently skips if absent)
 *   --bind-try          bind-mount a path read-write (silently skips if absent)
 *   --proc /proc        minimal /proc (needed by many binaries)
 *   --dev /dev          minimal /dev (needed for /dev/null, /dev/urandom)
 *   --tmpfs /tmp        writable tmpfs for tools that need /tmp
 *   --die-with-parent   child is killed when the parent process dies
 */

import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { access, constants } from "node:fs/promises";
import type {
  SandboxRunner,
  SandboxCapabilityDescriptor,
  SandboxedProcess,
  SandboxRunnerDetect,
} from "../sandbox-runner.js";

/** Absolute path to the OS-installed bwrap binary (D1: no bundled fallback). */
export const BWRAP_BIN = "/usr/bin/bwrap";

export class BwrapRunner implements SandboxRunner {
  /**
   * Probe whether bwrap is installed and executable on the current host.
   *
   * Returns `available: false` immediately on non-Linux platforms — bwrap
   * is a Linux-only binary and the caller (boot.ts) guards on
   * `process.platform === "linux"` before constructing this runner, but
   * `detect()` is also safe to call from any platform.
   */
  async detect(): Promise<SandboxRunnerDetect> {
    if (process.platform !== "linux") {
      return {
        available: false,
        reason: "BwrapRunner only supports linux",
        kind: "none",
        confidence: "verified",
      };
    }
    try {
      await access(BWRAP_BIN, constants.X_OK);
      return {
        available: true,
        reason: `bwrap detected at ${BWRAP_BIN}`,
        kind: "bubblewrap",
        confidence: "verified",
      };
    } catch {
      return {
        available: false,
        reason: `bwrap not installed (run: dnf install bubblewrap)`,
        kind: "none",
        confidence: "verified",
      };
    }
  }

  /**
   * Spawn `cmd` with `args` inside a bwrap sandbox applying the requested
   * `capabilities`.
   *
   * Missing capability fields use conservative defaults:
   *   - `networkBlocked` defaults to `true` (block all outbound egress)
   *   - `processIsolated` defaults to `true` (separate PID namespace)
   *   - `fsReadPaths` defaults to `[]` (no extra read mounts)
   *   - `fsWritePaths` defaults to `[]` (no extra write mounts)
   *
   * `stdout`/`stderr` are exposed as Web Streams (`ReadableStream<Uint8Array>`).
   * Consumers pipe through `TextDecoderStream` to obtain UTF-8 string chunks
   * (handles multi-byte CJK split-chunk boundaries correctly).
   *
   * `abort()` sends SIGTERM to the bwrap wrapper; bwrap propagates the signal
   * to the child process group inside the namespace.
   */
  async spawn(
    cmd: string,
    args: readonly string[],
    capabilities: Partial<SandboxCapabilityDescriptor>,
    env?: Record<string, string>,
  ): Promise<SandboxedProcess> {
    const bwrapArgs: string[] = [];

    // Network isolation — CLONE_NEWNET (D1 verified-kernel egress block).
    // Default: block (conservative). Caller passes `networkBlocked: false`
    // only when the tool explicitly needs outbound access.
    if (capabilities.networkBlocked !== false) {
      bwrapArgs.push("--unshare-net");
    }

    // Process isolation — separate PID namespace + new session.
    // Default: isolated. Prevents child from ptracing host processes.
    if (capabilities.processIsolated !== false) {
      bwrapArgs.push("--unshare-pid", "--new-session");
    }

    // FS read paths — bind-mount read-only. --ro-bind-try silently skips
    // if the source path does not exist (avoids hard failure on optional mounts).
    for (const path of capabilities.fsReadPaths ?? []) {
      bwrapArgs.push("--ro-bind-try", path, path);
    }

    // FS write paths — bind-mount read-write. --bind-try same silent-skip behaviour.
    for (const path of capabilities.fsWritePaths ?? []) {
      bwrapArgs.push("--bind-try", path, path);
    }

    // Minimal viable runtime environment. Every sandboxed process needs:
    //   /proc    — process and kernel pseudo-filesystem (many binaries rely on it)
    //   /dev     — device nodes (/dev/null, /dev/urandom, /dev/zero, /dev/pts)
    //   /tmp     — writable tmpfs (bash, node, python all write here)
    // --die-with-parent ensures the child is cleaned up if the host process
    // exits unexpectedly (avoids orphaned sandbox processes).
    bwrapArgs.push(
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--die-with-parent",
    );

    // Separator + actual command and its arguments.
    bwrapArgs.push("--", cmd, ...args);

    const child = spawn(BWRAP_BIN, bwrapArgs, {
      // Merge optional env overrides on top of the current process environment.
      // bash.ts already strips secrets via buildSafeChildEnv() before calling
      // us, so we forward what we receive without additional stripping.
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // exitCode promise: resolves with numeric code on clean exit, rejects on
    // signal kill or spawn error. Callers await this after draining stdout/stderr.
    const exitCode = new Promise<number>((resolve, reject) => {
      child.on("exit", (code, signal) => {
        if (code !== null) {
          resolve(code);
        } else if (signal) {
          reject(new Error(`bwrap process killed by signal ${signal}`));
        } else {
          reject(new Error("bwrap process exited with no code and no signal"));
        }
      });
      child.on("error", reject);
    });

    return {
      pid: child.pid ?? -1,
      // Convert Node.js Readable streams to WHATWG ReadableStream<Uint8Array>.
      // TextDecoderStream is the idiomatic downstream consumer (PR-A2 bash.ts adoption).
      stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
      exitCode,
      abort: async () => {
        // SIGTERM gives the sandboxed process a chance to clean up.
        // bwrap itself forwards the signal into the namespace.
        child.kill("SIGTERM");
      },
    };
  }
}
