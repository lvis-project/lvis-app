/**
 * Reviewer wrapped-registry for host-spawned PLUGIN WORKERS (worker-confinement
 * PR D-1).
 *
 * Mirrors the MCP wrapped-registry no-leak invariant for the OTHER long-lived
 * worker substrate: a `source === 'plugin'` tool whose side-effects run in a
 * host-spawned, ASRT-wrapped plugin worker ({@link spawnWorker}). The `asrt`
 * reviewer relaxation must apply ONLY to a worker GENUINELY wrapped in THIS
 * process — gate ON + the worker id in the registry. An unwrapped worker (gate
 * off, never spawned, win32 legacy path, or after the worker exits / the
 * sandbox is torn down) must stay `none` so the reviewer cannot relax a
 * MEDIUM/HIGH verdict to LOW for an UNSANDBOXED plugin effect.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedPluginWorkersForTest,
  isWeakSandbox,
  markPluginWorkerWrapped,
  unmarkPluginWorkerWrapped,
  clearWrappedPluginWorkers,
  isPluginWorkerWrapped,
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
} from "../sandbox-capability.js";

afterEach(() => {
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedPluginWorkersForTest();
});

describe("resolveReviewerSandboxCapability — plugin-worker substrate awareness", () => {
  it("reports genuine asrt for a plugin tool ONLY when its worker is marked wrapped (gate ON)", () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });
    markPluginWorkerWrapped("embed");

    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed");
    expect(cap.kind).toBe("asrt");
    expect(isWeakSandbox(cap)).toBe(false); // wrapped → reviewer may relax
    expect(cap.reason).toContain("plugin worker 'embed' ASRT-wrapped");
  });

  it("forces none for a plugin tool whose worker is NOT in the registry, even when the global cap is asrt", () => {
    // Gate ON: process-global cap is asrt…
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active",
      confines: { filesystem: true, process: true, network: true },
    });
    // …but THIS worker was never wrapped (no host-spawned worker / win32 legacy).
    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "other-worker");
    expect(cap.kind).toBe("none");
    expect(isWeakSandbox(cap)).toBe(true);
  });

  it("forces none when no workerId is threaded (the historical plugin default is unchanged)", () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    markPluginWorkerWrapped("embed");
    // workerId omitted → resolves to none (every pre-existing plugin call site).
    const cap = resolveReviewerSandboxCapability("plugin", "index_search");
    expect(cap.kind).toBe("none");
  });

  it("forces none after the worker is unmarked (exit/stop clears the registry)", () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    markPluginWorkerWrapped("embed");
    expect(resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed").kind).toBe("asrt");

    unmarkPluginWorkerWrapped("embed");
    expect(isPluginWorkerWrapped("embed")).toBe(false);
    expect(resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed").kind).toBe("none");
  });

  it("forces none after the sandbox is torn down (active cap cleared) even if the marker lingers", () => {
    // Marker present but the active capability is gone (resetAsrtSandbox cleared
    // it). The resolver re-checks detectSandboxCapability → none (no stale asrt).
    markPluginWorkerWrapped("embed");
    __resetActiveSandboxCapabilityForTest(); // simulate sandbox torn down
    const cap = resolveReviewerSandboxCapability("plugin", "index_search", undefined, "embed");
    expect(cap.kind).toBe("none");
  });

  it("clearWrappedPluginWorkers drops every marker (teardown no-leak)", () => {
    markPluginWorkerWrapped("a");
    markPluginWorkerWrapped("b");
    clearWrappedPluginWorkers();
    expect(isPluginWorkerWrapped("a")).toBe(false);
    expect(isPluginWorkerWrapped("b")).toBe(false);
  });
});
