/**
 * WorkspaceLauncherShortcut.alt field + matcher — the side-chat companion PR
 * adds a ⌥⌘S launcher entry, which required `matchesLauncherShortcut` to stop
 * unconditionally rejecting Alt and instead match it exactly.
 */
import { describe, it, expect } from "vitest";
import {
  WORKSPACE_TAB_LAUNCHER,
  matchesLauncherShortcut,
  type WorkspaceLauncherShortcut,
} from "../command-actions.js";

function keyEvent(over: Partial<KeyboardEvent>): Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> {
  return { key: "a", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over };
}

describe("workspace launcher shortcut matcher — alt field", () => {
  it("side-chat is a launcher item bound to ⌥⌘S", () => {
    const sideChat = WORKSPACE_TAB_LAUNCHER.find((i) => i.kind === "side-chat");
    expect(sideChat).toBeTruthy();
    expect(sideChat!.shortcut).toEqual({ key: "s", meta: true, ctrl: false, shift: false, alt: true });
    expect(sideChat!.shortcutHint).toBe("⌥⌘S");
  });

  it("⌥⌘S matches the side-chat shortcut", () => {
    const sc = WORKSPACE_TAB_LAUNCHER.find((i) => i.kind === "side-chat")!.shortcut!;
    expect(matchesLauncherShortcut(sc, keyEvent({ key: "s", metaKey: true, altKey: true }))).toBe(true);
    // Ctrl+Alt+S also matches (non-mac meta acceptance).
    expect(matchesLauncherShortcut(sc, keyEvent({ key: "s", ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("⌘S without Alt does NOT match the ⌥⌘S binding", () => {
    const sc = WORKSPACE_TAB_LAUNCHER.find((i) => i.kind === "side-chat")!.shortcut!;
    expect(matchesLauncherShortcut(sc, keyEvent({ key: "s", metaKey: true, altKey: false }))).toBe(false);
  });

  it("a non-alt binding still rejects a stray Alt press", () => {
    const browser: WorkspaceLauncherShortcut = { key: "t", meta: true, ctrl: false, shift: false, alt: false };
    expect(matchesLauncherShortcut(browser, keyEvent({ key: "t", metaKey: true, altKey: false }))).toBe(true);
    expect(matchesLauncherShortcut(browser, keyEvent({ key: "t", metaKey: true, altKey: true }))).toBe(false);
  });

  it("every launcher shortcut declares an explicit alt field (Field-Addition Sweep)", () => {
    for (const item of WORKSPACE_TAB_LAUNCHER) {
      if (item.shortcut) {
        expect(typeof item.shortcut.alt).toBe("boolean");
      }
    }
  });
});
