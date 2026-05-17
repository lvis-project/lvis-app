/**
 * #893 — Wildcard configOverrides slot tests for PluginRuntime.
 *
 * Verifies that `setWildcardConfigOverride` merges (does not clobber) and
 * `clearWildcardConfigOverride` removes only the named keys, leaving the
 * slot intact for unrelated injectors (e.g. boot's `pythonExecutable`).
 */
import { describe, it, expect } from "vitest";
import { PluginRuntime } from "../runtime.js";

describe("PluginRuntime wildcard configOverrides (#893)", () => {
  function makeRuntime(initial: Record<string, Record<string, unknown>> = {}) {
    return new PluginRuntime({
      hostRoot: process.cwd(),
      configOverrides: initial,
    });
  }

  it("merges new keys into the existing wildcard slot", () => {
    const rt = makeRuntime({ "*": { pythonExecutable: "/usr/bin/python3" } });
    rt.setWildcardConfigOverride({
      hostApiKey: "sk-test",
      hostApiVendor: "openai",
    });
    // Access the internal map via the cast — production callers route via the
    // plugin runtime context, but unit tests verify the in-memory map directly.
    const slot = (rt as unknown as { configOverrides: Record<string, Record<string, unknown>> })
      .configOverrides["*"];
    expect(slot).toEqual({
      pythonExecutable: "/usr/bin/python3",
      hostApiKey: "sk-test",
      hostApiVendor: "openai",
    });
  });

  it("clears only the named keys from the wildcard slot", () => {
    const rt = makeRuntime({
      "*": {
        pythonExecutable: "/usr/bin/python3",
        hostApiKey: "sk-stale",
        hostApiVendor: "openai",
      },
    });
    rt.clearWildcardConfigOverride(["hostApiKey", "hostApiVendor"]);
    const slot = (rt as unknown as { configOverrides: Record<string, Record<string, unknown>> })
      .configOverrides["*"];
    expect(slot).toEqual({ pythonExecutable: "/usr/bin/python3" });
  });

  it("removes the wildcard slot entirely when the last key is cleared", () => {
    const rt = makeRuntime({ "*": { hostApiKey: "sk-test" } });
    rt.clearWildcardConfigOverride(["hostApiKey"]);
    const overrides = (rt as unknown as { configOverrides: Record<string, Record<string, unknown>> })
      .configOverrides;
    expect(overrides["*"]).toBeUndefined();
  });

  it("is a no-op when given an empty patch", () => {
    const rt = makeRuntime({ "*": { pythonExecutable: "/usr/bin/python3" } });
    rt.setWildcardConfigOverride({});
    const slot = (rt as unknown as { configOverrides: Record<string, Record<string, unknown>> })
      .configOverrides["*"];
    expect(slot).toEqual({ pythonExecutable: "/usr/bin/python3" });
  });
});
