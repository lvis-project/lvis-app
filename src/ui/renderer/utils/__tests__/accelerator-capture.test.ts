/**
 * E4 — accelerator-capture: KeyboardEvent → Electron accelerator string.
 */
import { describe, expect, it } from "vitest";
import { eventToAccelerator } from "../accelerator-capture.js";

function ev(
  key: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) {
  return {
    key,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  };
}

describe("eventToAccelerator", () => {
  it("builds CommandOrControl+Shift+<key> from ctrl+shift", () => {
    expect(eventToAccelerator(ev("k", { ctrlKey: true, shiftKey: true }))).toBe(
      "CommandOrControl+Shift+K",
    );
  });

  it("maps meta to CommandOrControl (portable)", () => {
    expect(eventToAccelerator(ev("Space", { metaKey: true }))).toBe("CommandOrControl+Space");
  });

  it("maps space + arrows + escape to Electron tokens", () => {
    expect(eventToAccelerator(ev(" ", { altKey: true }))).toBe("Alt+Space");
    expect(eventToAccelerator(ev("ArrowUp", { ctrlKey: true }))).toBe("CommandOrControl+Up");
    expect(eventToAccelerator(ev("Escape", { ctrlKey: true }))).toBe("CommandOrControl+Esc");
  });

  it("passes function keys through verbatim", () => {
    expect(eventToAccelerator(ev("F5", { altKey: true }))).toBe("Alt+F5");
  });

  it("returns null for a modifier-only press", () => {
    expect(eventToAccelerator(ev("Shift", { shiftKey: true }))).toBeNull();
    expect(eventToAccelerator(ev("Control", { ctrlKey: true }))).toBeNull();
    expect(eventToAccelerator(ev("Meta", { metaKey: true }))).toBeNull();
  });

  it("uppercases single printable chars", () => {
    expect(eventToAccelerator(ev("a", { altKey: true }))).toBe("Alt+A");
  });
});
