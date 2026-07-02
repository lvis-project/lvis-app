/**
 * Regression guard for the native settings window.
 *
 * These are main-process window/menu wiring guarantees, not renderer component
 * state, so source inspection is intentional. C17 decomposed `src/main.ts`:
 * the application-menu builders now live in `src/main/app-menu.ts` and the
 * settings BrowserWindow lives in `src/main/settings-window.ts`. The
 * guarantees below are unchanged — only the files carrying the source moved.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main process — settings window edit shortcuts", () => {
  const appMenuSource = readFileSync("src/main/app-menu.ts", "utf-8").replace(/\r\n/g, "\n");
  const settingsWindowSource = readFileSync("src/main/settings-window.ts", "utf-8").replace(/\r\n/g, "\n");

  it("keeps a standard Edit menu in the application menu", () => {
    expect(appMenuSource).toContain("function createEditMenu()");
    for (const role of ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]) {
      expect(appMenuSource).toContain(`role: "${role}"`);
    }
    expect(appMenuSource).toMatch(/const editMenu = createEditMenu\(\);/);
    expect(appMenuSource).toMatch(/\beditMenu,\s*\n\s*createViewMenu\(\)/);
  });

  it("does not remove the hidden menu from the settings BrowserWindow", () => {
    expect(settingsWindowSource).not.toContain("settingsWindow.setMenu(null)");
    expect(settingsWindowSource).toContain("autoHideMenuBar: true");
    expect(settingsWindowSource).toContain("Keep the hidden application menu attached");
  });
});
