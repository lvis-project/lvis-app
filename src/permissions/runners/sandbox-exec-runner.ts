/**
 * macOS sandbox-exec sandbox runner.
 *
 * Spec ref: docs/research/sandbox-isolation.md
 * Issue: #691
 *
 * Design decisions:
 *   sandbox-exec PARTIAL accepted — known bypass paths exist (localhost/IPv6/
 *       DNS/Bonjour/UDS). kind="partial" and confidence="policy-best-effort" reflect
 *       this honestly. No Lima fallback.
 *   detect-and-skip — if /usr/bin/sandbox-exec is absent (abnormal macOS),
 *       runner stays unregistered. macOS tools run with isolation=none.
 *
 * SBPL profile strategy:
 *   deny default — deny-by-default baseline.
 *   Selective allows for process-fork, process-exec, signal (self), essential
 *   system read paths, optional network, caller-specified fs paths, and tmp.
 *   A temporary per-spawn directory is created via mkdtemp() under /tmp/
 *   (prefix: lvis-sandbox-exec-). The .sb profile is written there (0o600)
 *   and the entire directory is rm -rf'd after the child exits.
 *
 * Known limitations (PARTIAL — sandbox-exec):
 *   - sandbox-exec does not block loopback (localhost/127.0.0.1/::1) network.
 *   - Bonjour/mDNS, Unix domain sockets, and some IPC paths are not reliably blocked.
 *   - Apple deprecated the sandbox-exec CLI in macOS 12+ (binary still ships).
 *   - Profile is policy-best-effort; kernel may allow paths not enumerated here.
 */

import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { access, constants, writeFile, rm, chmod, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SandboxRunner,
  SandboxCapabilityDescriptor,
  SandboxedProcess,
  SandboxRunnerDetect,
  SandboxSpawnOptions,
} from "../sandbox-runner.js";
import { trackManagedChildProcess } from "../../main/managed-child-processes.js";

/** Absolute path to the macOS system sandbox-exec binary (no bundled fallback). */
export const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

export class SandboxExecRunner implements SandboxRunner {
  /**
   * Probe whether sandbox-exec is available on the current host.
   *
   * Returns `available: false` immediately on non-darwin platforms.
   * Returns `kind: "partial"` and `confidence: "policy-best-effort"` —
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
        // PARTIAL — known bypass paths: localhost/IPv6/DNS/Bonjour/UDS
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
   * CRITICAL (TOCTOU fix): Profile dir is created via mkdtemp() per spawn —
   * each call gets a unique, owner-only directory guaranteed by the OS at
   * creation time. No shared /tmp/lvis-sandbox-exec/ parent that an attacker
   * could pre-create with 0o777 to swap in a permissive profile.
   *
   * Missing capability fields use conservative defaults:
   *   - `networkBlocked` defaults to `true` (deny network — PARTIAL enforcement)
   *   - `processIsolated` is informational; sandbox-exec does not provide
   *     PID namespace isolation (no --unshare-pid equivalent on macOS)
   *   - `fsReadPaths`/`fsWritePaths` default to `[]`
   *
   * MEDIUM (env required): options.env MUST be provided (bwrap --clearenv
   * parity). Refusing to spawn with default process.env prevents secret leak.
   */
  async spawn(
    cmd: string,
    args: readonly string[],
    capabilities: Partial<SandboxCapabilityDescriptor>,
    options?: SandboxSpawnOptions,
  ): Promise<SandboxedProcess> {
    // MEDIUM: env is required — fail-closed to prevent secret leak.
    if (!options?.env) {
      throw new Error(
        "SandboxExecRunner: options.env is REQUIRED. Pass buildSafeChildEnv() result. " +
        "Refusing to spawn with default env to prevent secret leak (bwrap --clearenv parity).",
      );
    }

    if (capabilities.processIsolated === true) {
      // Known limitation: macOS sandbox-exec does not provide PID namespace
      // isolation. Log a warning so callers are not misled.
      // eslint-disable-next-line no-console
      console.warn(
        "SandboxExecRunner: processIsolated=true requested but macOS sandbox-exec " +
        "does not provide PID-namespace isolation. Capability is informational only.",
      );
    }

    const profile = buildSbplProfile(capabilities);

    // CRITICAL (TOCTOU): mkdtemp() creates a unique dir with 0o700 mode,
    // owner set to current process uid, atomically — no pre-create race.
    // Belt-and-suspenders: verify uid and explicitly chmod 0o700 after.
    const profileDir = await mkdtemp(join(tmpdir(), "lvis-sandbox-exec-"));

    try {
      // Verify ownership — catches symlink races or unexpected uid mismatches.
      if (process.getuid) {
        const st = await stat(profileDir);
        if (st.uid !== process.getuid()) {
          throw new Error("SandboxExecRunner: profile dir ownership mismatch");
        }
      }
      // Explicit chmod 0o700 — belt-and-suspenders against umask or OS edge cases.
      await chmod(profileDir, 0o700);

      const profilePath = join(profileDir, "profile.sb");
      await writeFile(profilePath, profile, { mode: 0o600 });

      // sandbox-exec -f <profile> <cmd> [args...]
      const sandboxArgs: string[] = ["-f", profilePath, cmd, ...args];

      const child = spawn(SANDBOX_EXEC_BIN, sandboxArgs, {
        // Pass caller env directly — sandbox-exec does not have --clearenv like
        // bwrap. The caller is responsible for stripping secrets via buildSafeChildEnv.
        env: options.env,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
      trackManagedChildProcess(child, { label: "sandbox:sandbox-exec" });

      if (!child.stdout || !child.stderr) {
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

      // Cleanup: rm the entire per-spawn profileDir (not just the .sb file).
      exitCode.finally(() => {
        void Promise.resolve(rm(profileDir, { recursive: true, force: true })).catch(() => {});
      });

      return {
        pid: child.pid ?? -1,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        exitCode,
        abort: async () => {
          // SIGTERM → 2 s grace → SIGKILL escalation.
          // Parity with bwrap-runner and bash.ts terminateProcess().
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null && !child.killed) {
              child.kill("SIGKILL");
            }
          }, 2000).unref();
        },
      };
    } catch (err) {
      // Cleanup profileDir on setup error (before child was spawned).
      await Promise.resolve(rm(profileDir, { recursive: true, force: true })).catch(() => {});
      throw err;
    }
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
  // Default: deny network (PARTIAL: loopback/UDS not reliably blocked by sandbox-exec).
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
 *
 * MEDIUM (security): Fail-closed on control characters. SBPL string
 * tokenizer is C-string backed — NUL, CR, LF, and other C0 control chars
 * cause silent truncation or undefined behavior that could break the
 * deny-default baseline (e.g. `)\n(allow file-write* ...` injection).
 * Reject rather than silently strip so callers learn of bad paths early.
 */
function escapeSbplPath(path: string): string {
  // Reject control characters (C0: 0x00–0x1F, DEL: 0x7F).
  if (/[\x00-\x1f\x7f]/.test(path)) {
    throw new Error(
      `SandboxExecRunner: control character in sandbox path (rejected to prevent SBPL injection): ${JSON.stringify(path)}`,
    );
  }
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
