/**
 * Validation and version-gating of the `actions` array on a server
 * announcement row.
 *
 * This is the trust boundary: the marketplace validates on the way in, and the
 * app validates again on the way out, because an announcement is content
 * fetched over the network and the app has to hold up regardless of what
 * arrives. Every case below asserts a DROP rather than a correction — a
 * malformed entry must yield no button, never a button pointing somewhere it
 * was not asked to.
 */
import { describe, expect, it } from "vitest";
import {
  isMarketplaceAnnouncementAction,
  parseMarketplaceAnnouncementActions,
} from "../marketplace-announcements.js";

const APP_VERSION = "0.9.1";

const LABEL = { ko: "샌드박스 설정 열기", en: "Open sandbox settings" };

function settingsAction(overrides: Record<string, unknown> = {}) {
  return {
    label: LABEL,
    target: { kind: "settings", path: "permissions" },
    ...overrides,
  };
}

function urlAction(overrides: Record<string, unknown> = {}) {
  return {
    label: LABEL,
    target: { kind: "url", url: "https://example.com/guide" },
    ...overrides,
  };
}

describe("parseMarketplaceAnnouncementActions", () => {
  it("returns an empty list when the field is absent or not an array", () => {
    expect(parseMarketplaceAnnouncementActions(undefined, APP_VERSION)).toEqual([]);
    expect(parseMarketplaceAnnouncementActions(null, APP_VERSION)).toEqual([]);
    expect(parseMarketplaceAnnouncementActions({}, APP_VERSION)).toEqual([]);
    expect(parseMarketplaceAnnouncementActions("permissions", APP_VERSION)).toEqual([]);
  });

  it("normalizes a settings action to the tab the app can reach", () => {
    expect(parseMarketplaceAnnouncementActions([settingsAction()], APP_VERSION)).toEqual([
      { label: LABEL, target: { kind: "settings", settingsTab: "permissions" } },
    ]);
  });

  it("accepts a hyphenated tab id", () => {
    const parsed = parseMarketplaceAnnouncementActions(
      [settingsAction({ target: { kind: "settings", path: "remote-surfaces" } })],
      APP_VERSION,
    );
    expect(parsed[0]?.target).toEqual({ kind: "settings", settingsTab: "remote-surfaces" });
  });

  it("keeps an https url as the sink normalized it", () => {
    const parsed = parseMarketplaceAnnouncementActions([urlAction()], APP_VERSION);
    expect(parsed[0]?.target).toEqual({ kind: "url", url: "https://example.com/guide" });
  });

  it("trims label text", () => {
    const parsed = parseMarketplaceAnnouncementActions(
      [settingsAction({ label: { ko: "  열기  ", en: "  Open  " } })],
      APP_VERSION,
    );
    expect(parsed[0]?.label).toEqual({ ko: "열기", en: "Open" });
  });

  it.each([
    ["a non-object entry", "permissions"],
    ["an unknown target kind", settingsAction({ target: { kind: "restart", path: "permissions" } })],
    ["a missing target", settingsAction({ target: undefined })],
    ["a settings tab this build does not ship", settingsAction({ target: { kind: "settings", path: "sandbox" } })],
    ["a section-bearing path", settingsAction({ target: { kind: "settings", path: "permissions/os-tool-sandbox" } })],
    ["a non-string path", settingsAction({ target: { kind: "settings", path: 7 } })],
    ["a plain-http url", urlAction({ target: { kind: "url", url: "http://example.com/guide" } })],
    ["a script-scheme url", urlAction({ target: { kind: "url", url: "javascript:alert(1)" } })],
    ["a file url", urlAction({ target: { kind: "url", url: "file:///etc/passwd" } })],
    ["an embedded-credential url", urlAction({ target: { kind: "url", url: "https://trusted.example@evil.tld/" } })],
    ["an unparseable url", urlAction({ target: { kind: "url", url: "not a url" } })],
    ["a missing label", settingsAction({ label: undefined })],
    ["a label missing one language", settingsAction({ label: { en: "Open" } })],
    ["a blank label", settingsAction({ label: { ko: "   ", en: "Open" } })],
    ["a non-string label", settingsAction({ label: { ko: 7, en: "Open" } })],
    ["a non-string min version", settingsAction({ min_app_version: 9 })],
  ])("drops %s", (_case, entry) => {
    expect(parseMarketplaceAnnouncementActions([entry], APP_VERSION)).toEqual([]);
  });

  it("keeps the good entries when one in the middle is malformed", () => {
    const parsed = parseMarketplaceAnnouncementActions(
      [settingsAction(), { label: LABEL }, urlAction()],
      APP_VERSION,
    );
    expect(parsed).toHaveLength(2);
  });

  it("stops after three, so a longer list cannot turn the banner into a toolbar", () => {
    const parsed = parseMarketplaceAnnouncementActions(
      [urlAction(), urlAction(), urlAction(), settingsAction()],
      APP_VERSION,
    );
    expect(parsed).toHaveLength(3);
    expect(parsed.every((a) => a.target.kind === "url")).toBe(true);
  });

  describe("version gate", () => {
    it("keeps an action the running build satisfies", () => {
      expect(
        parseMarketplaceAnnouncementActions(
          [settingsAction({ min_app_version: "0.9.0" })],
          APP_VERSION,
        ),
      ).toHaveLength(1);
    });

    it("keeps an action whose minimum is exactly the running build", () => {
      expect(
        parseMarketplaceAnnouncementActions(
          [settingsAction({ min_app_version: APP_VERSION })],
          APP_VERSION,
        ),
      ).toHaveLength(1);
    });

    it("drops an action that needs a newer build", () => {
      expect(
        parseMarketplaceAnnouncementActions(
          [settingsAction({ min_app_version: "0.9.2" })],
          APP_VERSION,
        ),
      ).toEqual([]);
    });

    it("leaves an action with no declared minimum ungated", () => {
      expect(
        parseMarketplaceAnnouncementActions(
          [settingsAction({ min_app_version: null })],
          APP_VERSION,
        ),
      ).toHaveLength(1);
    });

    it("fails closed when the running version is unresolvable", () => {
      // `getLvisAppVersion` answers "unknown" when it cannot find package.json.
      // A gated button then hides rather than pointing at a place that may not
      // exist in this build.
      expect(
        parseMarketplaceAnnouncementActions([settingsAction({ min_app_version: "0.1.0" })], "unknown"),
      ).toEqual([]);
      expect(
        parseMarketplaceAnnouncementActions([settingsAction({ min_app_version: "0.1.0" })], ""),
      ).toEqual([]);
    });

    it("leaves an ungated action alone even when the running version is unresolvable", () => {
      expect(parseMarketplaceAnnouncementActions([settingsAction()], "unknown")).toHaveLength(1);
    });
  });
});

describe("isMarketplaceAnnouncementAction", () => {
  it("accepts an already-normalized action", () => {
    expect(
      isMarketplaceAnnouncementAction({
        label: LABEL,
        target: { kind: "settings", settingsTab: "permissions" },
      }),
    ).toBe(true);
    expect(
      isMarketplaceAnnouncementAction({
        label: LABEL,
        target: { kind: "url", url: "https://example.com/guide" },
      }),
    ).toBe(true);
  });

  it("rejects the wire shape, which names the tab under `path`", () => {
    expect(isMarketplaceAnnouncementAction(settingsAction())).toBe(false);
  });

  it.each([
    ["a null value", null],
    ["an unknown tab", { label: LABEL, target: { kind: "settings", settingsTab: "sandbox" } }],
    ["an unknown kind", { label: LABEL, target: { kind: "restart", settingsTab: "permissions" } }],
    ["a plain-http url", { label: LABEL, target: { kind: "url", url: "http://example.com" } }],
    ["a half-filled label", { label: { en: "Open" }, target: { kind: "url", url: "https://example.com" } }],
  ])("rejects %s", (_case, value) => {
    expect(isMarketplaceAnnouncementAction(value)).toBe(false);
  });
});
