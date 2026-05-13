/**
 * Regression guard for the native settings window.
 *
 * `src/main.ts` is the Electron entry point and cannot be imported safely in
 * a unit test. Source inspection is intentional here: the bug was caused by
 * main-process window/menu wiring, not renderer component state.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main.ts — settings window edit shortcuts", () => {
  const source = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");

  it("keeps a standard Edit menu in the application menu", () => {
    expect(source).toContain("function createEditMenu()");
    for (const role of ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]) {
      expect(source).toContain(`role: "${role}"`);
    }
    expect(source).toMatch(/const editMenu = createEditMenu\(\);/);
    expect(source).toMatch(/\beditMenu,\s*\n\s*createViewMenu\(\)/);
  });

  it("does not remove the hidden menu from the settings BrowserWindow", () => {
    expect(source).not.toContain("settingsWindow.setMenu(null)");
    expect(source).toContain("autoHideMenuBar: true");
    expect(source).toContain("Keep the hidden application menu attached");
  });
});
