



import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import {
  Brain,
  Puzzle,
  Wrench,
  Bot,
  Sparkles,
  UserCog,
  Store,
  Cpu,
  FolderOpen,
  RefreshCw,
  LogOut,
  KeyRound,
} from "lucide-react";
import type { LvisApi, AppSettings } from "../types.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useWorkspaceStats } from "../hooks/use-workspace-stats.js";
import type { SettingsTab } from "../../../shared/settings-tabs.js";

export interface GeneralTabProps {
  api: LvisApi;
  /**
   * Navigate the sibling sidebar to a different tab. Stat cards use this
   * to deep-link into the detail tab when the user clicks a count card.
   */
  onNavigate: (tab: SettingsTab) => void;



  onLogout?: () => void;
  onReactivateDemo?: () => void;
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


function extractHonorific(userPrefsMd: string): string | null {

  const m = userPrefsMd.match(/(?:사용자\s*)?호칭\s*[:：]\s*(.+)/);
  return m ? m[1].trim().split(/\s+/)[0] : null;
}

/** First non-metadata line of MEMORY.md as a short preview. */
function extractIntroPreview(userPrefsMd: string): string | null {
  const lines = userPrefsMd
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("-"));
  if (lines.length === 0) return null;
  const first = lines[0];
  return first.length > 120 ? first.slice(0, 117) + "…" : first;
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

interface StatCardProps {
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  onClick: () => void;
  loading: boolean;
  testId?: string;
}

function StatCard({ label, count, icon: Icon, onClick, loading, testId }: StatCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex flex-col items-start gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/(--opacity-strong) hover:bg-accent/(--opacity-medium) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" aria-hidden={true} />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <span className="text-2xl font-semibold tabular-nums text-foreground">
        {loading ? "–" : count}
      </span>
    </button>
  );
}

export function GeneralTab({
  api,
  onNavigate,
  onLogout,
  onReactivateDemo,
}: GeneralTabProps) {
  const { t, locale } = useTranslation();
  const { stats, loading, refresh } = useWorkspaceStats(api);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [userPrefs, setUserPrefs] = useState<string>("");
  const [hasVendorKey, setHasVendorKey] = useState<boolean>(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  // Initial fetch of (settings + vendor key flag + MEMORY.md + app info).
  // Each Promise is independent — `Promise.allSettled` keeps a single
  // failing slice from blanking the whole tab.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [settingsRes, prefsRes, appInfoRes] = await Promise.allSettled([
        api.getSettings(),
        api.memoryGetUserPrefs(),
        api.getAppInfo(),
      ]);
      if (!alive) return;
      if (settingsRes.status === "fulfilled") {
        setSettings(settingsRes.value);
        try {
          const has = await api.hasApiKey(settingsRes.value.llm.provider);
          if (alive) setHasVendorKey(has);
        } catch {
          /* hasApiKey only errors on IPC failure — non-fatal */
        }
      }
      if (prefsRes.status === "fulfilled") setUserPrefs(prefsRes.value);
      if (appInfoRes.status === "fulfilled") setAppInfo(appInfoRes.value);
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  // Listen for cross-window settings updates so vendor/authMode changes
  // flow into the card without a manual refresh.
  useEffect(() => {
    const unsub = api.onSettingsUpdated((next) => setSettings(next));
    return unsub;
  }, [api]);

  const honorific = useMemo(() => extractHonorific(userPrefs), [userPrefs]);
  const intro = useMemo(() => extractIntroPreview(userPrefs), [userPrefs]);

  const provider = settings?.llm.provider ?? "";
  const authMode = settings?.llm.authMode ?? "manual";

  const marketplaceStatus: { dot: string; label: string } = useMemo(() => {
    if (!stats.marketplace.configured) return { dot: "bg-muted-foreground/(--opacity-medium)", label: t("generalTab.marketplaceNotConnected") };
    if (stats.marketplace.online) return { dot: "bg-success", label: t("generalTab.marketplaceOnline") };
    return { dot: "bg-destructive", label: t("generalTab.marketplaceNoResponse") };
  }, [stats.marketplace.configured, stats.marketplace.online, locale, t]);

  const lastSyncedLabel = useMemo(() => {
    if (!stats.lastSyncedAt) return t("generalTab.notYetSynced");
    const dt = new Date(stats.lastSyncedAt);
    return t("generalTab.lastSynced", { time: dt.toLocaleTimeString() });
  }, [stats.lastSyncedAt, locale, t]);

  const avatarInitial = (honorific?.slice(0, 1) ?? provider.slice(0, 1) ?? "?").toUpperCase();

  const copyDataPath = useCallback(() => {
    if (!appInfo) return;
    void navigator.clipboard?.writeText(appInfo.userDataPath);
  }, [appInfo]);


  //


  //


  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const performLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      const activeVendor = settings?.llm.provider ?? "";
      if (activeVendor.length > 0) {
        try {
          await api.deleteApiKey(activeVendor);
        } catch {
          // Logout is a credential-deletion operation. If the active vendor
          // secret remains, resetting onboarding would create a false logged-
          // out state while privileged credentials are still present.
          setLogoutError(t("generalTab.errorDeleteApiKey"));
          return;
        }
      }
      const cleared = await api.demo.clearDemo();
      if (!cleared.ok) {
        setLogoutError(t("generalTab.errorDeleteDemoCredentials"));
        return;
      }
      // Reset authMode to "manual" so the LLM tab immediately shows the
      // full manual form after logout — the login session is gone, so
      // keeping authMode==="login" would leave the form stuck in disabled
      // state until the user toggled it manually.
      await api.updateSettings({ llm: { authMode: "manual" }, features: { onboardingCompleted: false } });
      setLogoutConfirmOpen(false);
      onLogout?.();
    } catch {
      setLogoutError(t("generalTab.errorLogout"));
    } finally {
      setLoggingOut(false);
    }
  }, [api, loggingOut, onLogout, settings?.llm.provider]);

  const handleLogoutClick = useCallback(() => {
    setLogoutError(null);
    setLogoutConfirmOpen(true);
  }, []);

  const handleReactivateClick = useCallback(() => {
    onReactivateDemo?.();
  }, [onReactivateDemo]);

  // Default mirrors `DEFAULT_SETTINGS.system.closeBehavior` so the radio
  // group renders the correct selection even before `settings` arrives.
  const closeBehavior = settings?.system?.closeBehavior ?? "hide-to-tray";
  const onCloseBehaviorChange = useCallback(
    (value: string) => {
      if (value !== "hide-to-tray" && value !== "quit") return;
      void api.updateSettings({ system: { closeBehavior: value } });
    },
    [api],
  );

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("generalTab.pageTitle")}
        description={t("generalTab.pageDescription")}
      />


      <SettingsSection
        title={t("generalTab.accountTitle")}
        description={t("generalTab.accountDescription")}
        actions={
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onNavigate("llm")}
          >
            {t("generalTab.modelSettingsButton")}
          </Button>
        }
      >
        <div className="flex items-start gap-4">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/(--opacity-soft) text-lg font-semibold text-primary"
            aria-hidden="true"
          >
            {avatarInitial}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-base font-semibold">{honorific ?? t("generalTab.nameNotSet")}</p>
              {provider && (
                <Badge variant="secondary" className="text-[10px] uppercase">
                  {provider}
                </Badge>
              )}
              {authMode === "login" ? (
                <Badge variant="default" className="text-[10px]">
                  {t("generalTab.loginModeBadge")}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  {t("generalTab.apiKeyModeBadge")}
                </Badge>
              )}
              {hasVendorKey && (
                <Badge variant="secondary" className="text-[10px]">
                  {t("generalTab.keyRegisteredBadge")}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground" data-testid="general-tab-intro">
              {intro ?? t("generalTab.introNotSet")}
            </p>
          </div>
        </div>
      </SettingsSection>




      <SettingsSection
        title={t("generalTab.authManagementTitle")}
        description={t("generalTab.authManagementDescription")}
      >
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            className="justify-start"
            onClick={handleReactivateClick}
            disabled={!onReactivateDemo}
            data-testid="general-tab-reactivate-demo"
          >
            <KeyRound className="mr-2 size-4" aria-hidden={true} />
            {t("generalTab.reactivateDemoButton")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="justify-start"
            onClick={handleLogoutClick}
            disabled={!onLogout || loggingOut}
            data-testid="general-tab-logout"
          >
            <LogOut className="mr-2 size-4" aria-hidden={true} />
            {t("generalTab.logoutButton")}
          </Button>
        </div>
      </SettingsSection>

      <Dialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
        <DialogContent size="sm" data-testid="general-tab-logout-confirm">
          <DialogHeader>
            <DialogTitle>{t("generalTab.logoutConfirmTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("generalTab.logoutConfirmBody")}
          </p>
          {logoutError && (
            <p
              role="alert"
              className="rounded-md bg-destructive/(--opacity-subtle) px-3 py-2 text-sm text-destructive"
              data-testid="general-tab-logout-error"
            >
              {logoutError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLogoutConfirmOpen(false)}
              disabled={loggingOut}
            >
              {t("generalTab.cancelButton")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void performLogout()}
              disabled={loggingOut}
              data-testid="general-tab-logout-confirm-button"
            >
              {loggingOut ? t("generalTab.processingLabel") : t("generalTab.logoutConfirmButton")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>


      <SettingsSection
        title={t("generalTab.workspaceTitle")}
        description={t("generalTab.workspaceDescription")}
        actions={
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{lastSyncedLabel}</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label={t("generalTab.refreshStatsAriaLabel")}
            >
              <RefreshCw className="size-3" aria-hidden={true} />
            </Button>
          </div>
        }
      >
        <div
          role="group"
          aria-label={t("generalTab.statsGroupAriaLabel")}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        >
          <StatCard
            label={t("generalTab.statPlugins")}
            count={stats.pluginCount}
            icon={Puzzle}
            onClick={() => onNavigate("plugin-config")}
            loading={loading}
            testId="general-tab-card-plugin"
          />
          <StatCard
            label={t("generalTab.statTools")}
            count={stats.toolCount}
            icon={Wrench}
            onClick={() => onNavigate("plugin-perf")}
            loading={loading}
            testId="general-tab-card-tool"
          />
          <StatCard
            label={t("generalTab.statAgents")}
            count={stats.agentCount}
            icon={Bot}
            onClick={() => onNavigate("marketplace")}
            loading={loading}
            testId="general-tab-card-agent"
          />
          <StatCard
            label={t("generalTab.statSkills")}
            count={stats.skillCount}
            icon={Sparkles}
            onClick={() => onNavigate("marketplace")}
            loading={loading}
            testId="general-tab-card-skill"
          />
          <StatCard
            label={t("generalTab.statRoles")}
            count={stats.roleCount}
            icon={UserCog}
            onClick={() => onNavigate("roles")}
            loading={loading}
            testId="general-tab-card-role"
          />
        </div>


        <button
          type="button"
          onClick={() => onNavigate("marketplace")}
          className="flex w-full items-center justify-between rounded-md border bg-card px-4 py-3 text-left transition-colors hover:border-primary/(--opacity-strong) hover:bg-accent/(--opacity-medium) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="general-tab-marketplace-status"
        >
          <div className="flex items-center gap-3">
            <Store className="size-4 text-muted-foreground" aria-hidden={true} />
            <div>
              <p className="text-sm font-medium">{t("generalTab.marketplaceLabel")}</p>
              <p className="text-[11px] text-muted-foreground">
                {stats.marketplace.configured
                  ? t("generalTab.marketplaceConnectedHint")
                  : t("generalTab.marketplaceNotConfigured")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-block size-2.5 rounded-full ${marketplaceStatus.dot}`} aria-hidden={true} />
            <span className="text-sm font-medium">{marketplaceStatus.label}</span>
          </div>
        </button>
      </SettingsSection>

      {/* ── 시스템 동작 ─────────────────────────────── */}
      <SettingsSection
        title={t("generalTab.systemBehaviorTitle")}
        description={t("generalTab.systemBehaviorDescription")}
      >
        <RadioGroup
          value={closeBehavior}
          onValueChange={onCloseBehaviorChange}
          className="gap-3"
        >
          <div className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3">
            <RadioGroupItem value="hide-to-tray" id="close-hide-to-tray" className="mt-0.5" />
            <Label htmlFor="close-hide-to-tray" className="cursor-pointer">
              <div className="font-medium">{t("generalTab.hideToTrayLabel")}</div>
              <div className="text-xs text-muted-foreground">
                {t("generalTab.hideToTrayDescription")}
              </div>
            </Label>
          </div>
          <div className="flex items-start gap-3 rounded-md border bg-card/(--opacity-half) p-3">
            <RadioGroupItem value="quit" id="close-quit" className="mt-0.5" />
            <Label htmlFor="close-quit" className="cursor-pointer">
              <div className="font-medium">{t("generalTab.quitLabel")}</div>
              <div className="text-xs text-muted-foreground">
                {t("generalTab.quitDescription")}
              </div>
            </Label>
          </div>
        </RadioGroup>
      </SettingsSection>

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
