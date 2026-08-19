import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureLvisHomePrivate, lvisHome } from "../lvis-home.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

const originalLvisHome = process.env.LVIS_HOME;

afterEach(() => {
  if (originalLvisHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = originalLvisHome;
});

describe("lvisHome", () => {
  it("resolves a relative LVIS_HOME against the process working directory", () => {
    process.env.LVIS_HOME = join("relative-state", "..", "lvis-state");
    expect(lvisHome()).toBe(resolve("lvis-state"));
  });

  it("normalizes an absolute LVIS_HOME override", () => {
    process.env.LVIS_HOME = join(tmpdir(), "lvis-parent", "..", "lvis-state");
    expect(lvisHome()).toBe(resolve(tmpdir(), "lvis-state"));
  });
});

describe("ensureLvisHomePrivate", () => {
  const created: string[] = [];

  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), "lvis-home-privacy-"));
    created.push(dir);
    return join(dir, ".lvis");
  }

  afterEach(async () => {
    for (const dir of created.splice(0)) await cleanupTmpDir(dir);
  });

  it("creates the home directory with owner-only POSIX permissions", () => {
    const dir = home();
    const result = ensureLvisHomePrivate(dir, {
      platform: "darwin",
      run: () => { throw new Error("no command may run off Win32"); },
    });

    expect(result).toEqual({ enforcement: "posix-mode", home: dir });
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it("hands Windows an inheritable owner-only DACL, because mode buys nothing there", () => {
    const dir = home();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const result = ensureLvisHomePrivate(dir, {
      platform: "win32",
      run: (file, args) => {
        calls.push({ file, args });
        return file === "whoami" ? '"CORP\\\\ikcha","S-1-5-21-1004336348-11-77-1417"\r\n' : "";
      },
    });

    expect(result).toEqual({
      enforcement: "win32-dacl",
      home: dir,
      sid: "S-1-5-21-1004336348-11-77-1417",
    });
    expect(calls[1]).toEqual({
      file: "icacls",
      args: [
        dir,
        // Inherited ACEs go first: outside %USERPROFILE% they are what would
        // grant other accounts. (OI)(CI) makes the single remaining ACE the
        // one every settings/audit/secret file underneath is created with.
        "/inheritance:r",
        "/grant:r",
        "*S-1-5-21-1004336348-11-77-1417:(OI)(CI)F",
        "/q",
      ],
    });
  });

  it("reports a Windows account whose SID could not be read rather than claiming protection", () => {
    const dir = home();
    const result = ensureLvisHomePrivate(dir, {
      platform: "win32",
      run: () => "ERROR: Access is denied.\r\n",
    });

    expect(result).toMatchObject({ enforcement: "none", home: dir });
    expect((result as { reason: string }).reason).toContain("SID");
  });

  // Only a real Windows kernel can say whether the DACL took: the argv test
  // above proves what is asked for, this proves what NTFS actually stored.
  // Runs on the `windows-permission-tests` CI job.
  it.runIf(process.platform === "win32")(
    "leaves the real directory readable to this account and to nobody else",
    () => {
      const dir = home();
      const applied = ensureLvisHomePrivate(dir);
      expect(applied.enforcement).toBe("win32-dacl");

      const acl = execFileSync("icacls", [dir], { encoding: "utf-8" });
      const aces = acl
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line.includes(":("));
      expect(aces.length).toBeGreaterThan(0);
      // No ACE may name anyone but this account, and none may be inherited.
      const sid = (applied as { sid: string }).sid;
      const owner = execFileSync("whoami", [], { encoding: "utf-8" }).trim();
      for (const ace of aces) {
        expect(ace).not.toContain("(I)");
        const account = ace.slice(0, ace.indexOf(":("));
        expect([sid, owner].some((known) => account.toLowerCase() === known.toLowerCase())).toBe(true);
      }
      // And the app can still use it.
      writeFileSync(join(dir, "settings.json"), "{}");
      expect(readFileSync(join(dir, "settings.json"), "utf-8")).toBe("{}");
    },
  );
});
