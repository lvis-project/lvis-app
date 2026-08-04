import { describe, expect, it } from "vitest";
import { SETTINGS_TABS, normalizeSettingsTab } from "../settings-tabs.js";

describe("normalizeSettingsTab", () => {
  it("keeps every current tab id addressable", () => {
    for (const tab of SETTINGS_TABS) {
      expect(normalizeSettingsTab(tab)).toBe(tab);
    }
  });

  it("resolves retired tab ids to the page that absorbed them", () => {
    // Each of these is a deep link or a persisted id that a user can still be
    // holding after an upgrade; landing on the default tab would silently drop
    // them somewhere unrelated.
    expect(normalizeSettingsTab("privacy")).toBe("chat");
    expect(normalizeSettingsTab("plugin-perf")).toBe("plugin-config");
    expect(normalizeSettingsTab("general")).toBe("llm");
    expect(normalizeSettingsTab("tailnet-access")).toBe("remote-surfaces");
  });

  it("falls back to the landing tab for anything it cannot resolve", () => {
    for (const value of ["", "not-a-tab", undefined, null, 7, {}, ["chat"]]) {
      expect(normalizeSettingsTab(value)).toBe("llm");
    }
  });
});
