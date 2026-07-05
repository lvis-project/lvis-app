/**
 * E4 — shared shortcuts SoT: accelerator + block normalization.
 */
import { describe, expect, it } from "vitest";
import { normalizeAccelerator, normalizeShortcuts } from "../shortcuts.js";

describe("normalizeAccelerator", () => {
  it("accepts a valid accelerator, trimmed", () => {
    expect(normalizeAccelerator("  CommandOrControl+Shift+Space  ")).toBe(
      "CommandOrControl+Shift+Space",
    );
    expect(normalizeAccelerator("Alt+F1")).toBe("Alt+F1");
  });

  it("rejects non-strings, empty, oversized, and control-char input", () => {
    expect(normalizeAccelerator(42)).toBeNull();
    expect(normalizeAccelerator(null)).toBeNull();
    expect(normalizeAccelerator("")).toBeNull();
    expect(normalizeAccelerator("   ")).toBeNull();
    expect(normalizeAccelerator("A".repeat(200))).toBeNull();
    expect(normalizeAccelerator("Ctrl+\n+K")).toBeNull();
  });

  it("rejects lone modifiers and empty '+' segments", () => {
    expect(normalizeAccelerator("Shift")).toBeNull();
    expect(normalizeAccelerator("CommandOrControl")).toBeNull();
    expect(normalizeAccelerator("Ctrl+")).toBeNull();
    expect(normalizeAccelerator("Ctrl++K")).toBeNull();
  });
});

describe("normalizeShortcuts", () => {
  const fallback = { toggleWindow: "Alt+F1", enabled: true } as const;

  it("returns fallback for non-object input", () => {
    expect(normalizeShortcuts(null, { ...fallback })).toEqual(fallback);
    expect(normalizeShortcuts([], { ...fallback })).toEqual(fallback);
  });

  it("accepts null toggleWindow (explicit clear)", () => {
    expect(normalizeShortcuts({ toggleWindow: null }, { ...fallback }).toggleWindow).toBeNull();
  });

  it("keeps fallback when an invalid accelerator is supplied", () => {
    const out = normalizeShortcuts({ toggleWindow: "Shift" }, { ...fallback });
    expect(out.toggleWindow).toBe("Alt+F1");
  });

  it("applies a valid accelerator + enabled", () => {
    const out = normalizeShortcuts(
      { toggleWindow: "CommandOrControl+K", enabled: false },
      { ...fallback },
    );
    expect(out).toEqual({ toggleWindow: "CommandOrControl+K", enabled: false });
  });
});
