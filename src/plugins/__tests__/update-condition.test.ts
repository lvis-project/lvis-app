import { describe, expect, it } from "vitest";
import { resolvePluginUpdateCondition } from "../update-condition.js";

describe("resolvePluginUpdateCondition", () => {
  it("blocks a newer plugin candidate when the running app is too old", () => {
    expect(resolvePluginUpdateCondition({
      appVersion: "0.5.11",
      installed: { presence: "present", version: "0.5.31" },
      candidate: {
        version: "0.5.32",
        installPolicy: "admin",
        requires: { minAppVersion: "0.5.12" },
      },
    })).toEqual({
      kind: "blocked_by_app",
      currentAppVersion: "0.5.11",
      minAppVersion: "0.5.12",
    });
  });

  it("selects a compatible user update", () => {
    const condition = resolvePluginUpdateCondition({
      appVersion: "0.5.12",
      installed: { presence: "present", version: "0.5.31" },
      candidate: {
        version: "0.5.32",
        installPolicy: "user",
        requires: { minAppVersion: "0.5.12" },
      },
    });

    expect(condition).toEqual({ kind: "eligible_user_update" });
    expect(Object.isFrozen(condition)).toBe(true);
  });

  it("selects a compatible managed update only for boot management", () => {
    expect(resolvePluginUpdateCondition({
      appVersion: "0.5.12",
      installed: { presence: "present", version: "0.5.31" },
      candidate: {
        version: "0.5.32",
        installPolicy: "admin",
        requires: { minAppVersion: "0.5.12" },
      },
    })).toEqual({ kind: "eligible_managed_boot_update" });
  });
});
