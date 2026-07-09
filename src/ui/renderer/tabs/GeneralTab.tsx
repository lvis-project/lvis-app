import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Brain, Cpu, FolderOpen } from "lucide-react";
import type { LvisApi } from "../types.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";

export interface GeneralTabProps {
  api: LvisApi;
}

interface AppInfo {
  version: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  v8Version: string;
  platform: NodeJS.Platform;
  arch: string;
  userDataPath: string;
}

/** Map `process.platform` to a user-friendly label. */
function platformLabel(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

export function GeneralTab({ api }: GeneralTabProps) {
  const { t } = useTranslation();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const info = await api.getAppInfo();
        if (alive) setAppInfo(info);
      } catch {
        /* getAppInfo only errors on IPC failure — non-fatal */
      }
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  const copyDataPath = useCallback(() => {
    if (!appInfo) return;
    void navigator.clipboard?.writeText(appInfo.userDataPath);
  }, [appInfo]);

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("generalTab.pageTitle")}
        description={t("generalTab.pageDescription")}
      />

      {/* ── 시스템 정보 ─────────────────────────────── */}
      <SettingsSection
        title={t("generalTab.systemInfoTitle")}
        description={t("generalTab.systemInfoDescription")}
      >
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3">
            <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("generalTab.osLabel")}</dt>
              <dd className="font-medium">
                {appInfo ? `${platformLabel(appInfo.platform)} · ${appInfo.arch}` : t("generalTab.loading")}
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3">
            <Brain className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("generalTab.appVersionLabel")}</dt>
              <dd className="font-mono text-xs" data-testid="general-tab-app-version">
                {appInfo ? `v${appInfo.version}` : t("generalTab.loading")}
              </dd>
            </div>
          </div>
          <div
            className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3 sm:col-span-2"
            data-testid="general-tab-stack-info"
          >
            <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0 flex-1">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("generalTab.techStackLabel")}</dt>
              <dd className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-4">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground">Electron</span>
                  <span data-testid="general-tab-stack-electron">
                    {appInfo?.electronVersion ? `v${appInfo.electronVersion}` : "—"}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground">Node</span>
                  <span data-testid="general-tab-stack-node">
                    {appInfo?.nodeVersion ? `v${appInfo.nodeVersion}` : "—"}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground">Chromium</span>
                  <span data-testid="general-tab-stack-chrome">
                    {appInfo?.chromeVersion ? `v${appInfo.chromeVersion}` : "—"}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground">V8</span>
                  <span data-testid="general-tab-stack-v8">
                    {appInfo?.v8Version ? `v${appInfo.v8Version}` : "—"}
                  </span>
                </div>
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3 sm:col-span-2">
            <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0 flex-1">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("generalTab.dataPathLabel")}</dt>
              <dd className="flex items-center gap-2">
                <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {appInfo?.userDataPath ?? t("generalTab.loading")}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 px-2 text-[11px]"
                  onClick={copyDataPath}
                  disabled={!appInfo}
                  aria-label={t("generalTab.copyDataPathAriaLabel")}
                >
                  {t("generalTab.copyButton")}
                </Button>
              </dd>
            </div>
          </div>
        </dl>
      </SettingsSection>
    </div>
  );
}
