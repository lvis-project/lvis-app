import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ReadFileTool } from "../../tools/file-tools.js";
import { assertReadableFilePath } from "../../tools/file-read-core.js";
import { validateShellCommandPathPolicy } from "../../tools/shell-path-policy.js";
import {
  buildSandboxConfig,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
} from "../asrt-sandbox.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
  getRuntimeSensitiveKeyPaths,
  isSensitivePath,
} from "../sensitive-paths.js";

describe("native host external key path protection", () => {
  let root: string;
  let keyPath: string;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "lvis-runtime-key-paths-")));
    keyPath = join(root, "payload.bin");
    // A synthetic fixture, never a user key; a generic name avoids a static deny.
    writeFileSync(keyPath, Buffer.alloc(32, 0x31), { mode: 0o600 });
    writeFileSync(join(root, "notes.txt"), "ordinary workspace document");
    vi.stubEnv("LVIS_SECRET_KEY_FILE", keyPath);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanupTmpDir(root);
  });

  function shellViolation(command: string, restrictReads: boolean): string | null {
    return validateShellCommandPathPolicy(command, root, root, [root], restrictReads, {
      dialect: "bash", environment: { HOME: homedir(), PWD: root },
    });
  }

  it.each([false, true])("blocks the real file tool and shell operands inside a grant (restrictReads=%s)", async (restrictReads) => {
    const context = {
      cwd: root, extraAllowedDirectories: [root], metadata: {},
      blockReadsOutsideWorkingDirectories: restrictReads,
    };
    const denied = await new ReadFileTool().execute({ path: "payload.bin" }, context);
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("Sensitive path:");
    expect(denied.output).not.toContain("1".repeat(32));
    expect(assertReadableFilePath(keyPath, root, [root])).toEqual({ ok: false, error: "sensitive-path" });
    expect(shellViolation("cat ./payload.bin", restrictReads)).toContain("Sensitive path:");
    expect(shellViolation("printf x > ./payload.bin", restrictReads)).toContain("Sensitive path:");

    const allowed = await new ReadFileTool().execute({ path: "notes.txt" }, context);
    expect(allowed.isError).toBe(false);
    expect(allowed.output).toContain("ordinary workspace document");
    expect(shellViolation("cat ./notes.txt", restrictReads)).toBeNull();
    expect(shellViolation("printf x > ./notes.txt", restrictReads)).toBeNull();
  });

  it("keeps the exact key in both OS deny floors despite caller read/write grants", () => {
    const config = buildSandboxConfig({
      allowedDomains: [], allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [],
    });
    expect(config.filesystem.allowRead).toContain(root);
    expect(config.filesystem.allowWrite).toContain(root);
    expect(config.filesystem.denyRead).toContain(keyPath);
    expect(config.filesystem.denyWrite).toContain(keyPath);
    expect(config.filesystem.denyRead).not.toContain(join(root, "notes.txt"));
    expect(config.filesystem.denyWrite).not.toContain(join(root, "notes.txt"));
    expect(getDefaultSensitiveReadDenyPaths()).toContain(keyPath);
    expect(getDefaultSensitiveWriteDenyPaths()).toContain(keyPath);
  });

  it("protects the process ownership namespace from replacement through granted tool paths", () => {
    vi.stubEnv("LVIS_HOME", root);
    const directory = join(root, "host-runtime");
    mkdirSync(directory);
    const lock = join(directory, "instance.sqlite");
    writeFileSync(lock, "ownership fixture");
    expect(shellViolation("rm -f ./host-runtime/instance.sqlite", false)).toContain("Sensitive path:");
    expect(shellViolation("printf x > ./host-runtime/instance.sqlite", false)).toContain("Sensitive path:");
    const config = buildSandboxConfig({ allowedDomains: [], allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] });
    expect(config.filesystem.denyWrite).toContain(directory);
    expect(config.filesystem.denyRead).toContain(directory);
  });

  it("protects canonical aliases and retains the original target after an ancestor link changes", () => {
    const current = join(root, "current");
    const original = join(root, "original");
    const replacement = join(root, "replacement");
    mkdirSync(original);
    mkdirSync(replacement);
    const target = join(original, "opaque.bin");
    writeFileSync(target, Buffer.alloc(32, 0x32), { mode: 0o600 });
    writeFileSync(join(replacement, "opaque.bin"), "ordinary replacement file");
    symlinkSync(original, current, "junction");
    const configured = join(current, "opaque.bin");
    vi.stubEnv("LVIS_SECRET_KEY_FILE", configured);
    const captured = getRuntimeSensitiveKeyPaths();
    expect(captured).toEqual([configured, target]);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(assertReadableFilePath(configured, root, [root])).toEqual({ ok: false, error: "sensitive-path" });
    symlinkSync(original, join(root, "alias"), "junction");
    expect(assertReadableFilePath(join(root, "alias", "opaque.bin"), root, [root])).toEqual({ ok: false, error: "sensitive-path" });

    unlinkSync(current);
    symlinkSync(replacement, current, "junction");
    expect(getRuntimeSensitiveKeyPaths()).toBe(captured);
    expect(assertReadableFilePath(target, root, [root])).toEqual({ ok: false, error: "sensitive-path" });
    expect(getDefaultSensitiveReadDenyPaths()).toEqual(expect.arrayContaining([configured, target]));
    expect(getDefaultSensitiveWriteDenyPaths()).toEqual(expect.arrayContaining([configured, target]));
    expect(isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(join(root, "notes.txt"))))).toBeNull();
  });

  it("leaves ordinary files and existing desktop floors unchanged without a configured key", () => {
    vi.stubEnv("LVIS_SECRET_KEY_FILE", undefined);
    expect(getRuntimeSensitiveKeyPaths()).toEqual([]);
    expect(assertReadableFilePath(keyPath, root, [root]).ok).toBe(true);
    expect(getDefaultSensitiveReadDenyPaths()).not.toContain(keyPath);
    expect(getDefaultSensitiveWriteDenyPaths()).not.toContain(keyPath);
  });

  it.each(["", "payload.bin", "../payload.bin"])("rejects invalid configured paths (%j)", (configured) => {
    vi.stubEnv("LVIS_SECRET_KEY_FILE", configured);
    expect(() => getRuntimeSensitiveKeyPaths()).toThrow("absolute file path");
    expect(() => buildSandboxConfig({ allowedDomains: [] })).toThrow("absolute file path");
  });

  it("fails closed if an explicitly configured key cannot be resolved", () => {
    vi.stubEnv("LVIS_SECRET_KEY_FILE", join(root, "missing.bin"));
    expect(() => getDefaultSensitiveReadDenyPaths()).toThrow("could not be resolved safely");
    expect(() => isSensitivePath(resolve(root, "notes.txt"))).toThrow("could not be resolved safely");
  });

  it.each(["payload*.bin", "payload?.bin", "payload[1].bin"])("refuses a key path that ASRT would interpret as a glob (%s)", (name) => {
    vi.stubEnv("LVIS_SECRET_KEY_FILE", join(root, name));
    expect(() => getDefaultSensitiveReadDenyPaths()).toThrow("sandbox glob characters");
    expect(() => isSensitivePath(keyPath)).toThrow("sandbox glob characters");
  });

  it("rejects glob syntax hidden in a resolved directory target", () => {
    const targetDir = join(root, "data[1]");
    const aliasDir = join(root, "data");
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "opaque.bin"), Buffer.alloc(32, 0x34), { mode: 0o600 });
    symlinkSync(targetDir, aliasDir, "junction");
    vi.stubEnv("LVIS_SECRET_KEY_FILE", join(aliasDir, "opaque.bin"));
    expect(() => getDefaultSensitiveReadDenyPaths()).toThrow("sandbox glob characters");
  });
});
