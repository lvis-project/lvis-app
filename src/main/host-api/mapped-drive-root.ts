/**
 * What UNC path backs a Windows mapped drive, answered by the host.
 *
 * WHY THIS IS A HOST MEMBER AT ALL. A plugin that indexes files on a mapped
 * drive has to know the drive's real backing path, because the worker validates
 * every file against a list of allowed ROOTS and `Z:\report.docx` and
 * `\\server\share\report.docx` are the same file under two names. The plugin
 * used to answer the question itself, by running `powershell.exe`. Running an
 * interpreter is ambient axis 3 in the routing SOT
 * (`plugins/isolation/out-of-process-plugins.ts`) — the axis the confinement
 * exists to take away — and what the plugin actually wanted back was ONE
 * STRING. So the plugin supplies the drive letter and the host owns the
 * command.
 *
 * That split is the whole mediation: the plugin contributes DATA, the host
 * contributes CODE. Nothing a plugin passes reaches a shell. The letter is
 * re-validated here, and a caller-side check would not count — the caller is
 * the plugin.
 *
 * TWO ANSWERS THAT MUST NOT COLLAPSE. `null` means "this drive has no UNC
 * backing" — an ordinary local disk, and a complete answer. A THROW means "the
 * lookup could not run". Returning `null` for both would make an unresolvable
 * drive indistinguishable from a local one, and the caller would go on to build
 * an allow-list missing a root it needed, with nothing to report.
 *
 * NOT CACHED HERE, deliberately. A mapping can be dropped and remade against a
 * different share while the app runs, and a host-side cache would answer with
 * the old share for the rest of the session. Callers that want to avoid the
 * spawn cost may cache for as long as they are prepared to be wrong.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `C:`-shaped, and nothing else. Anchored, so no suffix can ride along. */
const DRIVE_LETTER = /^[A-Za-z]:$/u;

/**
 * Raised when the drive letter is not one. A programming error on the calling
 * side rather than a condition to handle, which is why it is distinct from the
 * `null` answer.
 */
export class InvalidDriveLetterError extends Error {
  constructor(value: string) {
    super(
      `[mapped-drive-root] not a drive letter: ${JSON.stringify(value)}. `
        + "Expected exactly two characters, a letter and a colon, e.g. 'Z:'.",
    );
    this.name = "InvalidDriveLetterError";
  }
}

/**
 * The PowerShell the host runs. A constant, not a template: the only
 * caller-influenced value is the single letter interpolated below, and it has
 * already been proven to match {@link DRIVE_LETTER} — one ASCII letter, which
 * cannot close the quote it sits in.
 *
 * Two lookups because they answer for different mapping kinds and neither
 * covers both: `Get-PSDrive` knows the session's own mapped drives, and
 * `Win32_LogicalDisk`'s `ProviderName` knows the ones the OS mapped. A drive
 * present to one and absent from the other is normal.
 */
function lookupScript(letter: string): string {
  return [
    `$drive = Get-PSDrive -Name '${letter}' -ErrorAction SilentlyContinue`,
    "| Select-Object -ExpandProperty DisplayRoot;",
    "if (-not $drive) {",
    `$drive = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'"`,
    "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProviderName);",
    "}",
    "if ($drive) { Write-Output $drive }",
  ].join(" ");
}

/** What the lookup needs from the platform, so a test can supply its own. */
export interface MappedDriveRootDeps {
  /** `process.platform`, injected so the non-Windows answer is testable. */
  readonly platform: () => NodeJS.Platform;
  /** Runs the lookup and returns its stdout. */
  readonly runLookup: (script: string) => Promise<string>;
}

const defaultDeps: MappedDriveRootDeps = {
  platform: () => process.platform,
  runLookup: async (script) => {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return stdout;
  },
};

/**
 * Resolve `drive` (`"Z:"`) to the UNC root behind it, or `null` when there is
 * none.
 *
 * Every non-Windows platform answers `null` because a mapped drive is not a
 * thing there — that is a complete answer, not a failure to look.
 */
export async function resolveMappedDriveRoot(
  drive: string,
  deps: MappedDriveRootDeps = defaultDeps,
): Promise<string | null> {
  if (!DRIVE_LETTER.test(drive)) throw new InvalidDriveLetterError(drive);
  if (deps.platform() !== "win32") return null;

  const letter = drive[0]!.toUpperCase();
  const stdout = await deps.runLookup(lookupScript(letter));
  // Backslash-canonical and trailing-separator-free, because the caller
  // compares it against paths by prefix and `\\server\share` and
  // `\\server\share\` would not match the same set.
  const unc = stdout.trim().replace(/\//gu, "\\").replace(/\\+$/u, "");
  return unc.startsWith("\\\\") ? unc : null;
}
