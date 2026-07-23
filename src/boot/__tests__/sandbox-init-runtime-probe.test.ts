/**
 * Linux ASRT runtime-probe boot mapping.
 *
 * The adapter emits a typed failure only after the configured wrapper actually
 * fails. Boot must preserve the requested-at-boot signal, never publish a
 * verified capability, and choose the existing default-degrade vs explicit-
 * environment-abort policy without exposing wrapper diagnostics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "../context.js";
import { setProcessPlatform } from "../../testing/process-platform.js";

const h = vi.hoisted(() => ({
  initialize: vi.fn(),
  checkDeps: vi.fn(),
  isProbeError: vi.fn(),
  logGate: vi.fn(),
  flush: vi.fn(async () => undefined),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/lvis-sandbox-init-test") },
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
  __resetSandboxRequestedAtBootForTest,
  detectSandboxCapability,
  getHostShellExecutionPlan,
  isSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";

const ORIGINAL_PLATFORM = process.platform;

function makeContext(settingOn: boolean): BootContext {
  return {
    settingsService: {
      get: vi.fn((key: string) =>
        key === "features"
          ? { osToolSandbox: settingOn, hostClassifiesRisk: false }
          : undefined,
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
  h.initialize.mockReset();
  h.checkDeps.mockReset();
  h.isProbeError.mockReset();
  h.logGate.mockReset();
  h.flush.mockClear();
  h.checkDeps.mockResolvedValue({ errors: [], warnings: [] });
  vi.stubEnv("LVIS_SANDBOX_ENABLED", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.clearAllMocks();
});

describe("initSandboxGate — Linux ASRT runtime probe failures", () => {
  it("degrades the default/settings path without publishing a verified capability", async () => {
    const probeError = new Error("configured wrapper denied");
    h.initialize.mockRejectedValue(probeError);
    h.isProbeError.mockImplementation((error: unknown) => error === probeError);

    await expect(initSandboxGate(makeContext(true))).resolves.toBeUndefined();

    expect(h.logGate).toHaveBeenCalledWith({
      platform: "linux",
      onSignal: "default-settings",
      outcome: "degrade",
      reason: "degrade-linux-runtime-probe-failed",
    });
    expect(detectSandboxCapability()).toMatchObject({ kind: "none", platform: "linux" });
    expect(isSandboxRequestedAtBoot()).toBe(true);
    expect(getHostShellExecutionPlan()).toMatchObject({
      requestedSandbox: true,
      mode: "plain",
      fallbackReason: "requested-sandbox-unavailable",
      requiresExplicitUserApproval: true,
      capability: { kind: "none" },
    });
  });

  it("audits and rethrows the typed probe failure for explicit Linux opt-in", async () => {
    const probeError = new Error("configured wrapper denied");
    h.initialize.mockRejectedValue(probeError);
    h.isProbeError.mockImplementation((error: unknown) => error === probeError);
    vi.stubEnv("LVIS_SANDBOX_ENABLED", "1");

    await expect(initSandboxGate(makeContext(false))).rejects.toBe(probeError);

    expect(h.logGate).toHaveBeenCalledWith({
      platform: "linux",
      onSignal: "explicit-env",
      outcome: "abort",
      reason: "abort-linux-runtime-probe-failed",
    });
    expect(h.flush).toHaveBeenCalledOnce();
    expect(h.logGate.mock.invocationCallOrder[0]).toBeLessThan(
      h.flush.mock.invocationCallOrder[0],
    );
    expect(detectSandboxCapability()).toMatchObject({ kind: "none", platform: "linux" });
    expect(isSandboxRequestedAtBoot()).toBe(true);
  });

  it("drains the dependency-abort audit before rejecting explicit opt-in", async () => {
    h.checkDeps.mockResolvedValue({ errors: ["missing bwrap"], warnings: [] });
    vi.stubEnv("LVIS_SANDBOX_ENABLED", "1");

    await expect(initSandboxGate(makeContext(false))).rejects.toThrow(
      /dependencies are missing/,
    );

    expect(h.logGate).toHaveBeenCalledWith({
      platform: "linux",
      onSignal: "explicit-env",
      outcome: "abort",
      reason: expect.stringContaining("abort"),
    });
    expect(h.flush).toHaveBeenCalledOnce();
    expect(h.logGate.mock.invocationCallOrder[0]).toBeLessThan(
      h.flush.mock.invocationCallOrder[0],
    );
  });
});
