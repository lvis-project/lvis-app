import { describe, expect, it } from "vitest";
import type { BootstrapStatusEvent } from "../../hooks/use-bootstrap-status.js";
import type { PluginCardSummary } from "../../types.js";
import {
  hasWindowsFileLockSignal,
  isWindowsRuntime,
  summarizeBootstrapReadiness,
  summarizePluginReadiness,
} from "../first-run-readiness.js";

function readinessPluginCard(
  id: string,
  overrides: Partial<PluginCardSummary> = {},
): PluginCardSummary {
  return {
    id,
    name: id,
    description: "",
    sampleTools: [],
    capabilities: [],
    tools: [],
    ...overrides,
  };
}

describe("first-run readiness helpers", () => {
  it("summarizes plugin load state and exposed tools", () => {
    const summary = summarizePluginReadiness([
      readinessPluginCard("loaded", {
        loadStatus: "loaded",
        tools: ["search", "read"],
      }),
      readinessPluginCard("preparing", {
        loadStatus: "preparing",
        tools: ["pending"],
      }),
      readinessPluginCard("failed", {
        loadStatus: "failed",
        tools: ["hidden"],
      }),
      readinessPluginCard("disabled", {
        loadStatus: "disabled",
        tools: ["hidden"],
      }),
      readinessPluginCard("inactive", {
        active: false,
        tools: ["hidden"],
      }),
    ]);

    expect(summary).toEqual({
      installed: 5,
      loaded: 2,
      preparing: 1,
      failed: 1,
      disabled: 1,
      activeTools: 3,
    });
  });

  it("maps bootstrap lifecycle into first-run repair levels", () => {
    const failedStatus: BootstrapStatusEvent = {
      phase: "complete",
      installed: [],
      failed: [
        { id: "one", error: "EPERM: file is locked" },
        { id: "two", error: "access is denied" },
      ],
    };

    expect(summarizeBootstrapReadiness(null)).toMatchObject({
      level: "ready",
      retryable: false,
      failedCount: 0,
    });
    expect(summarizeBootstrapReadiness({ phase: "start" })).toMatchObject({
      level: "checking",
      retryable: false,
    });
    expect(summarizeBootstrapReadiness({ phase: "error", message: "network failed" })).toMatchObject({
      level: "repair",
      retryable: true,
      failedCount: 1,
      message: "network failed",
    });
    expect(summarizeBootstrapReadiness(failedStatus)).toMatchObject({
      level: "repair",
      retryable: true,
      failedCount: 2,
    });
    expect(
      summarizeBootstrapReadiness({
        phase: "complete",
        installed: [],
        failed: [],
        skippedReason: "marketplace-url-missing",
      }),
    ).toMatchObject({
      level: "attention",
      retryable: false,
      skippedReason: "marketplace-url-missing",
    });
  });

  it("detects Windows runtime and common file-lock failure signals", () => {
    expect(isWindowsRuntime({ platform: "win32", hostname: "host", user: "ken" })).toBe(true);
    expect(isWindowsRuntime({ platform: "darwin", hostname: "host", user: "ken" })).toBe(false);
    expect(hasWindowsFileLockSignal("EPERM: operation not permitted")).toBe(true);
    expect(hasWindowsFileLockSignal("Access is denied by antivirus scanner")).toBe(true);
    expect(hasWindowsFileLockSignal("plain network timeout")).toBe(false);
  });
});
