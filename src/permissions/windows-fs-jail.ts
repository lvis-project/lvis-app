/**
 * Windows filesystem-jail shim (worker-confinement / sandbox completion).
 *
 * WHY THIS EXISTS — `@anthropic-ai/sandbox-runtime` (ASRT) 0.0.59/0.0.60 ships
 * the Windows FS-deny primitive INSIDE `srt-win.exe` (the `acl` subcommand +
 * `exec --holder-pid` handle-fence), but its JS layer never drives it on win32:
 * `wrapCommandWithSandboxWindows` forwards only `{command, group, sublayerGuid,
 * proxy ports, binShell}` and drops `customConfig.filesystem`. So on Windows the
 * FS jail is present-but-dark. This module drives that dark CLI from the host.
 *
 * CONTRACT (verified against the vendored Rust source
 * `vendor/srt-win-src/src/{main,acl}.rs`, NOT guessed):
 *   - `srt-win acl stamp  --holder-pid <PID> [--name <group>]`  ← stdin JSON
 *       `{ "denyRead": [...explicit files...], "denyWrite": [...] }`
 *       Stamps each path's DACL broker-only, refcounted in
 *       `%LOCALAPPDATA%\sandbox-runtime\state.db`. Directories/globs are
 *       rejected — explicit absolute file paths only.
 *   - `srt-win acl restore --holder-pid <PID> [--name <group>] --json`
 *       Releases this holder's claim; `--json` emits a per-path outcome array.
 *   - `srt-win acl recover [--force] --json`  ← crash recovery.
 *   - `srt-win exec ... --holder-pid <PID> -- <target>`  ← opens a
 *       no-FILE_SHARE_DELETE handle on every stamped file until the child
 *       exits, so the OS refuses delete/rename (DACL alone cannot fence that).
 *
 * The HOLDER PID is the SAME value on stamp/restore/exec — it MUST be a
 * long-lived process (the Electron main), never the short-lived `acl` process
 * (that would orphan the stamp instantly).
 *
 * DEPRECATION PLAN — this shim drives an UNDOCUMENTED, unexported CLI and is
 * pinned to ASRT 0.0.59 (see {@link assertSrtWinAclContract}). Replace it with
 * the official `customConfig.filesystem` win32 path once ASRT exposes it:
 *   upstream: anthropic-experimental/sandbox-runtime#336 (Approach G).
 *   tracking: lvis-project/lvis-app#1367.
 *
 * VERIFICATION — darwin-untestable. `srt-win.exe` is a Windows binary; CI
 * `windows-latest` exercises the wiring/logic, but REAL deny-enforcement (an
 * out-of-jail write is blocked; a stamped file survives delete) requires the
 * documented MANUAL WINDOWS QA gate (#1367) BEFORE the confines flip (PR-W3).
 * This module is reachable ONLY behind the existing default-OFF sandbox gate.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";

// NOTE: `groupName` is passed in by callers (asrt-sandbox.ts forwards
// DEFAULT_WINDOWS_GROUP_NAME) rather than imported here — that would create an
// asrt-sandbox ↔ windows-fs-jail import cycle.

/** The deny-list the host hands the win32 FS jail (resolved to explicit files). */
export interface WindowsFsDeny {
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
}

/** `node:os` arch → the `vendor/srt-win/<arch>` directory srt-win ships under. */
function srtWinArchDir(arch: string): string {
  // ASRT publishes prebuilt binaries under x64 / arm64 (Windows-on-ARM is a
  // real target). Node reports "x64"/"arm64", which match 1:1.
  if (arch === "x64" || arch === "arm64") return arch;
  throw new Error(`[windows-fs-jail] unsupported Windows arch '${arch}'`);
}

/**
 * Locate the bundled `srt-win.exe`. ASRT does NOT export its own
 * `getSrtWinPath()` from the package entry, so we resolve the package root and
 * mirror its `vendor/srt-win/<arch>/srt-win.exe` layout (the asarUnpack target
 * the packaging seam already keeps). `SRT_WIN_PATH` overrides for tests/QA.
 */
export function resolveSrtWinPath(): string {
  const override = process.env.SRT_WIN_PATH;
  if (override && override !== "") return override;
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("@anthropic-ai/sandbox-runtime/package.json");
  const root = dirname(pkgJson);
  const exe = join(root, "vendor", "srt-win", srtWinArchDir(process.arch), "srt-win.exe");
  if (!existsSync(exe)) {
    throw new Error(
      `[windows-fs-jail] srt-win.exe not found at ${exe} — set SRT_WIN_PATH or ` +
        `verify the asarUnpack of @anthropic-ai/sandbox-runtime/vendor/**`,
    );
  }
  return exe;
}

/**
 * `acl` rejects directories and globs — it stamps explicit files only. The
 * host deny floor ({@link getDefaultSensitiveReadDenyPaths}) mixes files and
 * dirs (e.g. `~/.ssh`, `~/.aws`), so narrow to paths that exist AND are regular
 * files. A dir in the floor is dropped here (it cannot be stamped as a single
 * path); covering a whole sensitive DIRECTORY on Windows is a PR-W3 concern
 * (enumerate-and-stamp, or rely on the parent-stamp inheritance acl applies).
 * Returns the explicit-file subset; callers log what was dropped (no silent
 * truncation — see the No-Fallback rule).
 */
export function toExplicitFiles(paths: readonly string[]): {
  readonly files: string[];
  readonly droppedNonFiles: string[];
} {
  const files: string[] = [];
  const droppedNonFiles: string[] = [];
  for (const p of paths) {
    try {
      if (existsSync(p) && statSync(p).isFile()) files.push(p);
      else droppedNonFiles.push(p);
    } catch {
      droppedNonFiles.push(p);
    }
  }
  return { files, droppedNonFiles };
}

/**
 * Inject `--holder-pid <pid>` into a win32 `srt-win exec` argv produced by
 * ASRT's `wrapCommandWithSandboxWindows`. That argv is
 *   `[exe, 'exec', ...group, ('--sublayer-guid' g)?, '--', <innerShell>, ...]`
 * `--holder-pid` is an `exec` OPTION, so it must land BEFORE the `'--'`
 * target separator. Idempotent: a no-op if already present.
 */
export function injectHolderPid(argv: readonly string[], holderPid: number): string[] {
  if (argv.includes("--holder-pid")) return [...argv];
  const sep = argv.indexOf("--");
  if (sep < 0) {
    throw new Error(
      "[windows-fs-jail] cannot inject --holder-pid: no '--' target separator in srt-win argv",
    );
  }
  return [...argv.slice(0, sep), "--holder-pid", String(holderPid), ...argv.slice(sep)];
}

/**
 * Drive `srt-win acl stamp` for the given deny-list under `holderPid`. The deny
 * paths are passed on STDIN as `{denyRead, denyWrite}` (camelCase, the exact
 * shape the Rust deserializes). Throws on a non-zero exit (FAIL-CLOSED — a
 * failed stamp must not silently leave the worker un-jailed).
 */
export function stampWindowsFsDeny(
  deny: WindowsFsDeny,
  holderPid: number,
  groupName: string,
): void {
  const exe = resolveSrtWinPath();
  const input = JSON.stringify({ denyRead: deny.denyRead, denyWrite: deny.denyWrite });
  const r = spawnSync(
    exe,
    ["acl", "stamp", "--name", groupName, "--holder-pid", String(holderPid)],
    { input, encoding: "utf8", timeout: 15000 },
  );
  if (r.status !== 0) {
    throw new Error(
      `[windows-fs-jail] acl stamp failed (status=${r.status ?? "signal:" + r.signal}): ` +
        `${(r.stderr || "").trim()}`,
    );
  }
}

/**
 * Drive `srt-win acl restore --json` to release `holderPid`'s stamps. Reads the
 * per-path JSON array and throws if any entry is not `restored` (a left-stamped
 * file means the original DACL could not be put back — surface it, don't hide).
 */
export function restoreWindowsFsDeny(
  holderPid: number,
  groupName: string,
): void {
  const exe = resolveSrtWinPath();
  const r = spawnSync(
    exe,
    ["acl", "restore", "--name", groupName, "--holder-pid", String(holderPid), "--json"],
    { encoding: "utf8", timeout: 15000 },
  );
  // `acl restore --json` exits 0 always and reports per-path status in the
  // array; a DB-layer failure is a non-zero exit with stderr.
  if (r.status !== 0) {
    throw new Error(
      `[windows-fs-jail] acl restore failed (status=${r.status ?? "signal:" + r.signal}): ` +
        `${(r.stderr || "").trim()}`,
    );
  }
  const notRestored = parseRestoreFailures(r.stdout || "");
  if (notRestored.length > 0) {
    throw new Error(
      `[windows-fs-jail] acl restore left ${notRestored.length} path(s) stamped: ` +
        notRestored.join(", "),
    );
  }
}

/** Run `srt-win acl recover --json` (crash recovery: prune dead holders). */
export function recoverWindowsFsStamps(groupName: string, force = false): void {
  const exe = resolveSrtWinPath();
  const args = ["acl", "recover", "--name", groupName, "--json"];
  if (force) args.splice(2, 0, "--force");
  const r = spawnSync(exe, args, { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) {
    throw new Error(
      `[windows-fs-jail] acl recover failed (status=${r.status ?? "signal:" + r.signal}): ` +
        `${(r.stderr || "").trim()}`,
    );
  }
}

/** Extract the paths a `--json` restore/recover left stamped (status != restored). */
function parseRestoreFailures(stdout: string): string[] {
  if (stdout.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Malformed output is itself a failure signal — FAIL-CLOSED.
    return ["<unparseable acl --json output>"];
  }
  const entries: Array<{ path?: string; status?: string }> = Array.isArray(parsed)
    ? (parsed as Array<{ path?: string; status?: string }>)
    : ((parsed as { paths?: Array<{ path?: string; status?: string }> })?.paths ?? []);
  return entries
    .filter((e) => e.status !== undefined && e.status !== "restored")
    .map((e) => e.path ?? "<unknown>");
}
