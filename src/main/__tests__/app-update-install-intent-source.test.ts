import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("app update install intent source contract", () => {
  it("lets updater-owned window close bypass hide-to-tray", () => {
    // C17: createWindow() (and its "close" handler) moved from main.ts into
    // src/main/main-window.ts. Same guarantee, new location.
    const source = readFileSync(new URL("../main-window.ts", import.meta.url), "utf8");
    const closeHandlerStart = source.indexOf('win.on("close"');
    const closeHandler = source.slice(
      closeHandlerStart,
      source.indexOf('win.on("closed"', closeHandlerStart),
    );
    expect(closeHandler).toContain("if (isAppUpdateInstallRequested()) return;");
    expect(closeHandler.indexOf("isAppUpdateInstallRequested")).toBeLessThan(
      closeHandler.indexOf("event.preventDefault();"),
    );
  });

  it("runs cleanup before resuming updater-owned before-quit", () => {
    const source = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
    expect(source).toContain("if (isAppUpdateInstallPrepared()) return;");
    expect(source).toContain('reason: appUpdateInstallRequested ? "app-update-install" : "before-quit"');
    expect(source).toContain("markAppUpdateInstallPrepared();");
    expect(source).toContain("app.quit();");
  });

  it("keeps the boot-time plugin fallback behind the main shutdown lifecycle", () => {
    const source = readFileSync(new URL("../../boot/steps/plugin-runtime.ts", import.meta.url), "utf8");
    const beforeQuitStart = source.indexOf('app.once("before-quit"');
    const beforeQuitHandler = source.slice(
      beforeQuitStart,
      source.indexOf("return {", beforeQuitStart),
    );
    expect(beforeQuitHandler).toContain("if (isAppUpdateInstallRequested()) return;");
    expect(beforeQuitHandler).toContain("if (isAppShutdownStarted()) return;");
    expect(beforeQuitHandler.indexOf("isAppUpdateInstallRequested")).toBeLessThan(
      beforeQuitHandler.indexOf("event.preventDefault();"),
    );
    expect(beforeQuitHandler.indexOf("isAppShutdownStarted")).toBeLessThan(
      beforeQuitHandler.indexOf("event.preventDefault();"),
    );
  });
});
