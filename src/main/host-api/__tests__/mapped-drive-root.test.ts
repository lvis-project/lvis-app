/**
 * The host's answer to "what UNC path backs this mapped drive".
 *
 * Every case here asserts BOTH the answer and whether the lookup ran. The
 * lookup running is what separates "we decided without asking" from "we asked
 * and got nothing", and those two are the pair this module exists to keep
 * apart — `null` for a local disk, a rejection for a lookup that could not run.
 */
import { describe, expect, it } from "vitest";
import {
  InvalidDriveLetterError,
  resolveMappedDriveRoot,
  type MappedDriveRootDeps,
} from "../mapped-drive-root.js";

/** A stub that records what it was asked, so "never ran" is assertable. */
function stubDeps(
  platform: NodeJS.Platform,
  answer: string | (() => Promise<string>),
): MappedDriveRootDeps & { scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    platform: () => platform,
    runLookup: async (script) => {
      scripts.push(script);
      return typeof answer === "string" ? answer : await answer();
    },
  };
}

describe("resolveMappedDriveRoot", () => {
  it.each(["Z", "ZZ:", "Z:\\", "", "Z:;whoami", "1:"])(
    "refuses %o without running anything",
    async (bad) => {
      const deps = stubDeps("win32", "\\\\server\\share");
      await expect(resolveMappedDriveRoot(bad, deps)).rejects.toBeInstanceOf(
        InvalidDriveLetterError,
      );
      // The control. A refusal that still ran the command would have refused
      // too late to matter.
      expect(deps.scripts).toEqual([]);
    },
  );

  it.each(["darwin", "linux"] as const)(
    "answers null on %s without running anything",
    async (platform) => {
      const deps = stubDeps(platform, "\\\\server\\share");
      await expect(resolveMappedDriveRoot("Z:", deps)).resolves.toBeNull();
      // Not "the lookup found nothing" — there was nothing to look for. Without
      // this the same `null` could have come from running PowerShell on a Mac.
      expect(deps.scripts).toEqual([]);
    },
  );

  it("returns the UNC root, backslash-canonical and without a trailing separator", async () => {
    const deps = stubDeps("win32", "  //server/share/  \n");
    await expect(resolveMappedDriveRoot("z:", deps)).resolves.toBe("\\\\server\\share");
  });

  it.each([
    ["", "an empty answer — the drive is local"],
    ["  \n", "whitespace only"],
    ["C:\\Users", "a local path rather than a UNC one"],
  ])("answers null for %o (%s)", async (stdout) => {
    const deps = stubDeps("win32", stdout);
    await expect(resolveMappedDriveRoot("Z:", deps)).resolves.toBeNull();
    // It DID ask. That is what makes this `null` mean "no UNC backing" rather
    // than "we never looked".
    expect(deps.scripts).toHaveLength(1);
  });

  it("propagates a lookup failure instead of turning it into null", async () => {
    const deps = stubDeps("win32", async () => {
      throw new Error("powershell.exe: not found");
    });
    // The whole reason the two outcomes are different types. A caller building
    // an allow-list from this would otherwise treat an unresolvable drive as a
    // local one and silently omit a root it needed.
    await expect(resolveMappedDriveRoot("Z:", deps)).rejects.toThrow(/not found/u);
  });

  it("puts the letter into the script uppercased, and nothing else of the input", async () => {
    const deps = stubDeps("win32", "\\\\server\\share");
    await resolveMappedDriveRoot("q:", deps);
    const script = deps.scripts[0]!;
    expect(script).toContain("Get-PSDrive -Name 'Q'");
    expect(script).toContain("DeviceID='Q:'");
    // The colon the caller wrote is not carried through as text; the script
    // supplies its own. A caller cannot contribute a character to the command
    // beyond the single letter above.
    expect(script).not.toContain("q");
  });
});
