/**
 * Application Logger — pino-based structured logging for LVIS main process.
 *
 * Usage:
 *   import { createLogger } from "../lib/logger.js";
 *   const log = createLogger("module-name");
 *   log.info({ key: value }, "Human-readable message");
 *
 * Format selection (evaluated at module load time):
 * - Production: NODE_ENV=production OR LVIS_LOG_FORMAT=json OR isPackagedElectron
 *   (Electron runtime with process.defaultApp absent) → JSON line output
 * - Otherwise (dev / unpackaged Electron / CI): pino-pretty colorized text
 * - Test (NODE_ENV=test or VITEST): delegates to console.* so vitest spies work
 * - LVIS_LOG_FORMAT=json forces JSON regardless of NODE_ENV (useful in CI pipelines)
 * - Do NOT use for auditable security events — use AuditLogger instead (§4.5.5)
 */
import pino from "pino";

const isTest = process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
const isProduction = process.env.NODE_ENV === "production";
// process.defaultApp is set to `true` by the Electron runtime when the app is
// launched unpackaged (i.e. `electron dist/src/main/main.js`). In a packaged build
// the property is absent (undefined). In vitest/plain Node.js it is also
// absent, but those paths are guarded by isTest.
// Precedence (highest to lowest):
//   1. LVIS_LOG_FORMAT=json  → always JSON
//   2. NODE_ENV=production   → JSON
//   3. process.defaultApp absent + not a dev run → packaged Electron → JSON
//   4. default               → pino-pretty (safe for any unpackaged dev run)
//
// Note: scripts/run-electron.mjs sets NODE_ENV=development for `bun run start`;
// production builds rely on the isPackagedElectron signal (process.defaultApp
// absence) rather than NODE_ENV, since packaged Electron does not set
// NODE_ENV=production automatically.
// Guard with isElectronRuntime so plain Node / tsx environments (e.g. scripts,
// unit tests run outside Electron) never get isPackagedElectron=true.
const isElectronRuntime = !!(process as NodeJS.Process & { versions?: { electron?: string } }).versions?.electron;
const isPackagedElectron =
  isElectronRuntime &&
  !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp &&
  process.env.LVIS_DEV !== "1" &&
  !isTest;
const useJsonFormat =
  process.env.LVIS_LOG_FORMAT === "json" || isProduction || isPackagedElectron;

/** Exported for testing — the pino transport config chosen at module load. */
export const transport = !isTest && !useJsonFormat
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    }
  : undefined;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? ((isProduction || isPackagedElectron) ? "info" : "debug"),
  transport,
});

/**
 * Create a child logger scoped to a named module.
 *
 * In test environments (VITEST / NODE_ENV=test) the returned logger proxies
 * calls to console.warn/error/info so existing vitest spyOn(console, 'warn')
 * assertions continue to work. The prefix `[module]` is prepended to match
 * the pre-pino console.log("[module] msg") pattern tests relied on.
 *
 * In production / development, returns a real pino child logger with
 * structured JSON output.
 */
export function createLogger(module: string): pino.Logger {
  if (isTest) {
    const prefix = `[${module}]`;
    // Produce a pino-compatible shape that delegates to console
    const consoleFn = (level: "warn" | "error" | "info" | "debug") =>
      (objOrMsg: unknown, ...args: unknown[]) => {
        const fn =
          level === "warn"
            ? console.warn
            : level === "error"
              ? console.error
              : console.log;
        if (typeof objOrMsg === "object" && objOrMsg !== null && !(objOrMsg instanceof Error)) {
          // pino(obj, msg) form — print msg with prefix, include obj as context
          const msg = typeof args[0] === "string" ? args[0] : "";
          fn(`${prefix} ${msg}`, objOrMsg, ...args.slice(1));
        } else if (typeof objOrMsg === "string") {
          // pino(msg, ...args) form
          fn(`${prefix} ${objOrMsg}`, ...args);
        } else {
          fn(prefix, objOrMsg, ...args);
        }
      };

    return {
      warn: consoleFn("warn"),
      error: consoleFn("error"),
      info: consoleFn("info"),
      debug: consoleFn("debug"),
      trace: consoleFn("debug"),
      fatal: consoleFn("error"),
      child: () => createLogger(module),
    } as unknown as pino.Logger;
  }

  return logger.child({ module });
}
