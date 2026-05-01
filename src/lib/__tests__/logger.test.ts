/**
 * logger.ts format-selection unit tests.
 *
 * Module-level constants (isProduction, useJsonFormat) are evaluated once at
 * import time, so each scenario re-imports the module in isolation via
 * vi.resetModules() + dynamic import.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

async function importLogger(env: Record<string, string | undefined>) {
  vi.resetModules();
  // Apply env overrides then restore after import so other tests aren't affected.
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    const mod = await import("../logger.js");
    return mod;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("logger format selection", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses pino-pretty transport when NODE_ENV=development and LVIS_DEV=1", async () => {
    // LVIS_DEV=1 prevents isPackagedElectron from firing in test environments
    // where process.defaultApp is absent (same condition as packaged Electron).
    const { logger, transport } = await importLogger({
      NODE_ENV: "development",
      LVIS_LOG_FORMAT: undefined,
      VITEST: undefined,
      LVIS_DEV: "1",
    });
    expect(logger.level).toBe("debug");
    // transport should be the pino-pretty config object (not undefined)
    expect(transport).toBeDefined();
    expect((transport as { target: string }).target).toBe("pino-pretty");
  });

  it("uses JSON (no transport) when NODE_ENV=production", async () => {
    const { logger, transport } = await importLogger({
      NODE_ENV: "production",
      LVIS_LOG_FORMAT: undefined,
      VITEST: undefined,
    });
    expect(logger.level).toBe("info");
    // In JSON mode transport is undefined (pino default stdout JSON)
    expect(transport).toBeUndefined();
  });

  it("forces JSON (transport=undefined) when LVIS_LOG_FORMAT=json regardless of NODE_ENV", async () => {
    const { logger, transport } = await importLogger({
      NODE_ENV: "development",
      LVIS_LOG_FORMAT: "json",
      VITEST: undefined,
      LVIS_DEV: "1",
    });
    // In JSON mode the level stays at the LOG_LEVEL override default for
    // non-production (LVIS_DEV=1 keeps isPackagedElectron false): "debug".
    expect(logger.level).toBe("debug");
    expect(transport).toBeUndefined();
  });

  it("delegates to console in test environment (VITEST set)", async () => {
    // VITEST env is always set during test runs; createLogger returns a
    // console-proxy. Verify the console path by checking the proxy shape.
    const { createLogger } = await importLogger({
      VITEST: "1",
      NODE_ENV: "test",
    });
    const log = createLogger("test-module");
    // The console proxy does not have pino internal properties.
    // It should have warn/error/info/debug as functions.
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.debug).toBe("function");
  });

  it("isProduction=false gives debug level by default", async () => {
    const { logger } = await importLogger({
      NODE_ENV: "development",
      LOG_LEVEL: undefined,
      LVIS_LOG_FORMAT: undefined,
      VITEST: undefined,
      LVIS_DEV: "1",
    });
    expect(logger.level).toBe("debug");
  });

  it("respects LOG_LEVEL override", async () => {
    const { logger } = await importLogger({
      NODE_ENV: "development",
      LOG_LEVEL: "warn",
      LVIS_LOG_FORMAT: undefined,
      VITEST: undefined,
      LVIS_DEV: "1",
    });
    expect(logger.level).toBe("warn");
  });
});
