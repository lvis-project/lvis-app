/**
 * macOS sandbox-exec sandbox runner — PR-A3 implementation.
 *
 * Spec ref: docs/research/sandbox-isolation.md
 * Issue: #691 PR-A3
 *
 * Decision refs:
 *   D2: sandbox-exec PARTIAL accepted — known bypass paths exist (localhost/IPv6/
 *       DNS/Bonjour/UDS). kind="partial" and confidence="policy-best-effort" reflect
 *       this honestly. No Lima fallback.
 *   D8: detect-and-skip — if /usr/bin/sandbox-exec is absent (abnormal macOS),
 *       runner stays unregistered. macOS tools run with isolation=none.
 *
 * SBPL profile strategy:
 *   deny default — deny-by-default baseline.
 *   Selective allows for process-fork, process-exec, signal (self), essential
 *   system read paths, optional network, caller-specified fs paths, and tmp.
 *   A temporary .sb profile file is written per spawn to /tmp/lvis-sandbox-exec/
 *   and cleaned up after the child exits.
 *
 * Known limitations (D2 PARTIAL):
 *   - sandbox-exec does not block loopback (localhost/127.0.0.1/::1) network.
 *   - Bonjour/mDNS, Unix domain sockets, and some IPC paths are not reliably blocked.
 *   - Apple deprecated the sandbox-exec CLI in macOS 12+ (binary still ships).
 *   - Profile is policy-best-effort; kernel may allow paths not enumerated here.
 */

import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { access, constants, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  SandboxRunner,
  SandboxCapabilityDescriptor,
  SandboxedProcess,
  SandboxRunnerDetect,
  SandboxSpawnOptions,
} from "../sandbox-runner.js";

/** Absolute path to the macOS system sandbox-exec binary (D8: no bundled fallback). */
export const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

/** Temporary directory for per-spawn SBPL profile files. */
const PROFILE_DIR = join(tmpdir(), "lvis-sandbox-exec");

export class SandboxExecRunner implements SandboxRunner {
  /**
   * Probe whether sandbox-exec is available on the current host.
   *
   * Returns `available: false` immediately on non-darwin platforms.
   * Returns `kind: "partial"` and `confidence: "policy-best-effort"` (D2) —
   * sandbox-exec has known bypass paths so we honestly advertise PARTIAL.
   */
  async detect(): Promise<SandboxRunnerDetect> {
    if (process.platform !== "darwin") {
      return {
        available: false,
        reason: "SandboxExecRunner only supports darwin",
        kind: "none",
        confidence: "verified",
      };
    }
    try {
      await access(SANDBOX_EXEC_BIN, constants.X_OK);
      return {
        available: true,
        // D2: PARTIAL — known bypass paths: localhost/IPv6/DNS/Bonjour/UDS
        reason:
          "macOS sandbox-exec available (PARTIAL — known bypass paths: " +
          "localhost/IPv6/DNS/Bonjour/UDS; Apple deprecated CLI in macOS 12+)",
        kind: "partial",
        confidence: "policy-best-effort",
      };
    } catch {
      return {
        available: false,
        reason:
          "sandbox-exec not found at /usr/bin/sandbox-exec " +
          "(Apple system binary missing — abnormal macOS state)",
        kind: "none",
        confidence: "verified",
      };
    }
  }

  /**
   * Spawn `cmd` with `args` inside a sandbox-exec profile applying the
   * requested `capabilities`.
   *
   * The SBPL profile is written to a randomly-named temporary file under
   * /tmp/lvis-sandbox-exec/ (mode 0o600) and cleaned up after child exit.
   * randomBytes(6) in the filename prevents path-traversal and collision.
   *
   * Missing capability fields use conservative defaults:
   *   - `networkBlocked` defaults to `true` (deny network — D2 PARTIAL)
   *   - `processIsolated` is informational; sandbox-exec does not provide
   *     PID namespace isolation (no --unshare-pid equivalent on macOS)
   *   - `fsReadPaths`/`fsWritePaths` default to `[]`
   */
  async spawn(
    cmd: string,
    args: readonly string[],
    capabilities: Partial<SandboxCapabilityDescriptor>,
    options?: SandboxSpawnOptions,
  ): Promise<SandboxedProcess> {
    const profile = buildSbplProfile(capabilities);

    // Write the SBPL profile to a temp file. randomBytes prevents collision
    // and path traversal (no user-controlled content in the filename).
    await mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 });
    const profilePath = join(PROFILE_DIR, `profile-${randomBytes(6).toString("hex")}.sb`);
    await writeFile(profilePath, profile, { mode: 0o600 });

    // sandbox-exec -f <profile> <cmd> [args...]
    const sandboxArgs: string[] = ["-f", profilePath, cmd, ...args];

    const child = spawn(SANDBOX_EXEC_BIN, sandboxArgs, {
      // Pass caller env directly — sandbox-exec does not have --clearenv like
      // bwrap. The caller (bash.ts buildSafeChildEnv) is responsible for
      // stripping secrets before passing options.env.
      env: options?.env ?? {},
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (!child.stdout || !child.stderr) {
      await unlink(profilePath).catch(() => {});
      throw new Error("SandboxExecRunner: child process missing stdout/stderr pipes");
    }

    const exitCode = new Promise<number>((resolve, reject) => {
      child.on("exit", (code, signal) => {
        if (code !== null) {
          resolve(code);
        } else if (signal) {
          reject(new Error(`sandbox-exec process killed by signal ${signal}`));
        } else {
          reject(new Error("sandbox-exec process exited with no code and no signal"));
        }
      });
      child.on("error", reject);
    });

    // Clean up the temporary profile file after the child exits (success or error).
    exitCode.finally(() => { void Promise.resolve(unlink(profilePath)).catch(() => {}); });

    return {
      pid: child.pid ?? -1,
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      exitCode,
      abort: async () => {
        // MEDIUM-1: SIGTERM → 2 s grace → SIGKILL escalation.
        // Parity with bwrap-runner and bash.ts terminateProcess().
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

/**
 * Build an SBPL (Sandbox Profile Language) profile string for the requested
 * capability set.
 *
 * Exported for unit testing. The class spawn() method calls this directly.
 *
 * Strategy: deny-by-default baseline with selective allows.
 * All string paths are escaped to prevent SBPL injection.
 *
 * @internal — exported for testing only. Callers outside this module should
 *   use {@link SandboxExecRunner.spawn} which writes the profile to a temp file.
 */
export function buildSbplProfile(capabilities: Partial<SandboxCapabilityDescriptor>): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
  ];

  // ─── Process primitives (always allowed) ────────────────────────────────
  // Without these, almost nothing can run — the sandboxed shell itself needs
  // fork/exec, and signal(self) is needed for clean process management.
  lines.push("(allow process-fork)");
  lines.push("(allow process-exec)");
  lines.push("(allow signal (target self))");

  // ─── Essential system read paths ──────────────────────────────────────
  // Minimal set required for dynamic linker, shell, and system calls to work.
  // /usr — bash, sh, and standard binaries live here
  // /System — macOS system frameworks
  // /Library — system libraries and locale data
  // /private/var/db/dyld — dyld shared cache (needed by almost all binaries)
  lines.push(
    "(allow file-read*" +
    " (subpath \"/usr\")" +
    " (subpath \"/System\")" +
    " (subpath \"/Library\")" +
    " (subpath \"/private/var/db/dyld\"))",
  );

  // ─── Network ──────────────────────────────────────────────────────────
  // Default: deny network (D2 PARTIAL: loopback/UDS not reliably blocked).
  // Allow only when caller explicitly requests networkBlocked: false.
  if (capabilities.networkBlocked === false) {
    lines.push("(allow network*)");
  }
  // else: deny by default from the top-level deny

  // ─── Caller-specified FS read paths ──────────────────────────────────
  for (const path of capabilities.fsReadPaths ?? []) {
    lines.push(`(allow file-read* (subpath "${escapeSbplPath(path)}"))`);
  }

  // ─── Caller-specified FS write paths ─────────────────────────────────
  for (const path of capabilities.fsWritePaths ?? []) {
    lines.push(`(allow file-write* (subpath "${escapeSbplPath(path)}"))`);
  }

  // ─── Tmp always RW ────────────────────────────────────────────────────
  // Shell builtins, node, and python all write to /tmp and /var/folders.
  // These are process-scoped and do not cross the sandbox boundary.
  lines.push("(allow file-write* file-read* (subpath \"/tmp\") (subpath \"/private/tmp\"))");
  lines.push("(allow file-write* file-read* (subpath \"/private/var/folders\"))");

  // ─── Mach IPC + POSIX shared memory ──────────────────────────────────
  // deny-default is too strict for internal sandbox mechanics on macOS —
  // the sandbox-exec process itself uses mach ports and shared memory.
  lines.push("(allow mach-lookup)");
  lines.push("(allow ipc-posix-shm)");

  return lines.join("\n");
}

/**
 * Escape a filesystem path for safe embedding in an SBPL string literal.
 * Replaces `"` with `\"` to prevent SBPL injection via path values.
 * randomBytes-based profile filenames ensure the profilePath itself is safe.
 */
function escapeSbplPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
