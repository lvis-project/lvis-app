/**
 * Diagnostics surface (#1499 E2) — rendered at the bottom of the Audit tab.
 * Three sub-sections:
 *   1. Bundle export — build a redacted diagnostics ZIP (+ includeCrashDumps).
 *   2. Log tail viewer — recent redacted log lines with a level filter.
 *   3. Crash list — crash-dump metadata (filename / time / size).
 *
 * IPC error codes are kebab-case English; this component maps them to Korean
 * (localized) strings per the LVIS IPC/UI language convention.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatIpcError } from "../format-ipc-error.js";

interface CrashDumpMeta {
  name: string;
  mtime: string;
  size: number;
}

type ExportResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; canceled: true }
  | { ok: false; error: string };
type CrashListResult = { ok: true; dumps: CrashDumpMeta[] } | { ok: false; error: string };
type LogsTailResult = { ok: true; lines: string[] } | { ok: false; error: string };

interface DiagnosticsApi {
  diagnostics: {
    export: (opts?: {
      dateFrom?: string;
      dateTo?: string;
      includeCrashDumps?: boolean;
    }) => Promise<ExportResult>;
    crashList: () => Promise<CrashListResult>;
  };
  logs: {
    tail: (args?: { lines?: number; level?: string }) => Promise<LogsTailResult>;
  };
  getSettings: () => Promise<{ diagnostics?: { includeCrashDumps?: boolean } } | null | undefined>;
  updateSettings: (partial: {
    diagnostics?: { includeCrashDumps?: boolean };
  }) => Promise<unknown>;
}

function api(): DiagnosticsApi {
  return (window as unknown as { lvisApi: DiagnosticsApi }).lvisApi;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const LOG_LEVELS = ["all", "error", "warn", "info", "debug"] as const;

interface DiagnosticsSectionProps {
  defaultDateFrom: string;
  defaultDateTo: string;
}

export function DiagnosticsSection({ defaultDateFrom, defaultDateTo }: DiagnosticsSectionProps) {
  const { t } = useTranslation();

  // ── bundle export state ──
  const [includeCrashDumps, setIncludeCrashDumps] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);

  // ── log tail state ──
  const [logLevel, setLogLevel] = useState<string>("all");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logErr, setLogErr] = useState<string | null>(null);

  // ── crash list state ──
  const [crashes, setCrashes] = useState<CrashDumpMeta[]>([]);
  const [crashErr, setCrashErr] = useState<string | null>(null);

  /**
   * Map a kebab-case IPC error code to a localized string via the canonical
   * `formatIpcError` SOT (COMMON_IPC_ERROR_MESSAGES) — the same mapper every
   * other tab uses, so the diagnostics codes cannot drift from the shared set.
   */
  const mapError = useCallback((code: string): string => formatIpcError(code, undefined), []);

  /**
   * Toggle the crash-dump opt-in. The persisted setting is the AUTHORITATIVE
   * SOT for the export handler (which only NARROWS by the renderer arg, never
   * widens — security M2), so save the patch FIRST, then reflect it locally.
   * Without this the checkbox was cosmetic — the handler always sent a defined
   * boolean, so the persisted setting never governed (critic M1).
   */
  const handleToggleCrashDumps = useCallback(
    async (next: boolean) => {
      setIncludeCrashDumps(next);
      try {
        await api().updateSettings({ diagnostics: { includeCrashDumps: next } });
      } catch {
        /* best-effort persist — export still narrows against the stored value */
      }
    },
    [],
  );

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportMsg(null);
    setExportErr(null);
    try {
      const res = await api().diagnostics.export({
        dateFrom: defaultDateFrom || undefined,
        dateTo: defaultDateTo || undefined,
        includeCrashDumps,
      });
      if (res.ok) {
        setExportMsg(t("auditTab.bundleExportSuccess", { bytes: humanBytes(res.bytes) }));
      } else if ("canceled" in res && res.canceled) {
        setExportMsg(t("auditTab.bundleExportCanceled"));
      } else {
        setExportErr(mapError((res as { error: string }).error));
      }
    } catch {
      setExportErr(t("auditTab.errExportFailed"));
    } finally {
      setExporting(false);
    }
  }, [defaultDateFrom, defaultDateTo, includeCrashDumps, mapError, t]);

  const refreshLogs = useCallback(async () => {
    setLogErr(null);
    try {
      const res = await api().logs.tail({ lines: 200, level: logLevel });
      if (res.ok) setLogLines(res.lines);
      else setLogErr(mapError(res.error));
    } catch {
      setLogErr(t("auditTab.errLogsTailFailed"));
    }
  }, [logLevel, mapError, t]);

  const refreshCrashes = useCallback(async () => {
    setCrashErr(null);
    try {
      const res = await api().diagnostics.crashList();
      if (res.ok) setCrashes(res.dumps);
      else setCrashErr(mapError(res.error));
    } catch {
      setCrashErr(t("auditTab.errCrashListFailed"));
    }
  }, [mapError, t]);

  useEffect(() => {
    void refreshLogs();
    void refreshCrashes();
    // Seed the checkbox from the persisted setting so it reflects the true SOT
    // the export handler reads, not a hardcoded default (critic M1).
    void (async () => {
      try {
        const settings = await api().getSettings();
        if (typeof settings?.diagnostics?.includeCrashDumps === "boolean") {
          setIncludeCrashDumps(settings.diagnostics.includeCrashDumps);
        }
      } catch {
        /* fall back to the default-false initial state */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {/* ── Bundle export ── */}
      <SettingsSection title={t("auditTab.bundleSectionTitle")}>
        <p className="text-[11px] text-muted-foreground">{t("auditTab.bundleSectionDesc")}</p>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeCrashDumps}
            onChange={(e) => void handleToggleCrashDumps(e.target.checked)}
          />
          {t("auditTab.bundleIncludeCrashDumps")}
        </label>
        {includeCrashDumps && (
          <p className="text-[11px] text-warning">{t("auditTab.bundleCrashDumpWarning")}</p>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-8" onClick={() => void handleExport()} disabled={exporting}>
            {exporting ? t("auditTab.bundleExporting") : t("auditTab.bundleExportButton")}
          </Button>
          {exportMsg && <span className="text-[11px] text-muted-foreground">{exportMsg}</span>}
        </div>
        {exportErr && (
          <div className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive">
            {exportErr}
          </div>
        )}
      </SettingsSection>

      {/* ── Log tail viewer ── */}
      <SettingsSection
        title={t("auditTab.logSectionTitle")}
        actions={
          <div className="flex items-center gap-2">
            <NativeSelect
              size="sm"
              className="w-28"
              value={logLevel}
              onChange={(e) => setLogLevel(e.target.value)}
            >
              <NativeSelectOption value="all">{t("auditTab.logLevelAll")}</NativeSelectOption>
              {LOG_LEVELS.filter((l) => l !== "all").map((l) => (
                <NativeSelectOption key={l} value={l}>
                  {l}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button size="sm" className="h-8" variant="outline" onClick={() => void refreshLogs()}>
              {t("auditTab.logRefresh")}
            </Button>
          </div>
        }
      >
        {logErr && (
          <div className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive">
            {logErr}
          </div>
        )}
        {logLines.length === 0 && !logErr ? (
          <p className="py-3 text-center text-xs text-muted-foreground italic">
            {t("auditTab.logEmpty")}
          </p>
        ) : (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/(--opacity-medium) p-2 text-[10px] font-mono">
            {logLines.join("\n")}
          </pre>
        )}
      </SettingsSection>

      {/* ── Crash list ── */}
      <SettingsSection
        title={t("auditTab.crashSectionTitle")}
        actions={
          <Button size="sm" className="h-8" variant="outline" onClick={() => void refreshCrashes()}>
            {t("auditTab.logRefresh")}
          </Button>
        }
      >
        {crashErr && (
          <div className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive">
            {crashErr}
          </div>
        )}
        {crashes.length === 0 && !crashErr ? (
          <p className="py-3 text-center text-xs text-muted-foreground italic">
            {t("auditTab.crashEmpty")}
          </p>
        ) : (
          <div className="rounded-md border text-xs">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted/(--opacity-medium)">
                  <th className="px-3 py-2 text-left font-medium">{t("auditTab.crashColName")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("auditTab.crashColTime")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("auditTab.crashColSize")}</th>
                </tr>
              </thead>
              <tbody>
                {crashes.map((c) => (
                  <tr key={c.name} className="border-b last:border-0">
                    <td className="px-3 py-1.5 font-mono text-[10px]">{c.name}</td>
                    <td className="px-3 py-1.5 text-muted-foreground font-mono text-[10px] whitespace-nowrap">
                      {c.mtime.slice(0, 19).replace("T", " ")}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{humanBytes(c.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
    </>
  );
}
