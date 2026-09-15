import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { getBuiltinShellSessionReadPolicy, getDefaultSensitiveReadDenyPaths, wrapToolCommand } from "../../permissions/asrt-sandbox.js";
import { __resetActiveSandboxCapabilityForTest, setActiveSandboxCapability } from "../../permissions/sandbox-capability.js";
import { getConfiguredSessionReadPolicy } from "../../permissions/sensitive-paths.js";
import { sessionStorePath } from "../../shared/session-store-path.js";
import { PowerShellTool, spawnWithSandbox } from "../shell-tools.js";
import { prepareSandboxFixture } from "./support/prepared-shell.js";

vi.mock("../../permissions/asrt-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/asrt-sandbox.js")>(),
  // Stop at the wrapper boundary: this suite proves wiring, not OS isolation.
  wrapToolCommand: vi.fn(async () => { throw new Error("fixture wrapper boundary"); }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...await importOriginal<typeof import("node:child_process")>(),
    spawn: vi.fn((executable: string) => {
      if (executable !== "pwsh") throw new Error("Unexpected fixture subprocess");
      const parser = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      parser.stdin.on("finish", () => {
        parser.stdout.end(Buffer.from(JSON.stringify({
          errors: [], redirections: [], unsupported: [],
          commands: [{ name: "Write-Output", text: "Write-Output fixture", arguments: [
            { kind: "literal", value: "Write-Output", text: "Write-Output" },
            { kind: "literal", value: "fixture", text: "fixture" },
          ] }],
        })));
        parser.emit("close", 0);
      });
      return parser;
    }),
  };
});

let root: string;
let cwd: string;
let profile: string;
let sessions: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "session-shell-wiring-")));
  cwd = join(root, "workspace");
  profile = join(root, "configured-profile");
  sessions = sessionStorePath(profile);
  mkdirSync(cwd); mkdirSync(sessions, { recursive: true });
  vi.stubEnv("HOME", root);
  vi.stubEnv("LVIS_HOME", profile);
  setActiveSandboxCapability({
    kind: "asrt", confidence: "verified", platform: process.platform,
    reason: "Controlled wrapper fixture",
    confines: { filesystem: true, process: true, network: true },
  });
  vi.clearAllMocks();
});
afterEach(async () => {
  __resetActiveSandboxCapabilityForTest();
  vi.unstubAllEnvs();
  await cleanupTmpDir(root);
});

async function invoke(dialect: "bash" | "powershell", extraAllowedDirectories: readonly string[] = []) {
  if (dialect === "bash") {
    const command = "printf fixture";
    return spawnWithSandbox(command, cwd, [cwd, ...extraAllowedDirectories], 5, prepareSandboxFixture(command, cwd));
  }
  return new PowerShellTool().execute({ command: "Write-Output fixture", timeoutSeconds: 5 }, {
    cwd, extraAllowedDirectories, blockReadsOutsideWorkingDirectories: true, metadata: {},
  });
}

describe.skipIf(process.platform === "win32")("saved-session native shell policy wiring", () => {
  it.each(["bash", "powershell"] as const)("%s keeps ancestor write scope without conflicting with the HOME read deny", async (dialect) => {
    const ancestor = dirname(root);
    const alias = join(root, "ancestor-link");
    symlinkSync(ancestor, alias);
    await invoke(dialect, [ancestor, alias]);
    const filesystem = vi.mocked(wrapToolCommand).mock.calls[0]![1]!.filesystem!;
    expect(filesystem.allowWrite).toContain(ancestor);
    expect(filesystem.allowRead).not.toContain(ancestor);
    expect(filesystem.allowRead).not.toContain(alias);
    expect(filesystem.allowRead).toContain(cwd);
    expect(filesystem.allowRead).toContain(sessions);
    expect(filesystem.denyRead).toContain(root);
    expect(filesystem.denyWrite).toContain(sessions);
  });

  it.each(["bash", "powershell"] as const)("%s pairs the configured read grant with nested exclusions and write protection", async (dialect) => {
    const result = await invoke(dialect);
    expect(result.output).toContain("fixture wrapper boundary");
    expect(wrapToolCommand).toHaveBeenCalledTimes(1);
    const filesystem = vi.mocked(wrapToolCommand).mock.calls[0]![1]!.filesystem!;
    expect(filesystem.allowRead).toContain(sessions);
    expect(filesystem.allowRead).not.toContain(profile);
    expect(filesystem.allowWrite).not.toContain(sessions);
    expect(filesystem.denyWrite).toContain(sessions);
    expect(filesystem.denyRead).not.toContain(sessions);
    expect(getDefaultSensitiveReadDenyPaths()).toContain(sessions);
    expect(filesystem.denyRead).toEqual(expect.arrayContaining([
      root, join(profile, "secrets"), join(profile, "audit"), join(profile, "routine"),
      `${sessions}/**/.ssh`, `${sessions}/**/.env`,
    ]));
    const policy = getBuiltinShellSessionReadPolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowRead)).toBe(true);
    expect(Object.isFrozen(policy.denyRead)).toBe(true);
    expect(filesystem.denyRead).toEqual(expect.arrayContaining([...policy.denyRead]));
    const sandboxHome = filesystem.allowWrite?.find((path) => path.includes("lvis-sandbox-home-"));
    expect(sandboxHome).toBeDefined();
    expect(existsSync(sandboxHome!)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(dialect === "powershell" ? 1 : 0);
  });

  it.each(["bash", "powershell"] as const)("%s grants nothing when the sessions directory escapes through a link", async (dialect) => {
    const outside = join(root, "ungranted"); mkdirSync(outside);
    rmdirSync(sessions); symlinkSync(outside, sessions);
    expect(getConfiguredSessionReadPolicy()).toEqual({ allowRead: [], denyRead: [] });
    const result = await invoke(dialect);
    expect(result.output).toContain("fixture wrapper boundary");
    const filesystem = vi.mocked(wrapToolCommand).mock.calls[0]![1]!.filesystem!;
    expect(filesystem.allowRead).not.toContain(sessions);
    expect(filesystem.allowRead).not.toContain(outside);
    expect(filesystem.allowRead).not.toContain(profile);
    expect(filesystem.denyWrite).toContain(sessions);
  });

  it("keeps a protected alias of the session root outside the builtin exception", () => {
    const protectedAlias = join(profile, "certs");
    symlinkSync(sessions, protectedAlias);
    const policy = getBuiltinShellSessionReadPolicy();
    expect(policy.allowRead).toEqual([]);
    expect(policy.denyRead).toContain(sessions);
    expect(policy.denyRead).toContain(protectedAlias);
  });

  it("preserves both runtime-key spellings while granting ordinary saved-history reads", () => {
    const key = join(sessions, "key-material"); writeFileSync(key, "synthetic-key-fixture");
    const alias = join(root, "runtime-key"); symlinkSync(key, alias);
    vi.stubEnv("LVIS_SECRET_KEY_FILE", alias);
    const policy = getBuiltinShellSessionReadPolicy();
    expect(policy.allowRead).toContain(sessions);
    expect(policy.denyRead).toEqual(expect.arrayContaining([key, alias]));
  });
});
