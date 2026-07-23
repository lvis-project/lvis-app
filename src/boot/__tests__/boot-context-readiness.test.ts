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
    expect(() => assertBootContextReady(ctx)).toThrowError(/rationaleHostService/);
  });

  it("distinguishes an explicitly unavailable optional service from a skipped producer", () => {
    const ctx = createBootContext({
      projectRoot: "/workspace",
      mainWindow: {} as BrowserWindow,
      getMainWindow: () => null,
    });

    ctx.rationaleHostService = undefined;
    let readinessError: unknown;
    try {
      assertBootContextReady(ctx);
    } catch (error) {
      readinessError = error;
    }
    expect(readinessError).toBeInstanceOf(Error);
    expect((readinessError as Error).message).toMatch(/^boot-context-incomplete:/u);
    expect((readinessError as Error).message).not.toContain("rationaleHostService");
  });
});
