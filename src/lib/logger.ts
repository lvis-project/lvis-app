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
 *
 * File sink (production log file, #1499 PR-0):
 * - The console stream above is ALWAYS present. A SECOND destination — a
 *   rotating file at `~/.lvis/logs/lvis-<date>.log` — is attached at BOOT via
 *   {@link initFileLogSink} (not at module load: the log path depends on
 *   `lvisHome()` + a 0o700 directory that must be created after app start).
 * - pino loggers are immutable after construction, so the logger is built over
 *   a {@link https://getpino.io | multistream} that already contains a MUTABLE
 *   file-stream placeholder (a no-op until `initFileLogSink` wires the real
 *   SonicBoom destination). This keeps the boot order unchanged and the logger
 *   a single module-level singleton.
 * - Dev (unpackaged) does NOT write a file by default — `initFileLogSink` is
 *   only called by boot on a packaged/production signal (or `LVIS_LOG_FILE=1`).
 */
import pino from "pino";
import prettyStream from "pino-pretty";
import { createLogFileSink, type LogFileSink, type LogFileSinkOptions } from "./log-file-sink.js";

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

/**
 * Mutable file-sink target. Starts as `null` (no file). {@link initFileLogSink}
 * sets it to a live {@link LogFileSink}. The multistream file stream (below)
 * delegates every write here, so attaching a file sink at boot needs no logger
 * re-construction.
 */
let fileSink: LogFileSink | null = null;

const LOG_LEVEL = process.env.LOG_LEVEL ?? ((isProduction || isPackagedElectron) ? "info" : "debug");

/**
 * The console destination — pino-pretty (colorized text) for dev/unpackaged,
 * or raw pino JSON to stdout for production/packaged/CI. Used both by the
 * legacy single-transport path (kept for the exported `transport`) and as the
 * first multistream stream.
 */
const consoleStream: NodeJS.WritableStream = useJsonFormat
  ? process.stdout
  : // pino-pretty as a STREAM (not a worker transport) so it can coexist with
    // the file stream inside a single pino.multistream. Worker transports are
    // avoided here because they resolve a separate worker entry file, which
    // breaks in a packaged app.asar (PR #684 regression class).
    prettyStream({
      colorize: true,
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "pid,hostname",
    });

/**
 * Exported for testing — the pino transport config chosen at module load. In
 * pretty (dev) mode this remains the pino-pretty transport descriptor so the
 * existing logger-format test assertions stay valid; the multistream file sink
 * is layered on separately via {@link initFileLogSink}.
 */
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

/**
 * The file multistream stream: forwards every serialized log line to the
 * current {@link fileSink}, or drops it when no sink is attached (dev default).
 * A plain `{ write }` object satisfies pino.multistream's stream contract.
 */
const fileStream = {
  write(chunk: string): void {
    fileSink?.write(chunk);
  },
};

/**
 * In test mode, keep the original single-transport logger untouched (tests
 * spy on console via `createLogger`, and the multistream would change the
 * pretty-print behaviour the format tests assert). In non-test mode, build the
 * logger over a multistream: [console, file]. The file stream is a no-op until
 * {@link initFileLogSink} wires a real sink at boot, so console behaviour is
 * identical to before while the file sink is dormant.
 */
export const logger = isTest
  ? pino({ level: LOG_LEVEL, transport })
  : pino(
      { level: LOG_LEVEL },
      pino.multistream([
        { stream: consoleStream, level: LOG_LEVEL as pino.Level },
        { stream: fileStream as NodeJS.WritableStream, level: LOG_LEVEL as pino.Level },
      ]),
    );

/**
 * Attach (or replace) the production file log sink. Called ONCE at boot when a
 * packaged/production signal is present (see boot/services.ts). Idempotent-ish:
 * a second call destroys the previous sink first. Any failure is swallowed and
 * returns `false` — a broken log file must never brick boot (logging is
 * best-effort; the console stream keeps working regardless).
 *
 * @returns the created sink, or `null` if the sink could not be created.
 */
export function initFileLogSink(options: LogFileSinkOptions = {}): LogFileSink | null {
  try {
    if (fileSink) {
      fileSink.destroy();
      fileSink = null;
    }
    fileSink = createLogFileSink(options);
    return fileSink;
  } catch {
    fileSink = null;
    return null;
  }
}

/** Flush + close the file sink (call on app shutdown). No-op if none attached. */
export function closeFileLogSink(): void {
  if (fileSink) {
    fileSink.destroy();
    fileSink = null;
  }
}

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
