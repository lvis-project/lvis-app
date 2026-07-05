/**
 * logger.ts format-selection unit tests.
 *
 * Module-level constants (isProduction, useJsonFormat) are evaluated once at
 * import time, so each scenario re-imports the module in isolation via
 * vi.resetModules() + dynamic import.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Sentinel to detect "not passed" vs "passed undefined/null"
const NOT_SET = Symbol("NOT_SET");

async function importLogger(
  envOverrides: Record<string, string | undefined> = {},
  processOverrides: {
    electronVersion?: string | null | typeof NOT_SET;
    defaultApp?: boolean | null | typeof NOT_SET;
  } = {},
) {
  vi.resetModules();

  const { electronVersion = NOT_SET, defaultApp = NOT_SET } = processOverrides;

  // ── env overrides ──────────────────────────────────────────────────────
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // ── process.versions.electron override ────────────────────────────────
  const versionsProxy = process.versions as Record<string, string | undefined>;
  const savedElectron = versionsProxy.electron;
  const changeElectron = electronVersion !== NOT_SET;
  if (changeElectron) {
    if (electronVersion === null || electronVersion === undefined) {
      delete versionsProxy.electron;
    } else {
      versionsProxy.electron = electronVersion;
    }
  }

  // ── process.defaultApp override ───────────────────────────────────────
  const procAny = process as NodeJS.Process & { defaultApp?: boolean };
  const hadDefaultApp = "defaultApp" in procAny;
  const savedDefaultApp = procAny.defaultApp;
  const changeDefaultApp = defaultApp !== NOT_SET;
  if (changeDefaultApp) {
    if (defaultApp === null || defaultApp === undefined) {
      delete procAny.defaultApp;
    } else {
      procAny.defaultApp = defaultApp;
    }
  }

  try {
    const mod = await import("../logger.js");
    return mod;
  } finally {
    // restore env
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // restore versions.electron
    if (changeElectron) {
      if (savedElectron === undefined) {
        delete versionsProxy.electron;
      } else {
        versionsProxy.electron = savedElectron;
      }
    }
    // restore defaultApp
    if (changeDefaultApp) {
      if (!hadDefaultApp) {
        delete procAny.defaultApp;
      } else {
        procAny.defaultApp = savedDefaultApp;
      }
    }
  }
}

describe("logger format selection", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses pino-pretty transport when NODE_ENV=development and LVIS_DEV=1", async () => {
    // In Vitest, process.versions.electron is undefined → isElectronRuntime=false
    // → isPackagedElectron=false automatically. LVIS_DEV=1 is belt-and-suspenders
    // for any environment that may set process.versions.electron.
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

  // ── isPackagedElectron branch coverage ────────────────────────────────────

  it("Electron + unpackaged (defaultApp=true) → pino-pretty, not JSON", async () => {
    // Simulates `electron dist/src/main/main.js` (unpackaged dev run).
    // process.versions.electron present, process.defaultApp=true.
    const { transport } = await importLogger(
      {
        NODE_ENV: "development",
        LVIS_LOG_FORMAT: undefined,
        VITEST: undefined,
        LVIS_DEV: undefined,
      },
      { electronVersion: "32.0.0", defaultApp: true },
    );
    // defaultApp=true → isPackagedElectron=false → pino-pretty
    expect(transport).toBeDefined();
    expect((transport as { target: string }).target).toBe("pino-pretty");
  });

  it("Electron + packaged (defaultApp absent) → JSON (no transport), info level", async () => {
    // Simulates a packaged production Electron build.
    // process.versions.electron present, process.defaultApp absent.
    const { transport, logger } = await importLogger(
      {
        NODE_ENV: "development", // packaged Electron does not set NODE_ENV=production
        LVIS_LOG_FORMAT: undefined,
        VITEST: undefined,
        LVIS_DEV: undefined,
      },
      { electronVersion: "32.0.0", defaultApp: null }, // null = delete the key
    );
    // isPackagedElectron=true → useJsonFormat=true → transport undefined
    expect(transport).toBeUndefined();
    // info level in packaged mode
    expect(logger.level).toBe("info");
  });

  it("plain Node.js (no process.versions.electron) → isElectronRuntime=false → pino-pretty for dev", async () => {
    // Explicitly removes process.versions.electron (simulates plain Node / scripts).
    const { transport } = await importLogger(
      {
        NODE_ENV: "development",
        LVIS_LOG_FORMAT: undefined,
        VITEST: undefined,
        LVIS_DEV: "1",
      },
      { electronVersion: null }, // null = delete the key
    );
    // isElectronRuntime=false → isPackagedElectron=false → pino-pretty
    expect(transport).toBeDefined();
    expect((transport as { target: string }).target).toBe("pino-pretty");
  });
});

describe("logger redaction (#1499 disk-persistence defense)", () => {
  it("censors secret-bearing fields in JSON output", async () => {
    // Non-test JSON path (VITEST unset + LVIS_LOG_FORMAT=json) builds the real
    // multistream pino logger whose first stream is process.stdout. Capture the
    // serialized line and assert secret values are replaced with "[redacted]"
    // both at the top level and one level deep, while non-secret fields survive.
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(chunk.toString());
        return true;
      }) as typeof process.stdout.write);
    try {
      const { logger } = await importLogger({
        LVIS_LOG_FORMAT: "json",
        VITEST: undefined,
        NODE_ENV: "development",
        LVIS_DEV: "1",
      });
      logger.info(
        { apiKey: "sk-secret", provider: { token: "tok-123" }, sessionId: "keep-me" },
        "redaction probe",
      );
    } finally {
      spy.mockRestore();
    }
    const line = writes.join("");
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("sk-secret");
    expect(line).not.toContain("tok-123");
    // Non-secret context field is preserved.
    expect(line).toContain("keep-me");
  });
});

describe("initFileLogSink — fail-closed lifecycle (#1499)", () => {
  it("swallows a createLogFileSink failure and returns null (never bricks boot)", async () => {
    // Force createLogFileSink to throw: point `dir` at a path whose parent is a
    // regular FILE, so ensureLogDir's mkdirSync(recursive) fails with ENOTDIR/
    // EEXIST. initFileLogSink must catch this and return null — the boot path
    // (`if (sink) { … }` in boot/services.ts) then simply skips file logging.
    const parentFile = join(mkdtempSync(join(tmpdir(), "lvis-logfail-")), "not-a-dir");
    writeFileSync(parentFile, "x");
    const badDir = join(parentFile, "logs"); // parent is a file → mkdir fails

    const { initFileLogSink, closeFileLogSink } = await importLogger();
    let sink: unknown;
    let threw = false;
    try {
      sink = initFileLogSink({ dir: badDir });
    } catch {
      threw = true;
    } finally {
      closeFileLogSink();
    }
    // The contract: no throw escapes, and the sink is null (fail-closed).
    expect(threw).toBe(false);
    expect(sink).toBeNull();
  });

  it("returns a live sink for a valid directory (happy path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-logok-"));
    const { initFileLogSink, closeFileLogSink } = await importLogger();
    const sink = initFileLogSink({ dir, retentionDays: 7 });
    try {
      expect(sink).not.toBeNull();
      expect(typeof sink?.currentFile).toBe("string");
      expect(sink?.currentFile.startsWith(dir)).toBe(true);
    } finally {
      closeFileLogSink();
      // Retry rm — SonicBoom's async fd close can briefly hold the handle on
      // Windows (mirrors log-file-sink.test.ts's own cleanup guard).
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    }
  });
});
