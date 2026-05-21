/**
 * Round-4 — verifies the tamper-detect snapshot defeats the
 * `main.ts` env scrub.
 *
 * Threat model: a packaged binary launched with `LVIS_DEV=1` in the user
 * environment must emit a single audit-log line listing the tampered vars,
 * so operators can detect supply-chain or local-launcher tampering. The
 * `main.ts:67-73` scrub deletes those vars from `process.env` before
 * `plugin-runtime.ts` calls `shouldWarnPackagedFlagsIgnored()`. If the
 * helper read live `process.env`, the scrub would silently disable the
 * audit log.
 *
 * The fix snapshots presence at module-load time (which runs before the
 * scrub due to ESM import order). These tests verify both the snapshot
 * read and the test-only override that lets us exercise warn-true /
 * warn-false branches.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetForTest,
  _setTamperedSnapshotForTest,
  devNoSandboxAllowed,
  setIsPackaged,
  shouldWarnPackagedFlagsIgnored,
  tamperedVarsAtBoot,
} from "../dev-flags.js";

describe("dev-flags tamper snapshot", () => {
  beforeEach(() => {
    _resetForTest();
  });

  afterEach(() => {
    _resetForTest();
  });

  it("returns false for unpackaged builds even if vars were tampered", () => {
    _setTamperedSnapshotForTest(["LVIS_DEV", "LVIS_DEV_RELOAD"]);
    expect(shouldWarnPackagedFlagsIgnored(false)).toBe(false);
  });

  it("returns false for packaged builds when no vars were present at boot", () => {
    _setTamperedSnapshotForTest([]);
    expect(shouldWarnPackagedFlagsIgnored(true)).toBe(false);
    expect(tamperedVarsAtBoot()).toEqual([]);
  });

  it("returns true for packaged builds when LVIS_DEV was present at boot", () => {
    _setTamperedSnapshotForTest(["LVIS_DEV"]);
    expect(shouldWarnPackagedFlagsIgnored(true)).toBe(true);
    expect(tamperedVarsAtBoot()).toEqual(["LVIS_DEV"]);
  });

  it("survives a simulated process.env scrub (the round-4 regression)", () => {
    // Simulate the boot snapshot capturing LVIS_DEV at import time.
    _setTamperedSnapshotForTest(["LVIS_DEV", "LVIS_PLUGINS_DIR"]);

    // Simulate `main.ts`'s scrub running afterwards.
    delete process.env.LVIS_DEV;
    delete process.env.LVIS_PLUGINS_DIR;

    // Helper still reports tampered because it reads the snapshot.
    expect(shouldWarnPackagedFlagsIgnored(true)).toBe(true);
    expect(tamperedVarsAtBoot()).toEqual(["LVIS_DEV", "LVIS_PLUGINS_DIR"]);
  });

  it("lists all tampered vars for the audit log message body", () => {
    _setTamperedSnapshotForTest([
      "LVIS_DEV",
      "LVIS_DEV_RELOAD",
      "LVIS_WIN_NO_SANDBOX",
    ]);
    const names = tamperedVarsAtBoot();
    expect(names).toContain("LVIS_DEV");
    expect(names).toContain("LVIS_DEV_RELOAD");
    expect(names).toContain("LVIS_WIN_NO_SANDBOX");
    expect(names).toHaveLength(3);
  });

  it("keeps LVIS_WIN_NO_SANDBOX Windows-only and packaged-gated", () => {
    const saved = process.env.LVIS_WIN_NO_SANDBOX;
    try {
      process.env.LVIS_WIN_NO_SANDBOX = "1";
      setIsPackaged(true);
      expect(devNoSandboxAllowed(true, "win32")).toBe(false);
      setIsPackaged(false);
      expect(devNoSandboxAllowed(false, "win32")).toBe(true);
      expect(devNoSandboxAllowed(false, "darwin")).toBe(false);
      expect(devNoSandboxAllowed(false, "linux")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LVIS_WIN_NO_SANDBOX;
      else process.env.LVIS_WIN_NO_SANDBOX = saved;
    }
  });

  it("clearing the override restores the real snapshot", () => {
    // First call without override → captures whatever the real snapshot is.
    _setTamperedSnapshotForTest(null);
    const realSnapshot = tamperedVarsAtBoot();

    // Apply override → returns override.
    _setTamperedSnapshotForTest(["FAKE_OVERRIDE_VAR"]);
    expect(tamperedVarsAtBoot()).toEqual(["FAKE_OVERRIDE_VAR"]);

    // Clear override → returns real snapshot again.
    _setTamperedSnapshotForTest(null);
    expect(tamperedVarsAtBoot()).toEqual(realSnapshot);
  });
});
