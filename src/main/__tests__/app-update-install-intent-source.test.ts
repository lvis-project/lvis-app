import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("app update install intent source contract", () => {
  it("lets updater-owned window close bypass hide-to-tray", () => {
    const source = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
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

  it("lets updater-owned before-quit bypass plugin shutdown interception", () => {
    const source = readFileSync(new URL("../../boot/steps/plugin-runtime.ts", import.meta.url), "utf8");
    const beforeQuitHandler = source.slice(
      source.indexOf('app.prependOnceListener("before-quit"'),
      source.indexOf("return {", source.indexOf('app.prependOnceListener("before-quit"')),
    );
    expect(beforeQuitHandler).toContain("if (isAppUpdateInstallRequested()) return;");
    expect(beforeQuitHandler.indexOf("isAppUpdateInstallRequested")).toBeLessThan(
      beforeQuitHandler.indexOf("event.preventDefault();"),
    );
  });
});
