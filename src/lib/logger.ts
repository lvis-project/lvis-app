/**
 * Application Logger — pino-based structured logging for LVIS main process.
 *
 * Usage:
 *   import { createLogger } from "../lib/logger.js";
 *   const log = createLogger("module-name");
 *   log.info({ key: value }, "Human-readable message");
 *
 * - Production: JSON line output (pino default)
 * - Development (NODE_ENV=development): pino-pretty human-readable output
 * - Test (NODE_ENV=test or VITEST): delegates to console.* so vitest spies work
 * - Do NOT use for auditable security events — use AuditLogger instead (§4.5.5)
 */
import pino from "pino";

const isTest = process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
const isDev = process.env.NODE_ENV === "development";

const transport = isDev
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
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
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
