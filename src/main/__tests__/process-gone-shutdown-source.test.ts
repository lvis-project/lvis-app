import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("process-gone shutdown logging source contract", () => {
  it("does not treat renderer process teardown during app shutdown as a crash", () => {
    const source = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
    const handlerStart = source.indexOf('win.webContents.on("render-process-gone"');
    const handler = source.slice(
      handlerStart,
      source.indexOf("});", handlerStart) + 3,
    );

    expect(handler).toContain("appShutdownStarted || appShutdownCompleted");
    expect(handler).toContain("main window renderer process gone during app shutdown");
    expect(handler.indexOf("appShutdownStarted || appShutdownCompleted")).toBeLessThan(
      handler.indexOf('log.error({ details }, "main window renderer process gone")'),
    );
  });

  it("downgrades child process teardown during app shutdown", () => {
    const source = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
    const handlerStart = source.indexOf('app.on("child-process-gone"');
    const handler = source.slice(
      handlerStart,
      source.indexOf("});", handlerStart) + 3,
    );

    expect(handler).toContain("appShutdownStarted || appShutdownCompleted");
    expect(handler).toContain("child process gone during app shutdown");
    expect(handler.indexOf("appShutdownStarted || appShutdownCompleted")).toBeLessThan(
      handler.indexOf('log.error(payload, "child process gone")'),
    );
  });
});
