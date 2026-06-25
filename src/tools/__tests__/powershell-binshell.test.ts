/**
 * PR2 finding c — pwsh 7 binShell threading.
 *
 * `resolvePowerShellExecutable()` must prefer PowerShell 7 (`pwsh.exe`) on
 * win32 when it is on PATH, falling back to Windows PowerShell 5.1
 * (`powershell.exe`). The sandbox spawn path derives ASRT's `binShell` token
 * from that resolved flavor via `binShellForExecutable`, so the sandboxed inner
 * shell equals the unsandboxed one (no silent 7→5.1 downgrade under the sandbox).
 *
 * These tests exercise the pure resolver + token mapper. The actual ASRT spawn
 * (`wrapToolCommand`) is not invoked — the binShell wiring inside
 * spawnPowerShellWithSandbox simply reads `binShellForExecutable(executable)`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

import {
  resolvePowerShellExecutable,
  binShellForExecutable,
} from "../powershell.js";
import { setProcessPlatform } from "../../testing/process-platform.js";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_PATH = process.env["PATH"];
const ORIGINAL_PATHEXT = process.env["PATHEXT"];

afterEach(() => {
  setProcessPlatform(ORIGINAL_PLATFORM);
  if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
  else process.env["PATH"] = ORIGINAL_PATH;
  if (ORIGINAL_PATHEXT === undefined) delete process.env["PATHEXT"];
  else process.env["PATHEXT"] = ORIGINAL_PATHEXT;
  vi.restoreAllMocks();
});

describe("binShellForExecutable", () => {
  it("maps pwsh.exe / pwsh → 'pwsh'", () => {
    expect(binShellForExecutable("pwsh.exe")).toBe("pwsh");
    expect(binShellForExecutable("pwsh")).toBe("pwsh");
    expect(binShellForExecutable("PWSH.EXE")).toBe("pwsh");
  });

  it("maps powershell.exe / powershell → 'powershell'", () => {
    expect(binShellForExecutable("powershell.exe")).toBe("powershell");
    expect(binShellForExecutable("powershell")).toBe("powershell");
    expect(binShellForExecutable("POWERSHELL.EXE")).toBe("powershell");
  });
});

describe("resolvePowerShellExecutable off-win32", () => {
  it("returns pwsh on darwin/linux regardless of PATH", () => {
    setProcessPlatform("darwin");
    process.env["PATH"] = "/usr/bin";
    expect(resolvePowerShellExecutable()).toBe("pwsh");
    setProcessPlatform("linux");
    expect(resolvePowerShellExecutable()).toBe("pwsh");
  });
});

describe("resolvePowerShellExecutable on win32", () => {
  it("prefers pwsh.exe when it is on PATH (sandboxed flavor == unsandboxed)", () => {
    setProcessPlatform("win32");
    const dir = mkdtempSync(join(tmpdir(), "lvis-pwsh-"));
    const pwshPath = join(dir, "pwsh.exe");
    writeFileSync(pwshPath, "");
    chmodSync(pwshPath, 0o755);
    process.env["PATH"] = dir;
    process.env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";

    const resolved = resolvePowerShellExecutable();
    expect(resolved).toBe("pwsh.exe");
    // The sandbox path would hand ASRT 'pwsh', matching the resolved binary.
    expect(binShellForExecutable(resolved)).toBe("pwsh");
  });

  it("falls back to powershell.exe when pwsh.exe is absent from PATH", () => {
    setProcessPlatform("win32");
    // A directory with no pwsh.exe in it.
    const dir = mkdtempSync(join(tmpdir(), "lvis-nopwsh-"));
    process.env["PATH"] = dir;
    process.env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";

    const resolved = resolvePowerShellExecutable();
    expect(resolved).toBe("powershell.exe");
    expect(binShellForExecutable(resolved)).toBe("powershell");
  });

  it("finds pwsh via a bare PATHEXT suffix entry (pwsh + .EXE)", () => {
    setProcessPlatform("win32");
    const dir = mkdtempSync(join(tmpdir(), "lvis-pwshext-"));
    // Only the suffix-appended form exists; the bare 'pwsh.exe' literal probe
    // and the PATHEXT loop both look at the same path here, but assert the
    // suffix branch resolves when PATH lists a directory containing pwsh.exe.
    writeFileSync(join(dir, "pwsh.exe"), "");
    process.env["PATH"] = ["/nonexistent", dir].join(delimiter);
    process.env["PATHEXT"] = ".EXE";

    expect(resolvePowerShellExecutable()).toBe("pwsh.exe");
  });

  it("returns powershell.exe when PATH is empty", () => {
    setProcessPlatform("win32");
    process.env["PATH"] = "";
    expect(resolvePowerShellExecutable()).toBe("powershell.exe");
  });
});
