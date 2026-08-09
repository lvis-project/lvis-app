/**
 * Regression guard for standard edit shortcuts in the application menu.
 *
 * These are main-process menu wiring guarantees, so source inspection is
 * intentional: the application-menu builders live in `src/main/app-menu.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main process — edit shortcuts", () => {
  const appMenuSource = readFileSync("src/main/app-menu.ts", "utf-8").replace(/\r\n/g, "\n");

  it("keeps a standard Edit menu in the application menu", () => {
    expect(appMenuSource).toContain("function createEditMenu()");
    for (const role of ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]) {
      expect(appMenuSource).toContain(`role: "${role}"`);
    }
    expect(appMenuSource).toMatch(/const editMenu = createEditMenu\(\);/);
    expect(appMenuSource).toMatch(/\beditMenu,\s*\n\s*createViewMenu\(\)/);
  });
});
