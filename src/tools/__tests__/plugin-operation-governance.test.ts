import { describe, expect, it } from "vitest";
import {
  maxOperationRisk,
  pluginOperationIntentHash,
  resolvePluginOperation,
  type PluginToolOperationPolicy,
} from "../plugin-operation-governance.js";

const policy: PluginToolOperationPolicy = {
  discriminant: "operation",
  appAllowed: ["list", "reserve"],
  operations: {
    list: { kind: "read", minimumRisk: "read" },
    reserve: {
      kind: "write",
      minimumRisk: "network",
      requiresRead: { tool: "meeting_read", operations: ["availability"], maxAgeMs: 60_000 },
    },
    admin_delete: { kind: "write", minimumRisk: "shell" },
  },
};

describe("plugin operation governance", () => {
  it("requires an own top-level string discriminant and default-denies unknown/app-disallowed operations", () => {
    expect(() => resolvePluginOperation(policy, {}, "ui")).toThrow(/top-level string/);
    expect(() => resolvePluginOperation(policy, { operation: "missing" }, "ui")).toThrow(/unknown/);
    expect(() => resolvePluginOperation(policy, { operation: "admin_delete" }, "ui")).toThrow(/not app-allowed/);
    expect(resolvePluginOperation(policy, { operation: "admin_delete" }, "model").operation).toBe("admin_delete");
    const inherited = Object.create({ operation: "list" }) as Record<string, unknown>;
    expect(() => resolvePluginOperation(policy, inherited, "ui")).toThrow(/top-level string/);
  });

  it("hashes canonical JSON intent and rejects non-JSON-clean inputs", () => {
    expect(pluginOperationIntentHash({ operation: "reserve", a: 1, b: 2 })).toBe(
      pluginOperationIntentHash({ b: 2, operation: "reserve", a: 1 }),
    );
    expect(() => pluginOperationIntentHash({ operation: "reserve", n: Number.NaN })).toThrow(/non-finite/);
    expect(() => pluginOperationIntentHash({ operation: "reserve", value: new Map() })).toThrow(/plain JSON/);
  });

  it("takes the maximum of strict baseline, host inspection and operation floor", () => {
    expect(maxOperationRisk("write", "read", "network")).toBe("network");
    expect(maxOperationRisk("shell", "network", "read")).toBe("shell");
    expect(() => maxOperationRisk("meta", "read")).toThrow(/meta risk/);
  });
});
