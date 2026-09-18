import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetForTest, getIsPackaged } from "../boot/dev-flags.js";
import { headlessPackagedMarkerPath } from "../../scripts/lib/headless-packaged-marker.mjs";

const savedEnv = { ...process.env };
const savedArgv = [...process.argv];
const savedExitCode = process.exitCode;
let root: string | undefined;

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  process.argv.splice(0, process.argv.length, ...savedArgv);
  process.exitCode = savedExitCode;
  _resetForTest();
  vi.resetModules();
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function selectHeadlessCommand(...args: string[]): void {
  process.argv.splice(0, process.argv.length, process.execPath, "headless.js", ...args);
}

function captureOutput(stream: NodeJS.WriteStream): { output: () => string } {
  let output = "";
  vi.spyOn(stream, "write").mockImplementation(((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof stream.write);
  return { output: () => output };
}

describe("headless direct entry", () => {
  it("normalizes hostile packaged env before the host module imports", async () => {
    root = mkdtempSync(join(tmpdir(), "lvis-headless-entry-"));
    writeFileSync(headlessPackagedMarkerPath(root), new Uint8Array());
    process.env.NODE_ENV = "test";
    process.env.VITEST = "1";
    process.env.LVIS_DEV = "1";
    process.env.LVIS_WHITELIST_OFFLINE = "1";

    const observed: NodeJS.ProcessEnv[] = [];
    vi.doMock("../main/main-paths.js", () => ({ projectRoot: root }));
    vi.doMock("../headless-host.js", () => {
      observed.push({ ...process.env });
      return {};
    });

    await import("../headless.js");

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ NODE_ENV: "production" });
    expect(observed[0]?.VITEST).toBeUndefined();
    expect(observed[0]?.LVIS_DEV).toBeUndefined();
    expect(observed[0]?.LVIS_WHITELIST_OFFLINE).toBeUndefined();
    expect(getIsPackaged()).toBe(true);
  });

  it("fails a bare permission-audit proof flag without importing the ordinary host", async () => {
    root = mkdtempSync(join(tmpdir(), "lvis-headless-entry-"));
    selectHeadlessCommand("--verify-permission-audit");
    const hostImports: string[] = [];
    const stderr = captureOutput(process.stderr);
    vi.doMock("../main/main-paths.js", () => ({ projectRoot: root }));
    vi.doMock("../headless-host.js", () => {
      hostImports.push("imported");
      return {};
    });

    await import("../headless.js");

    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toBe("headless: permission-audit-proof:invalid-arguments\n");
    expect(hostImports).toEqual([]);
  });

  it("hides filesystem paths when permission-audit verification fails", async () => {
    root = mkdtempSync(join(tmpdir(), "lvis-headless-entry-secret-"));
    const missingKey = join(root, "private", "missing.key");
    process.env.LVIS_HOME = root;
    process.env.LVIS_SECRET_KEY_FILE = missingKey;
    selectHeadlessCommand(`--verify-permission-audit=${"c".repeat(64)}`);
    const hostImports: string[] = [];
    const stdout = captureOutput(process.stdout);
    const stderr = captureOutput(process.stderr);
    vi.doMock("../main/main-paths.js", () => ({ projectRoot: root }));
    vi.doMock("../headless-host.js", () => {
      hostImports.push("imported");
      return {};
    });

    await import("../headless.js");

    expect(process.exitCode).toBe(1);
    expect(stdout.output()).toBe("");
    expect(stderr.output()).toBe("headless: permission-audit-proof:verification-failed\n");
    expect(stderr.output()).not.toContain(root);
    expect(stderr.output()).not.toContain(missingKey);
    expect(hostImports).toEqual([]);
  });

  it("keeps packaged-identity failures inside the public proof error boundary", async () => {
    root = mkdtempSync(join(tmpdir(), "lvis-headless-entry-marker-"));
    const invalidMarker = headlessPackagedMarkerPath(root);
    mkdirSync(invalidMarker);
    selectHeadlessCommand(`--verify-permission-audit=${"d".repeat(64)}`);
    const hostImports: string[] = [];
    const stdout = captureOutput(process.stdout);
    const stderr = captureOutput(process.stderr);
    vi.doMock("../main/main-paths.js", () => ({ projectRoot: root }));
    vi.doMock("../headless-host.js", () => {
      hostImports.push("imported");
      return {};
    });

    await import("../headless.js");

    expect(process.exitCode).toBe(1);
    expect(stdout.output()).toBe("");
    expect(stderr.output()).toBe("headless: permission-audit-proof:verification-failed\n");
    expect(stderr.output()).not.toContain(root);
    expect(stderr.output()).not.toContain(invalidMarker);
    expect(hostImports).toEqual([]);
  });
});
