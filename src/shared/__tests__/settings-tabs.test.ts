import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  SETTINGS_TABS,
  isSettingsSection,
  normalizeSettingsTab,
  parseSettingsPath,
} from "../settings-tabs.js";

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

describe("SETTINGS_SECTIONS", () => {
  it("covers every shipped tab", () => {
    expect(Object.keys(SETTINGS_SECTIONS).sort()).toEqual([...SETTINGS_TABS].sort());
  });

  it("names each section once across the whole panel", () => {
    // Arrival looks an anchor up by attribute across the mounted panel, so two
    // tabs sharing an id would make where the user lands depend on which tab
    // happened to be open.
    const ids = Object.values(SETTINGS_SECTIONS).flatMap((sections) => [...sections]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("spells every id in the kebab-case the path grammar accepts", () => {
    for (const [tab, sections] of Object.entries(SETTINGS_SECTIONS)) {
      for (const section of sections) {
        expect(section).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(parseSettingsPath(`${tab}/${section}`)).toEqual({ tab, section });
      }
    }
  });

  it("gives every tab at least one place to land", () => {
    for (const tab of SETTINGS_TABS) {
      expect(SETTINGS_SECTIONS[tab].length).toBeGreaterThan(0);
    }
  });
});

describe("isSettingsSection", () => {
  it("answers only for the tab that anchors the section", () => {
    expect(isSettingsSection("permissions", "permissions-os-sandbox")).toBe(true);
    expect(isSettingsSection("llm", "permissions-os-sandbox")).toBe(false);
    expect(isSettingsSection("permissions", "not-a-section")).toBe(false);
  });

  it("rejects a non-string", () => {
    for (const value of [undefined, null, 7, {}, ["permissions-os-sandbox"]]) {
      expect(isSettingsSection("permissions", value)).toBe(false);
    }
  });
});

describe("parseSettingsPath", () => {
  it("accepts a bare tab and reports no section", () => {
    expect(parseSettingsPath("permissions")).toEqual({ tab: "permissions" });
    expect(parseSettingsPath("remote-surfaces")).toEqual({ tab: "remote-surfaces" });
  });

  it("accepts a tab and one of its own sections", () => {
    expect(parseSettingsPath("permissions/permissions-os-sandbox")).toEqual({
      tab: "permissions",
      section: "permissions-os-sandbox",
    });
  });

  it.each([
    ["an unknown tab", "sandbox"],
    ["a retired tab id", "tailnet-access"],
    ["a section this tab does not anchor", "llm/permissions-os-sandbox"],
    ["an unknown section", "permissions/turn-it-on"],
    ["a third segment", "permissions/permissions-os-sandbox/on"],
    ["an empty path", ""],
    ["a trailing separator", "permissions/"],
    ["a leading separator", "/permissions"],
    ["a bare separator", "/"],
    ["surrounding whitespace", " permissions "],
    ["a non-string", 7],
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
  ])("rejects %s", (_case, value) => {
    expect(parseSettingsPath(value)).toBeNull();
  });

  it("does not fold a retired tab id the way normalizeSettingsTab does", () => {
    // The lenient reader has to answer something so the panel can open; this
    // one has to be able to say no, or a button would point at a page nobody
    // asked for.
    expect(normalizeSettingsTab("tailnet-access")).toBe("remote-surfaces");
    expect(parseSettingsPath("tailnet-access")).toBeNull();
  });
});
