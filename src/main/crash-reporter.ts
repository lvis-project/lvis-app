/**
 * Production release prep — crash reporting.
 *
 * Two layers:
 *   1. Electron built-in crashReporter — always collects local minidumps to
 *      `~/.lvis/crash-dumps/`. Upload to a remote URL is OFF by default; the
 *      user may enable via settings.telemetry.crashReportingEnabled + a
 *      configurable URL.
 *   2. Optional @sentry/electron integration — loaded via dynamic require()
 *      guard. If the dep is absent OR no DSN is configured, this is a no-op.
 *      DSN may come from `LVIS_SENTRY_DSN` env or `settings.telemetry.sentryDsn`.
 *
 * No secrets are shipped in-code; the user provides DSN / endpoint at runtime.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { TelemetrySettings } from "../data/settings-store.js";

export interface CrashReporterDeps {
  userDataPath: string;
  telemetry: TelemetrySettings;
  crashReporter?: {
    start: (opts: {
      submitURL?: string;
      productName?: string;
      uploadToServer?: boolean;
      ignoreSystemCrashHandler?: boolean;
    }) => void;
  };
  sentryLoader?: () => SentryLike | null;
}

export interface SentryLike {
  init(opts: { dsn: string }): void;
}

export interface CrashReporterHandle {
  dumpDir: string;
  started: boolean;
  sentryActive: boolean;
}

export function startCrashReporter(deps: CrashReporterDeps): CrashReporterHandle {
  const dumpDir = resolve(homedir(), ".lvis", "crash-dumps");
  try {
    mkdirSync(dumpDir, { recursive: true });
  } catch (err) {
    console.warn("[crash-reporter] mkdir dumpDir failed:", (err as Error).message);
  }

  const uploadEnabled =
    deps.telemetry.crashReportingEnabled === true &&
    typeof deps.telemetry.crashReportEndpoint === "string" &&
    deps.telemetry.crashReportEndpoint.length > 0;

  let started = false;
  const reporter = deps.crashReporter ?? loadElectronCrashReporter();
  if (reporter) {
    try {
      reporter.start({
        submitURL: uploadEnabled ? deps.telemetry.crashReportEndpoint : undefined,
        productName: "LVIS",
        uploadToServer: uploadEnabled,
        ignoreSystemCrashHandler: false,
      });
      started = true;
    } catch (err) {
      console.warn("[crash-reporter] start failed:", (err as Error).message);
    }
  }

  const dsn = process.env.LVIS_SENTRY_DSN ?? deps.telemetry.sentryDsn ?? "";
  let sentryActive = false;
  if (dsn) {
    const sentry = (deps.sentryLoader ?? loadSentry)();
    if (sentry) {
      try {
        sentry.init({ dsn });
        sentryActive = true;
      } catch (err) {
        console.warn("[crash-reporter] sentry init failed:", (err as Error).message);
      }
    }
  }

  void deps.userDataPath;
  return { dumpDir, started, sentryActive };
}

function loadElectronCrashReporter(): CrashReporterDeps["crashReporter"] | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("electron").crashReporter;
  } catch {
    return undefined;
  }
}

function loadSentry(): SentryLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@sentry/electron") as SentryLike;
  } catch {
    return null;
  }
}
