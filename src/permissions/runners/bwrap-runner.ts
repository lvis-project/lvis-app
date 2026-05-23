/**
 * Linux bubblewrap (bwrap) sandbox runner — PR-A2 implementation.
 *
 * Spec ref: docs/research/sandbox-isolation.md
 * Issue: #691 PR-A2
 *
 * Decision refs:
 *   D1: bwrap OS-only — no bundled binary, requires OS package (dnf install bubblewrap).
 *   D8: detect-and-skip — if /usr/bin/bwrap absent, runner stays unregistered;
 *       Linux tools run with isolation=none. Composition rule + reviewer
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
  SandboxSpawnOptions,
} from "../sandbox-runner.js";
import { trackManagedChildProcess } from "../../main/managed-child-processes.js";

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
   *   - `fsReadPaths` defaults to `[]` (no extra read mounts beyond the base whitelist)
   *   - `fsWritePaths` defaults to `[]` (no extra write mounts)
   *
   * CRITICAL-1: Uses `--clearenv` + `--setenv K V` for every entry in
   *   `options.env`. The bwrap binary itself is spawned with `env: {}` so
   *   no host env var (including ANTHROPIC_API_KEY, LVIS_*, etc.) leaks into
   *   the sandbox even if bash.ts buildSafeChildEnv() is bypassed.
   *
   * CRITICAL-2: `options.cwd` is passed as `--chdir <cwd>` inside bwrap
   *   (so the child's working directory is correct inside the namespace)
   *   AND as Node spawn's `cwd` option (so the bwrap wrapper binary itself
   *   resolves relative paths correctly before entering the namespace).
   *
   * MEDIUM-3: A base ro-bind whitelist (/lib /lib64 /bin /sbin) is always
   *   mounted so dynamic-linker-bound commands (git, python, etc.) work without
   *   callers having to enumerate low-level system paths.
   *
   * `stdout`/`stderr` are exposed as Web Streams (`ReadableStream<Uint8Array>`).
   * Consumers pipe through `TextDecoderStream` to obtain UTF-8 string chunks
   * (handles multi-byte CJK split-chunk boundaries correctly).
   *
   * `abort()` sends SIGTERM then escalates to SIGKILL after 2 s if the child
   * has not yet exited (MEDIUM-1: parity with bash.ts terminateProcess).
   */
  async spawn(
    cmd: string,
    args: readonly string[],
    capabilities: Partial<SandboxCapabilityDescriptor>,
    options?: SandboxSpawnOptions,
  ): Promise<SandboxedProcess> {
    const bwrapArgs: string[] = [];

    // CRITICAL-1: clear the entire inherited environment inside the namespace,
    // then re-populate only the explicit env entries passed by the caller.
    // This ensures no host secret (ANTHROPIC_API_KEY, LVIS_*, AWS_*, etc.)
    // leaks into the sandbox even if an upstream caller forgets to strip them.
    bwrapArgs.push("--clearenv");
    for (const [k, v] of Object.entries(options?.env ?? {})) {
      bwrapArgs.push("--setenv", k, v);
    }

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

    // MEDIUM-3: Base ro-bind whitelist — always mounted so dynamic-linker-bound
    // commands (git, bash, python, etc.) resolve their shared libraries and
    // helper binaries without callers having to enumerate low-level system paths.
    // --ro-bind-try silently skips absent paths (handles musl vs glibc layouts).
    const baseReadPaths = ["/lib", "/lib64", "/bin", "/sbin"];
    for (const path of baseReadPaths) {
      bwrapArgs.push("--ro-bind-try", path, path);
    }

    // Caller-specified FS read paths — bind-mount read-only.
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

    // CRITICAL-2: set the working directory inside the namespace.
    // Without --chdir the child inherits the host process cwd which may be
    // outside the bind-mounted write path, causing relative-path commands to fail.
    if (options?.cwd) {
      bwrapArgs.push("--chdir", options.cwd);
    }

    // Separator + actual command and its arguments.
    bwrapArgs.push("--", cmd, ...args);

    const child = spawn(BWRAP_BIN, bwrapArgs, {
      // CRITICAL-1: bwrap binary itself receives an empty environment — all env
      // propagation into the sandbox happens via --clearenv + --setenv above.
      env: {},
      // CRITICAL-2: also pass cwd to Node spawn so bwrap resolves paths correctly
      // before entering the namespace (e.g. relative --bind-try paths).
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackManagedChildProcess(child, { label: "sandbox:bwrap" });

    if (!child.stdout || !child.stderr) {
      throw new Error("BwrapRunner: child process missing stdout/stderr pipes");
    }

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
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      exitCode,
      abort: async () => {
        // MEDIUM-1: SIGTERM → 2 s grace → SIGKILL escalation.
        // Parity with bash.ts terminateProcess(). bwrap forwards SIGTERM into
        // the namespace; if the sandboxed process traps and ignores it, SIGKILL
        // is the backstop. .unref() so the timer does not prevent process exit.
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && !child.killed) {
            child.kill("SIGKILL");
          }
        }, 2000).unref();
      },
    };
  }
}
