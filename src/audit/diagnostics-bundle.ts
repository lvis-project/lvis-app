/**
 * Diagnostics bundle writer — the SINGLE chokepoint that serializes redacted
 * host state into a support ZIP (#1499 E2).
 *
 * A production build has no console, so a support engineer needs a one-click
 * bundle of: what version/OS is running, a REDACTED settings snapshot, the
 * recent audit trail, the production log files, and crash-dump metadata. This is
 * the ONLY place that ASSEMBLES the bundle, so every free-text byte passes the
 * DLP gate here and cannot be bypassed by a second assembly path. "Chokepoint"
 * refers to bundle *assembly* — it does NOT mean this is the only redactor in
 * the app: the free-text DLP here is layered (BOTH the PII class via
 * redactForLLM AND the credential class via scrubSecretsForLLM), because the PII
 * pass alone misses tokens/keys.
 *
 * DLP layers (all applied HERE, at the chokepoint):
 *   - settings   → {@link pickRedactedSettings}: a DENY-BY-DEFAULT allowlist.
 *                  A key is included ONLY if it is explicitly whitelisted, so a
 *                  newly-added secret field (a fresh apiKey/DSN/token) is absent
 *                  by construction — never leaked because someone forgot to add
 *                  it to a denylist.
 *   - audit      → {@link redactAuditPayload} (home-dir path fields) + a
 *                  DOUBLE-APPLY over input/output: {@link redactForLLM} for the
 *                  PII class (email/phone/SSN/CC) AND {@link scrubSecretsForLLM}
 *                  for the credential class (bearer/`sk-…`/JWT/auth-header/token
 *                  param). See {@link redactBundleText}.
 *   - logs       → per-line DOUBLE-APPLY (same {@link redactBundleText}: PII +
 *                  credential class). The production log file also carries MCP
 *                  stderr (mcp-client pipes it into the app logger); mcp-client's
 *                  own `scrubSecrets` wraps the SAME `scrubSecretsForLLM` SOT, so
 *                  the credential class is covered both there and here.
 *   - crash dumps→ FILENAME + mtime + size metadata only, unless the caller
 *                  opts in via `includeCrashDumps` (settings.diagnostics).
 *
 * Windows ACL note: the bundle file is written to a location the USER picks in
 * a native save dialog, so its on-disk confidentiality is under the user's own
 * control (unlike the 0o600 log files). We deliberately do NOT icacls-lock the
 * output — that would be surprising for a file the user chose to place. The
 * source log files retain their 0o600 / inherited-%USERPROFILE%-ACL posture
 * (log-file-sink.ts docstring). Re-evaluate only if bundles ever gain an
 * auto-export / auto-upload path (they do not today).
 */
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { redactForLLM, redactAuditPayload, scrubSecretsForLLM } from "./dlp-filter.js";
import { lvisHome } from "../shared/lvis-home.js";
import { parseLogFileDate } from "../lib/log-file-sink.js";
import type { AppSettings } from "../data/settings-store.js";
import type { AuditLogger, AuditEntry } from "./audit-logger.js";

/** Bundle schema version — bump on a structural change to the ZIP layout. */
export const DIAGNOSTICS_BUNDLE_SCHEMA_VERSION = 1;

/**
 * Total-size ceiling for the assembled bundle (uncompressed bytes accounted as
 * they are added). When adding a log/crash entry would cross this, the entry is
 * skipped and `manifest.truncated` is set. Guards against a runaway log tree
 * producing a multi-GB "diagnostics" file.
 */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

export interface CrashDumpMeta {
  /** File name only — no directory component (never leaks the userData path). */
  name: string;
  /** ISO 8601 modification time. */
  mtime: string;
  /** Size in bytes. */
  size: number;
}

export interface DiagnosticsBundleManifest {
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  os: { platform: string; arch: string; release: string };
  runtime: { electron: string; node: string; chrome: string };
  /** Which top-level sections were actually written (empty sources are skipped). */
  contents: string[];
  /** Audit/log date window applied, if any. */
  window?: { from?: string; to?: string };
  includeCrashDumps: boolean;
  /** True when MAX_BUNDLE_BYTES was hit and some entries were dropped. */
  truncated: boolean;
}

export interface BuildDiagnosticsBundleOptions {
  settings: AppSettings;
  auditLogger: AuditLogger;
  appVersion: string;
  /** Absolute path to Electron's crash-dumps dir (`<userData>/crash-dumps`). */
  crashDumpsDir: string;
  /** Include raw crash-dump binaries (opt-in). Default false → metadata only. */
  includeCrashDumps?: boolean;
  /** Audit/log date window (inclusive `YYYY-MM-DD`). Defaults to last 7 days. */
  dateFrom?: string;
  dateTo?: string;
  /** Log directory override (tests). Defaults to `~/.lvis/logs`. */
  logsDir?: string;
  /** Total-size ceiling override (tests). */
  maxBytes?: number;
  /** Runtime versions (tests inject; prod reads process.versions). */
  runtime?: { electron: string; node: string; chrome: string };
  /** OS release override (tests). */
  osRelease?: string;
}

/**
 * DENY-BY-DEFAULT redacted settings snapshot. Only the keys explicitly listed
 * here are emitted; everything else — including every current AND future secret
 * field (apiKey, sentryDsn, endpoints, hostResolverMap, vertex creds) — is
 * omitted by construction. This is the security property of the whole bundle:
 * we allowlist safe fields rather than denylist dangerous ones, so forgetting
 * to denylist a new secret cannot leak it.
 */
export function pickRedactedSettings(settings: AppSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // llm — provider/model shape only. NO apiKey, NO hostResolverMap, NO vertex.
  const llm = settings.llm;
  if (llm) {
    const vendors: Record<string, { model?: string; hasBaseUrl: boolean }> = {};
    for (const [vendor, v] of Object.entries(llm.vendors ?? {})) {
      const vv = v as { model?: string; baseUrl?: string };
      vendors[vendor] = {
        model: typeof vv.model === "string" ? vv.model : undefined,
        // Presence flag only — the value could carry an internal hostname.
        hasBaseUrl: typeof vv.baseUrl === "string" && vv.baseUrl.length > 0,
      };
    }
    out.llm = {
      authMode: llm.authMode,
      provider: llm.provider,
      streamSmoothing: llm.streamSmoothing,
      fallbackChain: llm.fallbackChain,
      vendors,
    };
  }

  if (settings.chat) out.chat = { autoCompact: settings.chat.autoCompact };
  if (settings.webSearch) out.webSearch = { provider: settings.webSearch.provider };
  if (settings.marketplace) {
    out.marketplace = {
      backend: settings.marketplace.backend,
      cloudBaseUrl: settings.marketplace.cloudBaseUrl,
    };
  }
  if (settings.privacy) out.privacy = settings.privacy;
  if (settings.updates) out.updates = { autoCheckEnabled: settings.updates.autoCheckEnabled };
  // telemetry — booleans only. NO sentryDsn, NO endpoint, NO crashReportEndpoint.
  if (settings.telemetry) {
    out.telemetry = {
      enabled: settings.telemetry.enabled,
      crashReportingEnabled: settings.telemetry.crashReportingEnabled,
      telemetryPromptAnswered: settings.telemetry.telemetryPromptAnswered,
    };
  }
  if (settings.audit) out.audit = settings.audit;
  if (settings.appearance) {
    out.appearance = {
      bundleId: settings.appearance.bundleId,
      language: settings.appearance.language,
      followSystem: settings.appearance.followSystem,
    };
  }
  if (settings.webView) out.webView = settings.webView;
  if (settings.system) {
    // Whitelist primitive layout/behaviour fields; drop any path-bearing field
    // (pinnedProjectRoots) which could carry a home-dir path.
    const s = settings.system;
    out.system = {
      closeBehavior: s.closeBehavior,
      appMode: s.appMode,
      localApiServer: s.localApiServer,
      launchAtStartup: s.launchAtStartup,
      launchMinimized: s.launchMinimized,
      sidebarActiveTab: s.sidebarActiveTab,
    };
  }
  if (settings.features) out.features = settings.features;
  if (settings.diagnostics) out.diagnostics = settings.diagnostics;
  return out;
}

/** List crash-dump files (metadata only), newest first. Missing dir → []. */
export function listCrashDumps(crashDumpsDir: string): CrashDumpMeta[] {
  let entries: string[];
  try {
    entries = readdirSync(crashDumpsDir);
  } catch {
    return [];
  }
  const metas: CrashDumpMeta[] = [];
  for (const name of entries) {
    // Only real minidump artefacts — skip subdirectories/temp.
    if (!/\.(dmp|dump)$/i.test(name)) continue;
    try {
      const st = statSync(join(crashDumpsDir, name));
      if (!st.isFile()) continue;
      metas.push({ name, mtime: new Date(st.mtimeMs).toISOString(), size: st.size });
    } catch {
      /* unreadable entry — skip, never throw */
    }
  }
  return metas.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** Default inclusive date window: last 7 days → today (UTC). */
function defaultWindow(): { from: string; to: string } {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

/** Log files within [from,to] inclusive, oldest first. Missing dir → []. */
function logFilesInWindow(logsDir: string, from: string, to: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => {
      const d = parseLogFileDate(f);
      return d !== null && d >= from && d <= to;
    })
    .sort();
}

/**
 * Build the diagnostics bundle as an in-memory ZIP Buffer. Pure assembly + DLP;
 * the caller owns the save dialog + disk write (IPC domain). Never throws on a
 * missing/unreadable source — those sections are simply skipped and left out of
 * `manifest.contents`.
 */
export async function buildDiagnosticsBundle(
  opts: BuildDiagnosticsBundleOptions,
): Promise<Buffer> {
  const zip = new AdmZip();
  const maxBytes = opts.maxBytes ?? MAX_BUNDLE_BYTES;
  const includeCrashDumps = opts.includeCrashDumps === true;
  const win = {
    from: opts.dateFrom ?? defaultWindow().from,
    to: opts.dateTo ?? defaultWindow().to,
  };
  const logsDir = opts.logsDir ?? join(lvisHome(), "logs");

  const contents: string[] = [];
  let accountedBytes = 0;
  let truncated = false;

  /** Add an entry unless it would cross the size ceiling. Returns added?. */
  const addEntry = (name: string, body: string | Buffer): boolean => {
    const len = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, "utf-8");
    if (accountedBytes + len > maxBytes) {
      truncated = true;
      return false;
    }
    zip.addFile(name, Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8"));
    accountedBytes += len;
    return true;
  };

  // ── settings-redacted.json (deny-by-default whitelist) ──
  const redactedSettings = pickRedactedSettings(opts.settings);
  if (addEntry("settings-redacted.json", JSON.stringify(redactedSettings, null, 2))) {
    contents.push("settings-redacted.json");
  }

  // ── audit/<date>.jsonl (redactAuditPayload + line redactForLLM) ──
  try {
    const { entries } = await opts.auditLogger.search({
      dateFrom: win.from,
      dateTo: win.to,
      limit: 100_000,
      offset: 0,
    });
    if (entries.length > 0) {
      const lines = entries.map((e) => JSON.stringify(redactAuditEntry(e)));
      if (addEntry(`audit/${win.from}_${win.to}.jsonl`, lines.join("\n") + "\n")) {
        contents.push("audit");
      }
    }
  } catch {
    /* audit unreadable — skip section */
  }

  // ── logs/ (line-level redactForLLM; covers MCP stderr) ──
  const logFiles = logFilesInWindow(logsDir, win.from, win.to);
  let anyLog = false;
  for (const fname of logFiles) {
    let raw: string;
    try {
      raw = await readFile(join(logsDir, fname), "utf-8");
    } catch {
      continue;
    }
    const redacted = raw
      .split("\n")
      .map((line) => (line.length > 0 ? redactBundleText(line) : line))
      .join("\n");
    if (addEntry(`logs/${fname}`, redacted)) anyLog = true;
  }
  if (anyLog) contents.push("logs");

  // ── crash-dumps: metadata always; binaries opt-in ──
  const crashMetas = listCrashDumps(opts.crashDumpsDir);
  if (crashMetas.length > 0) {
    if (addEntry("crash-dumps/index.json", JSON.stringify(crashMetas, null, 2))) {
      contents.push("crash-dumps");
    }
    if (includeCrashDumps) {
      for (const meta of crashMetas) {
        try {
          const buf = await readFile(join(opts.crashDumpsDir, meta.name));
          addEntry(`crash-dumps/${meta.name}`, buf);
        } catch {
          /* unreadable dump — skip */
        }
      }
    }
  }

  // ── manifest.json (added last so it reflects the final contents/truncated) ──
  const manifest: DiagnosticsBundleManifest = {
    schemaVersion: DIAGNOSTICS_BUNDLE_SCHEMA_VERSION,
    appVersion: opts.appVersion,
    createdAt: new Date().toISOString(),
    os: {
      platform: process.platform,
      arch: process.arch,
      release: opts.osRelease ?? "",
    },
    runtime: opts.runtime ?? {
      electron: process.versions.electron ?? "",
      node: process.versions.node ?? "",
      chrome: process.versions.chrome ?? "",
    },
    contents,
    window: win,
    includeCrashDumps,
    truncated,
  };
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));

  // Async (thread-pool) deflate — adm-zip's toBufferPromise() compresses each
  // entry via zlib's async path (getCompressedDataAsync), so the main process is
  // NOT blocked while a large log tree is deflated up to MAX_BUNDLE_BYTES (50 MB).
  // The synchronous zip.toBuffer() would stall the UI for the whole compression
  // (#1499 E2 cluster-review architect MINOR).
  return zip.toBufferPromise();
}

/**
 * Redact one audit entry for the bundle: path fields via redactAuditPayload,
 * then the free-text `input`/`output` via line-level redactForLLM (email/phone/
 * SSN/CC). Returns a plain object safe to serialize.
 */
function redactAuditEntry(entry: AuditEntry): Record<string, unknown> {
  const base = redactAuditPayload(entry) as Record<string, unknown>;
  const out = { ...base };
  if (typeof out.input === "string") out.input = redactBundleText(out.input);
  if (typeof out.output === "string") out.output = redactBundleText(out.output);
  return out;
}

/**
 * DOUBLE-APPLY DLP for a single free-text span written into the bundle: the PII
 * class via {@link redactForLLM} (email/phone/SSN/CC) AND the credential class
 * via {@link scrubSecretsForLLM} (bearer/`sk-…`/JWT/auth-header/token-param).
 * {@link redactForLLM} alone misses secrets, so both must run over every log
 * line and audit input/output — this is the single chokepoint where both DLP
 * classes are enforced (#1499 E2 cluster-review security MAJOR M1).
 */
function redactBundleText(text: string): string {
  return scrubSecretsForLLM(redactForLLM(text).redacted);
}
