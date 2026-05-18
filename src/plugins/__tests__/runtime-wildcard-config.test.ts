/**
 * #893 — Wildcard configOverrides slot tests for PluginRuntime.
 *
 * Verifies that `setWildcardConfigOverride` merges (does not clobber) and
 * `clearWildcardConfigOverride` removes only the named keys, leaving the
 * slot intact for unrelated injectors (e.g. boot's `pythonExecutable`).
 */
import { describe, it, expect } from "vitest";
import { PluginRuntime } from "../runtime.js";
import { buildPluginContext } from "../runtime/sandbox.js";

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

  // PR #894 review B2 — getter for wildcard config, used by hostApi.config.get
  it("getWildcardConfigOverride returns a shallow copy of the wildcard slot", () => {
    const rt = makeRuntime({
      "*": { hostApiVendor: "openai", pythonExecutable: "/usr/bin/python3" },
    });
    const copy = rt.getWildcardConfigOverride();
    expect(copy).toEqual({
      hostApiVendor: "openai",
      pythonExecutable: "/usr/bin/python3",
    });
    // mutating the copy must not affect the underlying slot
    copy.attacker = "x";
    const slot = (rt as unknown as { configOverrides: Record<string, Record<string, unknown>> })
      .configOverrides["*"];
    expect(slot).toEqual({
      hostApiVendor: "openai",
      pythonExecutable: "/usr/bin/python3",
    });
  });

  it("getWildcardConfigOverride returns an empty object when no wildcard is set", () => {
    const rt = makeRuntime({});
    expect(rt.getWildcardConfigOverride()).toEqual({});
  });

  // CRIT-1 regression guard — llmApiKey must NOT appear in the wildcard slot
  // or in the effective plugin config map. The raw API key flows through
  // getSecret, not through configOverrides.
  it("config.get('llmApiKey') returns undefined — CRIT-1 regression guard", () => {
    const rt = makeRuntime({});
    // Wildcard slot must not contain llmApiKey
    expect(rt.getWildcardConfigOverride()["llmApiKey"]).toBeUndefined();
    expect(rt.getWildcardConfigOverride()["llmProvider"]).toBeUndefined();

    // Even after the vendor id is injected (normal cycle-3 boot path),
    // llmApiKey must still be absent from the effective config.
    rt.setWildcardConfigOverride({ hostApiVendor: "openai" });
    const effectiveConfig = buildPluginContext({
      pluginId: "test-plugin",
      pluginRoot: "/tmp",
      hostRoot: "/tmp",
      pluginDataDir: "/tmp",
      manifest: {
        id: "test-plugin",
        name: "Test",
        version: "1.0.0",
        description: "Test",
        publisher: "Test",
        entry: "index.js",
        tools: [],
      },
      configOverrides: (rt as unknown as { configOverrides: Record<string, Record<string, unknown>> }).configOverrides,
      hostApi: {} as never,
    }).config;

    expect((effectiveConfig as Record<string, unknown>)["llmApiKey"]).toBeUndefined();
    expect((effectiveConfig as Record<string, unknown>)["llmProvider"]).toBeUndefined();
    // vendor id IS present (injected by boot)
    expect((effectiveConfig as Record<string, unknown>)["hostApiVendor"]).toBe("openai");
  });
});
