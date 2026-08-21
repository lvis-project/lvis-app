/**
 * What the boot sandbox gate tells the person using the app.
 *
 * The runtime capability SOT cannot answer this. A gate that degrades never
 * publishes a capability, so `detectSandboxCapability()` returns the same
 * kind:"none" / "no OS sandbox configured" it returns when the sandbox was
 * never turned on. Those are different facts — one is a setting the user chose,
 * the other is a setting the user chose that did not take effect — and before
 * this snapshot existed the difference lived only in the boot log, which a
 * packaged app's user cannot read.
 *
 * So each case below asserts BOTH halves: that the runtime SOT is still
 * indistinguishable, and that the boot outcome distinguishes it anyway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "../context.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const h = vi.hoisted(() => ({
  initialize: vi.fn(),
  checkDeps: vi.fn(),
  isProbeError: vi.fn(),
  logGate: vi.fn(),
  flush: vi.fn(async () => undefined),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/lvis-sandbox-outcome-test") },
}));

vi.mock("../../lib/logger.js", () => ({
  createLogger: vi.fn(() => h.logger),
}));

vi.mock("../../permissions/asrt-sandbox.js", () => ({
  initializeAsrtSandbox: h.initialize,
  checkAsrtDependencies: h.checkDeps,
  isAsrtLinuxRuntimeProbeError: h.isProbeError,
}));

import { initSandboxGate } from "../steps/sandbox-init.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxBootOutcomeForTest,
  __resetSandboxRequestedAtBootForTest,
  detectSandboxCapability,
  getSandboxBootOutcome,
} from "../../permissions/sandbox-capability.js";

const ORIGINAL_PLATFORM = process.platform;

function makeContext(settingOn: boolean): BootContext {
  return {
    settingsService: {
      get: vi.fn((key: string) =>
        key === "features" ? { osToolSandbox: settingOn, hostClassifiesRisk: false } : undefined,
      ),
    },
    bootAuditLogger: { logSandboxGate: h.logGate, flush: h.flush },
    pluginRuntime: {
      listPluginIds: vi.fn(() => []),
      getPluginManifest: vi.fn(() => undefined),
    },
    buildSandboxUnionDomains: vi.fn(async () => []),
  } as unknown as BootContext;
}

beforeEach(() => {
  setProcessPlatform("linux");
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  h.initialize.mockReset();
  h.checkDeps.mockReset();
  h.isProbeError.mockReset();
  h.logGate.mockReset();
  h.flush.mockClear();
  h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
  h.isProbeError.mockReturnValue(false);
  vi.stubEnv("LVIS_SANDBOX_ENABLED", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetSandboxBootOutcomeForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("boot sandbox outcome", () => {
  it("is null before the gate has run, which is not the same as off", () => {
    expect(getSandboxBootOutcome()).toBeNull();
  });

  it("records the Windows degrade with the dependency errors that name the fix", async () => {
    setProcessPlatform("win32");
    const depError =
      "Sandbox user is not provisioned (user=true, cred=false). Windows sandbox needs a one-time install";
    h.checkDeps.mockResolvedValue({ errors: [depError], warnings: [] });

    await expect(initSandboxGate(makeContext(true))).resolves.toBeUndefined();

    // The half the runtime SOT gets wrong: identical to a sandbox never enabled.
    expect(detectSandboxCapability()).toMatchObject({ kind: "none" });

    expect(getSandboxBootOutcome()).toEqual({
      action: "degrade",
      reason: "degrade-windows-not-installed",
      onSignal: "default-settings",
      dependencyErrors: [depError],
    });
  });

  it("records the gate-off skip distinctly from a failed activation", async () => {
    await expect(initSandboxGate(makeContext(false))).resolves.toBeUndefined();

    expect(getSandboxBootOutcome()).toEqual({
      action: "skip",
      reason: "gate-off",
      onSignal: "off",
      dependencyErrors: [],
    });
  });

  it("records the explicit-env abort before boot rejects", async () => {
    h.checkDeps.mockResolvedValue({ errors: ["missing bwrap"], warnings: [] });
    vi.stubEnv("LVIS_SANDBOX_ENABLED", "1");

    await expect(initSandboxGate(makeContext(false))).rejects.toThrow(/dependencies are missing/);

    expect(getSandboxBootOutcome()).toMatchObject({
      action: "abort",
      onSignal: "explicit-env",
      dependencyErrors: ["missing bwrap"],
    });
  });

  it("carries the init-failure cause through the degrade so the surface can show it", async () => {
    h.initialize.mockRejectedValue(new Error("wrapper refused to start"));

    await expect(initSandboxGate(makeContext(true))).resolves.toBeUndefined();

    expect(getSandboxBootOutcome()).toMatchObject({
      action: "degrade",
      dependencyErrors: ["wrapper refused to start"],
    });
  });

  it("reports the same action and reason to the audit log and to the surface", async () => {
    setProcessPlatform("win32");
    h.checkDeps.mockResolvedValue({ errors: ["not installed"], warnings: [] });

    await initSandboxGate(makeContext(true));

    // One report, two consumers. A branch that told the log one thing and the
    // user another would be worse than one that told the user nothing.
    const calls = h.logGate.mock.calls;
    const audited = calls[calls.length - 1]?.[0] as {
      outcome: string;
      reason: string;
      onSignal: string;
    };
    const surfaced = getSandboxBootOutcome();
    expect(surfaced).not.toBeNull();
    expect(audited.outcome).toBe(surfaced?.action);
    expect(audited.reason).toBe(surfaced?.reason);
    expect(audited.onSignal).toBe(surfaced?.onSignal);
  });

  it("does not let a caller mutate the sealed outcome", async () => {
    await initSandboxGate(makeContext(false));

    const outcome = getSandboxBootOutcome();
    expect(outcome).not.toBeNull();
    expect(() => {
      (outcome as unknown as { action: string }).action = "activate";
    }).toThrow();
    expect(getSandboxBootOutcome()?.action).toBe("skip");
  });
});
