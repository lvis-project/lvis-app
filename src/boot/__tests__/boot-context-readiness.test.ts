import { describe, expect, it } from "vitest";
import type { BrowserWindow } from "electron";
import { assertBootContextReady, createBootContext } from "../context.js";

describe("BootContext readiness", () => {
  it("reports every producer field that has not run instead of assembling undefined services", () => {
    const ctx = createBootContext({
      projectRoot: "/workspace",
      mainWindow: {} as BrowserWindow,
      getMainWindow: () => null,
    });

    expect(() => assertBootContextReady(ctx)).toThrowError(
      /boot-context-incomplete: missing networkFetch, pluginNetworkFetch, llmFetch/,
    );
  });
});
