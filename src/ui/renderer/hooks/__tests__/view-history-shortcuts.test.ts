// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  isEditableTarget,
  viewHistoryIntent,
} from "../use-view-history-shortcuts.js";

/**
 * The chord decision, tested directly because the two platforms cannot both
 * be driven through the app in one run.
 *
 * The macOS binding is not a style choice: `Option`+←/→ is word-wise caret
 * movement in text fields there, so the Windows chord would break composer
 * editing on a Mac. These tests pin that the two platforms never accept each
 * other's chord.
 */
const key = (over: Partial<KeyboardEvent>): Pick<
  KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey"
> => ({
  key: "", altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...over,
});

describe("viewHistoryIntent", () => {
  it("takes Alt+Arrow off macOS", () => {
    expect(viewHistoryIntent(key({ key: "ArrowLeft", altKey: true }), false)).toBe("back");
    expect(viewHistoryIntent(key({ key: "ArrowRight", altKey: true }), false)).toBe("forward");
  });

  it("takes Cmd+Bracket on macOS", () => {
    expect(viewHistoryIntent(key({ key: "[", metaKey: true }), true)).toBe("back");
    expect(viewHistoryIntent(key({ key: "]", metaKey: true }), true)).toBe("forward");
  });

  it("refuses the OTHER platform's chord on each platform", () => {
    // The load-bearing one: Alt+Arrow must stay inert on macOS or word-wise
    // caret movement in the composer starts navigating instead.
    expect(viewHistoryIntent(key({ key: "ArrowLeft", altKey: true }), true)).toBeNull();
    expect(viewHistoryIntent(key({ key: "ArrowRight", altKey: true }), true)).toBeNull();
    expect(viewHistoryIntent(key({ key: "[", metaKey: true }), false)).toBeNull();
    expect(viewHistoryIntent(key({ key: "]", metaKey: true }), false)).toBeNull();
  });

  it("refuses a bare arrow, and any chord carrying extra modifiers", () => {
    expect(viewHistoryIntent(key({ key: "ArrowLeft" }), false)).toBeNull();
    expect(viewHistoryIntent(key({ key: "ArrowLeft", altKey: true, shiftKey: true }), false)).toBeNull();
    expect(viewHistoryIntent(key({ key: "ArrowLeft", altKey: true, ctrlKey: true }), false)).toBeNull();
    expect(viewHistoryIntent(key({ key: "[", metaKey: true, altKey: true }), true)).toBeNull();
  });

  it("refuses unrelated keys", () => {
    expect(viewHistoryIntent(key({ key: "k", metaKey: true }), true)).toBeNull();
    expect(viewHistoryIntent(key({ key: "ArrowUp", altKey: true }), false)).toBeNull();
  });
});

describe("isEditableTarget", () => {
  it("recognizes the fields a keystroke would otherwise be stolen from", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isEditableTarget(document.createElement(tag))).toBe(true);
    }
    const rich = document.createElement("div");
    Object.defineProperty(rich, "isContentEditable", { value: true });
    expect(isEditableTarget(rich)).toBe(true);
  });

  it("leaves ordinary elements alone", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
