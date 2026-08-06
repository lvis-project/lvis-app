import { describe, expect, it, vi } from "vitest";
import type { SettingsService } from "../../data/settings-store.js";

vi.mock("electron", () => ({
  Notification: { isSupported: vi.fn(() => false) },
}));

import { buildPluginConfigOverrides } from "../plugins.js";

function settingsFor(
  activeChatRuntime: { kind: "api" } | { kind: "subscription"; provider: "codex" },
): SettingsService {
  return {
    get: vi.fn((key: string) => {
      if (key === "llm") {
        return { provider: "openai", activeChatRuntime };
      }
      if (key === "pluginConfigs") return { "plugin-a": { customSetting: true } };
      return {};
    }),
  } as unknown as SettingsService;
}

describe("buildPluginConfigOverrides", () => {
  it("keeps the API provider identity for key-based generation", () => {
    expect(buildPluginConfigOverrides(settingsFor({ kind: "api" }))).toEqual({
      "*": { hostApiVendor: "openai" },
      "plugin-a": { customSetting: true },
    });
  });

  it("omits the stale API provider identity when a subscription runtime owns generation", () => {
    expect(buildPluginConfigOverrides(settingsFor({ kind: "subscription", provider: "codex" }))).toEqual({
      "plugin-a": { customSetting: true },
    });
  });
});
