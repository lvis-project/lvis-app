/**
 * GeneralTab — 설정 "일반" 화면.
 *
 * Three sections render on a single page:
 *   A. 계정          — vendor + authMode + MEMORY.md 자기소개 미리보기
 *   B. 워크스페이스   — plugin / tool / agent / skill / role counts + 마켓플레이스 상태
 *   C. 시스템        — OS + app version + ~/.lvis/ 경로
 *
 * Counts are aggregated through `useWorkspaceStats` (which only calls
 * existing IPC channels). System metadata comes from the new
 * `lvis:app:info` IPC so the renderer never duplicates the canonical
 * electron `app.getVersion()` / `process.platform` values.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
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
}

interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  userDataPath: string;
}

/** Extract the user's preferred 호칭 from MEMORY.md / user-preferences.md. */
function extractHonorific(userPrefsMd: string): string | null {
  // Match the lines MemorySeedDialog writes: "사용자 호칭: <name>" / "호칭: <name>".
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
      className="flex flex-col items-start gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

export function GeneralTab({ api, onNavigate }: GeneralTabProps) {
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
  const demoEnabled = settings?.features?.demoAutoplayEnabled === true;

  const marketplaceStatus: { dot: string; label: string } = useMemo(() => {
    if (!stats.marketplace.configured) return { dot: "bg-muted-foreground/40", label: "미연결" };
    if (stats.marketplace.online) return { dot: "bg-success", label: "정상" };
    return { dot: "bg-destructive", label: "응답 없음" };
  }, [stats.marketplace.configured, stats.marketplace.online]);

  const lastSyncedLabel = useMemo(() => {
    if (!stats.lastSyncedAt) return "동기화 전";
    const dt = new Date(stats.lastSyncedAt);
    return `마지막 동기화: ${dt.toLocaleTimeString()}`;
  }, [stats.lastSyncedAt]);

  const avatarInitial = (honorific?.slice(0, 1) ?? provider.slice(0, 1) ?? "?").toUpperCase();

  const copyDataPath = useCallback(() => {
    if (!appInfo) return;
    void navigator.clipboard?.writeText(appInfo.userDataPath);
  }, [appInfo]);

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="일반"
        description="계정, 워크스페이스 통계, 시스템 정보를 한눈에 확인합니다"
      />

      {/* ── 계정 ──────────────────────────────────── */}
      <SettingsSection
        title="계정"
        description="현재 LVIS 가 사용 중인 모델 공급자와 사용자 자기소개를 보여줍니다."
        actions={
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onNavigate("llm")}
          >
            모델 설정 →
          </Button>
        }
      >
        <div className="flex items-start gap-4">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/15 text-lg font-semibold text-primary"
            aria-hidden="true"
          >
            {avatarInitial}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-base font-semibold">{honorific ?? "이름 미설정"}</p>
              {provider && (
                <Badge variant="secondary" className="text-[10px] uppercase">
                  {provider}
                </Badge>
              )}
              {authMode === "login" ? (
                <Badge variant="default" className="text-[10px]">
                  로그인 모드
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  API 키 모드
                </Badge>
              )}
              {hasVendorKey && (
                <Badge variant="secondary" className="text-[10px]">
                  키 등록됨
                </Badge>
              )}
              {demoEnabled && (
                <Badge variant="secondary" className="text-[10px]">
                  데모
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground" data-testid="general-tab-intro">
              {intro ?? "자기소개가 등록되어 있지 않습니다. 역할 탭에서 MEMORY.md 를 편집할 수 있습니다."}
            </p>
          </div>
        </div>
      </SettingsSection>

      {/* ── 워크스페이스 통계 ─────────────────────────── */}
      <SettingsSection
        title="워크스페이스"
        description="설치된 플러그인, 도구, 에이전트, 스킬, 역할 개수와 마켓플레이스 상태입니다."
        actions={
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{lastSyncedLabel}</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="워크스페이스 통계 새로고침"
            >
              <RefreshCw className="size-3" aria-hidden={true} />
            </Button>
          </div>
        }
      >
        <div
          role="group"
          aria-label="워크스페이스 통계 카드"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        >
          <StatCard
            label="플러그인"
            count={stats.pluginCount}
            icon={Puzzle}
            onClick={() => onNavigate("plugin-config")}
            loading={loading}
            testId="general-tab-card-plugin"
          />
          <StatCard
            label="도구"
            count={stats.toolCount}
            icon={Wrench}
            onClick={() => onNavigate("plugin-perf")}
            loading={loading}
            testId="general-tab-card-tool"
          />
          <StatCard
            label="에이전트"
            count={stats.agentCount}
            icon={Bot}
            onClick={() => onNavigate("marketplace")}
            loading={loading}
            testId="general-tab-card-agent"
          />
          <StatCard
            label="스킬"
            count={stats.skillCount}
            icon={Sparkles}
            onClick={() => onNavigate("marketplace")}
            loading={loading}
            testId="general-tab-card-skill"
          />
          <StatCard
            label="역할"
            count={stats.roleCount}
            icon={UserCog}
            onClick={() => onNavigate("roles")}
            loading={loading}
            testId="general-tab-card-role"
          />
        </div>

        {/* 마켓플레이스 상태 */}
        <button
          type="button"
          onClick={() => onNavigate("marketplace")}
          className="flex w-full items-center justify-between rounded-md border bg-card px-4 py-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="general-tab-marketplace-status"
        >
          <div className="flex items-center gap-3">
            <Store className="size-4 text-muted-foreground" aria-hidden={true} />
            <div>
              <p className="text-sm font-medium">마켓플레이스</p>
              <p className="text-[11px] text-muted-foreground">
                {stats.marketplace.configured
                  ? "서버 연결 상태를 확인합니다"
                  : "마켓플레이스 서버 URL 이 설정되어 있지 않습니다"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-block size-2.5 rounded-full ${marketplaceStatus.dot}`} aria-hidden={true} />
            <span className="text-sm font-medium">{marketplaceStatus.label}</span>
          </div>
        </button>
      </SettingsSection>

      {/* ── 시스템 정보 ─────────────────────────────── */}
      <SettingsSection
        title="시스템"
        description="실행 중인 운영체제, 앱 버전, 데이터 경로 정보입니다."
      >
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-start gap-3 rounded-md border bg-card/50 p-3">
            <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">운영체제</dt>
              <dd className="font-medium">
                {appInfo ? `${platformLabel(appInfo.platform)} · ${appInfo.arch}` : "확인 중…"}
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border bg-card/50 p-3">
            <Brain className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">앱 버전</dt>
              <dd className="font-mono text-xs" data-testid="general-tab-app-version">
                {appInfo ? `v${appInfo.version}` : "확인 중…"}
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border bg-card/50 p-3 sm:col-span-2">
            <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0 flex-1">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">데이터 경로</dt>
              <dd className="flex items-center gap-2">
                <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {appInfo?.userDataPath ?? "확인 중…"}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 px-2 text-[11px]"
                  onClick={copyDataPath}
                  disabled={!appInfo}
                  aria-label="데이터 경로 복사"
                >
                  복사
                </Button>
              </dd>
            </div>
          </div>
        </dl>
      </SettingsSection>
    </div>
  );
}
