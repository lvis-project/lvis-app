import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), existsSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("../main-paths.js", () => ({ projectRoot: "/trusted/app" }));
import { resolveWindowsJobLauncher, spawnWindowsJobProcess } from "../windows-job-launcher.js";

describe("Windows job launcher", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.spawn.mockReset();
    mocks.existsSync.mockReset().mockReturnValue(true);
    vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64", resourcesPath: "/trusted/resources", defaultApp: false });
  });
  it("resolves only the packaged asset when packaged", () => {
    expect(resolveWindowsJobLauncher()).toBe(join("/trusted/resources", "windows-job", "x64", "lvis-job.exe"));
  });
  it("resolves development assets from the app root", () => {
    vi.stubGlobal("process", { ...process, defaultApp: true });
    expect(resolveWindowsJobLauncher()).toBe(join("/trusted/app", "resources", "windows-job", "x64", "lvis-job.exe"));
  });
  it("fails clearly without a native asset and never launches the command directly", () => {
    mocks.existsSync.mockReturnValue(false);
    expect(() => spawnWindowsJobProcess("C:\\bin\\bash.exe", ["-c", "echo hi"], { cwd: "C:\\work", env: {} })).toThrow("launcher is missing");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("rejects PATH lookup and preserves args, environment, cwd, and private lifetime pipe", () => {
    expect(() => spawnWindowsJobProcess("bash", [], { cwd: "C:\\work", env: {} })).toThrow("absolute executable path");
    const args = ["-c", 'printf "%s" "space value"'];
    const env = { PATH: "safe" };
    spawnWindowsJobProcess("C:\\Program Files\\Git\\bin\\bash.exe", args, { cwd: "C:\\work", env });
    expect(mocks.spawn).toHaveBeenCalledWith(join("/trusted/resources", "windows-job", "x64", "lvis-job.exe"), ["C:\\Program Files\\Git\\bin\\bash.exe", ...args], {
      cwd: "C:\\work", env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
  });
});
