/**
 * The persisted `settings.marketplace.skippedPluginUpdates` contract.
 *
 * The renderer writes this map (`useMarketplaceUpdates.skip`) and main reads it
 * to filter the `marketplace:updates-available` broadcast
 * (`wireUpdateCheck`). Both sides now share these functions, so the rules below
 * are pinned once for both — previously main's copy had no test at all.
 *
 * Every assertion reds when the corresponding clause is removed; the renderer's
 * end-to-end consequences are pinned by
 * `src/ui/renderer/hooks/__tests__/use-marketplace-updates.test.ts`, which reds
 * on the same single edit.
 */
import { describe, it, expect } from "vitest";
import {
  createSkippedPluginUpdateMap,
  isSkippedPluginUpdate,
  normalizeSkippedPluginUpdateKey,
  putSkippedPluginUpdate,
  readSkippedPluginUpdates,
} from "../skipped-plugin-updates.js";

describe("createSkippedPluginUpdateMap", () => {
  it("has a null prototype so an inherited member never answers a lookup", () => {
    const map = createSkippedPluginUpdateMap();
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(map["toString"]).toBeUndefined();
    expect(map["constructor"]).toBeUndefined();
  });
});

describe("normalizeSkippedPluginUpdateKey", () => {
  it("trims", () => {
    expect(normalizeSkippedPluginUpdateKey("  meeting  ")).toBe("meeting");
  });

  it("rejects a blank id", () => {
    expect(normalizeSkippedPluginUpdateKey("")).toBeNull();
    expect(normalizeSkippedPluginUpdateKey("   ")).toBeNull();
  });

  it("rejects every reserved key, including after trimming", () => {
    for (const reserved of ["__proto__", "constructor", "prototype"]) {
      expect(normalizeSkippedPluginUpdateKey(reserved), reserved).toBeNull();
      expect(normalizeSkippedPluginUpdateKey(`  ${reserved}  `), reserved).toBeNull();
    }
  });

  it("does not reject an id that merely contains a reserved word", () => {
    expect(normalizeSkippedPluginUpdateKey("my-constructor-plugin")).toBe("my-constructor-plugin");
  });
});

describe("putSkippedPluginUpdate", () => {
  it("records a trimmed key and a trimmed version", () => {
    const map = createSkippedPluginUpdateMap();
    putSkippedPluginUpdate(map, "  meeting  ", "  0.5.24  ");
    expect({ ...map }).toEqual({ meeting: "0.5.24" });
  });

  it("drops a reserved id rather than writing it", () => {
    const map = createSkippedPluginUpdateMap();
    putSkippedPluginUpdate(map, "__proto__", "1.0.0");
    expect(Object.keys(map)).toEqual([]);
    expect(Object.getPrototypeOf(map)).toBeNull();
  });

  it("drops a blank version — an unmatchable entry is worse than none", () => {
    const map = createSkippedPluginUpdateMap();
    putSkippedPluginUpdate(map, "meeting", "   ");
    expect(Object.keys(map)).toEqual([]);
  });

  it("overwrites the version for an id already present", () => {
    const map = createSkippedPluginUpdateMap();
    putSkippedPluginUpdate(map, "meeting", "0.5.24");
    putSkippedPluginUpdate(map, "meeting", "0.5.25");
    expect({ ...map }).toEqual({ meeting: "0.5.25" });
  });
});

describe("readSkippedPluginUpdates", () => {
  it("returns an empty null-prototype map for anything that is not a plain object", () => {
    for (const input of [undefined, null, 0, "", "meeting", true, ["meeting"]]) {
      const map = readSkippedPluginUpdates(input);
      expect(Object.keys(map)).toEqual([]);
      expect(Object.getPrototypeOf(map)).toBeNull();
    }
  });

  it("keeps string-valued entries, trimming key and value", () => {
    expect({ ...readSkippedPluginUpdates({ "  meeting  ": "  0.5.24  ", hub: "1.0.0" }) })
      .toEqual({ meeting: "0.5.24", hub: "1.0.0" });
  });

  it("drops non-string values", () => {
    expect({ ...readSkippedPluginUpdates({ a: 1, b: null, c: {}, d: ["1"], e: "1.0.0" }) })
      .toEqual({ e: "1.0.0" });
  });

  it("drops reserved keys carried in the persisted payload", () => {
    const map = readSkippedPluginUpdates(
      JSON.parse('{"__proto__":"1.0.0","constructor":"1.0.0","prototype":"1.0.0","meeting":"0.5.24"}'),
    );
    expect({ ...map }).toEqual({ meeting: "0.5.24" });
    expect(Object.getPrototypeOf(map)).toBeNull();
  });

  it("drops blank keys and blank versions", () => {
    expect({ ...readSkippedPluginUpdates({ "   ": "1.0.0", meeting: "   ", hub: "1.0.0" }) })
      .toEqual({ hub: "1.0.0" });
  });

  it("is idempotent — which is why it doubles as the copy operation", () => {
    const once = readSkippedPluginUpdates({ "  meeting  ": " 0.5.24 ", bad: 7, "": "x" });
    const twice = readSkippedPluginUpdates(once);
    expect({ ...twice }).toEqual({ ...once });
    expect(twice).not.toBe(once);
  });
});

describe("isSkippedPluginUpdate", () => {
  const skipped = readSkippedPluginUpdates({ meeting: "0.5.24" });

  it("skips only an exact version match", () => {
    expect(isSkippedPluginUpdate({ pluginId: "meeting", latestVersion: "0.5.24" }, skipped))
      .toBe(true);
    expect(isSkippedPluginUpdate({ pluginId: "meeting", latestVersion: "0.5.25" }, skipped))
      .toBe(false);
  });

  it("applies the same trimming the writer applied", () => {
    expect(isSkippedPluginUpdate({ pluginId: " meeting ", latestVersion: " 0.5.24 " }, skipped))
      .toBe(true);
  });

  it("never skips an unknown plugin", () => {
    expect(isSkippedPluginUpdate({ pluginId: "hub", latestVersion: "0.5.24" }, skipped))
      .toBe(false);
  });

  it("never skips on a reserved id or a blank version", () => {
    expect(isSkippedPluginUpdate({ pluginId: "__proto__", latestVersion: "1.0.0" }, skipped))
      .toBe(false);
    expect(isSkippedPluginUpdate({ pluginId: "constructor", latestVersion: "1.0.0" }, skipped))
      .toBe(false);
    expect(isSkippedPluginUpdate({ pluginId: "meeting", latestVersion: "  " }, skipped))
      .toBe(false);
  });
});
