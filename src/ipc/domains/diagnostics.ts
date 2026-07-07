/**
 * Diagnostics domain IPC handlers (#1499 E2).
 * Covers: lvis:diagnostics:export, lvis:diagnostics:crash-list, lvis:logs:tail.
 *
 * ALL INTERNAL — none appear in PUBLIC_CHANNELS, so an external origin
 * (local-api / cli / plugin frame) can never reach them (fail-closed default).
 * Each handler additionally calls validateHostRendererSender (NOT the base
 * validateSender) — these channels expose host-wide state (settings snapshot,
 * production logs, crash metadata), so a plugin-ui-shell frame is rejected even
 * though it is also a file:// origin (#1499 E2 cluster-review security m1). On
 * rejection each emits an auditUnauthorized warn row + returns UNAUTHORIZED_FRAME.
 *
 * IPC error convention: return codes are kebab-case English; the renderer maps
 * them to Korean (see AuditTab diagnostics section).
 */
import { ipcMain, dialog } from "electron";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHANNELS } from "../../contract/app-contract.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import {
  buildDiagnosticsBundle,
  listCrashDumps,
  type CrashDumpMeta,
} from "../../audit/diagnostics-bundle.js";
import { redactForLLM, redactFsPath, scrubSecretsForLLM } from "../../audit/dlp-filter.js";
import { parseLogFileDate } from "../../lib/log-file-sink.js";
import { getLvisAppVersion } from "../../shared/app-version.js";
import { lvisHome } from "../../shared/lvis-home.js";
import { createLogger } from "../../lib/logger.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("ipc-diagnostics");

/** Max lines `lvis:logs:tail` will ever return (clamps a hostile large N). */
const MAX_TAIL_LINES = 2000;
/** Default tail size when the caller passes a non-number. */
const DEFAULT_TAIL_LINES = 200;

/** Recognised production log levels for the tail viewer filter. */
type LogLevelFilter = "all" | "error" | "warn" | "info" | "debug";
const VALID_LEVELS: readonly LogLevelFilter[] = ["all", "error", "warn", "info", "debug"];

/** pino numeric level → name (matches pino's default level map). */
const PINO_LEVEL_NAME: Record<number, LogLevelFilter | "trace" | "fatal"> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

/** Absolute path to Electron's crash-dumps dir (`<userData>/crash-dumps`). */
async function crashDumpsDir(): Promise<string> {
  const { app } = await import("electron");
  return resolve(app.getPath("userData"), "crash-dumps");
}

/**
 * Read the last `lines` log lines from the most-recent log files, redacting each
 * with PII + credential DLP and applying the optional level filter. Newest file first;
 * reads only enough files to satisfy `lines`.
 *
 * KNOWN LIMITATION (accepted, #1499 E2 cluster-review NIT): this loads each
 * needed file fully into memory before slicing to the tail. Files are bounded by
 * the sink's LOG_MAX_BYTES (10 MB/file) and we stop reading once `lines` is
 * satisfied, so worst-case memory is small and O(files-needed). A streaming
 * reverse-read was judged not worth the complexity at this bound; revisit only
 * if per-file caps grow.
 */
async function tailLogs(lines: number, level: LogLevelFilter): Promise<string[]> {
  const dir = join(lvisHome(), "logs");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => parseLogFileDate(f) !== null).sort();
  } catch {
    return [];
  }
  const collected: string[] = [];
  // Walk newest → oldest, prepending, until we have enough lines.
  for (let i = files.length - 1; i >= 0 && collected.length < lines; i--) {
    let raw: string;
    try {
      raw = await readFile(join(dir, files[i]), "utf-8");
    } catch {
      continue;
    }
    const fileLines = raw.split("\n").filter((l) => l.length > 0);
    collected.unshift(...fileLines);
  }
  const filtered = level === "all" ? collected : collected.filter((l) => lineMatchesLevel(l, level));
  const tail = filtered.slice(-lines);
  return tail.map((l) => scrubSecretsForLLM(redactForLLM(l).redacted));
}

/** Does a (JSON or pretty) log line match the requested level? */
function lineMatchesLevel(line: string, level: LogLevelFilter): boolean {
  try {
    const obj = JSON.parse(line) as { level?: number | string };
    const name =
      typeof obj.level === "number"
        ? PINO_LEVEL_NAME[obj.level]
        : typeof obj.level === "string"
          ? obj.level
          : undefined;
    return name === level;
  } catch {
    // Pretty (dev) lines aren't JSON — match on an uppercased level token.
    return line.toUpperCase().includes(level.toUpperCase());
  }
}

export function registerDiagnosticsHandlers(deps: IpcDeps): void {
  const { auditLogger, settingsService, getMainWindow } = deps;

  // ── lvis:diagnostics:export ── build redacted bundle → save dialog → write ──
  ipcMain.handle(
    CHANNELS.diagnostics.export,
    async (e, opts?: { dateFrom?: string; dateTo?: string; includeCrashDumps?: boolean }) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.diagnostics.export, e);
        return UNAUTHORIZED_FRAME;
      }
      try {
        const settings = settingsService.getAll();
        // Persisted setting is AUTHORITATIVE; the renderer arg may only NARROW,
        // never widen (#1499 E2 cluster-review security MAJOR M2). Crash dumps
        // are only ever included when the persisted opt-in is true AND the caller
        // did not explicitly opt out — a renderer that sends `true` can never
        // force-include dumps the user's setting has disabled.
        const includeCrashDumps =
          settings.diagnostics.includeCrashDumps === true && opts?.includeCrashDumps !== false;
        const buffer = await buildDiagnosticsBundle({
          settings,
          auditLogger,
          appVersion: getLvisAppVersion(),
          crashDumpsDir: await crashDumpsDir(),
          includeCrashDumps,
          dateFrom: opts?.dateFrom,
          dateTo: opts?.dateTo,
          osRelease: (await import("node:os")).release(),
        });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const dialogOptions = {
          // User-facing dialog copy — Korean per IPC/UI language convention.
          title: "진단 번들 저장",
          defaultPath: `lvis-diagnostics-${stamp}.zip`,
          filters: [{ name: "ZIP", extensions: ["zip"] }],
        };
        const win = getMainWindow();
        const res = win
          ? await dialog.showSaveDialog(win, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);
        if (res.canceled || !res.filePath) return { ok: false as const, canceled: true as const };

        const { writeFile } = await import("node:fs/promises");
        await writeFile(res.filePath, buffer);
        // Forensic record of the export (#1499 E2 cluster-review security m2):
        // a diagnostics bundle is a sanctioned exfiltration of redacted host
        // state, so log WHO exported WHAT — the effective includeCrashDumps
        // (post-M2 narrowing), the date window, byte size, and the destination
        // path (redactFsPath strips the home dir / username).
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "diagnostics-export",
          type: "diagnostics-export",
          input: JSON.stringify({
            includeCrashDumps,
            dateFrom: opts?.dateFrom,
            dateTo: opts?.dateTo,
            bytes: buffer.length,
            path: redactFsPath(res.filePath),
          }),
        });
        return { ok: true as const, path: res.filePath, bytes: buffer.length };
      } catch (err) {
        log.warn({ err }, "diagnostics export failed");
        return { ok: false as const, error: "export-failed" as const };
      }
    },
  );

  // ── lvis:diagnostics:crash-list ── crash-dump metadata (filename/time/size) ──
  ipcMain.handle(CHANNELS.diagnostics.crashList, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.diagnostics.crashList, e);
      return UNAUTHORIZED_FRAME;
    }
    try {
      const dumps: CrashDumpMeta[] = listCrashDumps(await crashDumpsDir());
      return { ok: true as const, dumps };
    } catch (err) {
      log.warn({ err }, "crash-list failed");
      return { ok: false as const, error: "crash-list-failed" as const };
    }
  });

  // ── lvis:logs:tail ── recent N redacted log lines, optional level filter ──
  ipcMain.handle(
    CHANNELS.logs.tail,
    async (e, args?: { lines?: number; level?: string }) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.logs.tail, e);
        return UNAUTHORIZED_FRAME;
      }
      try {
        const rawLines = typeof args?.lines === "number" ? args.lines : DEFAULT_TAIL_LINES;
        const lines = Math.min(MAX_TAIL_LINES, Math.max(1, Math.floor(rawLines)));
        const level: LogLevelFilter =
          typeof args?.level === "string" && (VALID_LEVELS as readonly string[]).includes(args.level)
            ? (args.level as LogLevelFilter)
            : "all";
        const out = await tailLogs(lines, level);
        return { ok: true as const, lines: out };
      } catch (err) {
        log.warn({ err }, "logs tail failed");
        return { ok: false as const, error: "logs-tail-failed" as const };
      }
    },
  );
}
