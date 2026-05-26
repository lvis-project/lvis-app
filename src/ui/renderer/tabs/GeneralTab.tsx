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
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import { Switch } from "../../../components/ui/switch.js";
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
  /**
   * 2026-05-20 — 로그아웃 / 데모 자격증명 재입력 surfaces. host App.tsx 가
   * `onLogout` 으로 onboarding chain reducer 에 `logout-reset` 을 dispatch
   * 하고, `onReactivateDemo` 로 settings dialog 를 닫은 뒤 LoginModal 의
   * activation page 를 직접 mount 한다. 두 callback 은 *optional* 이라
   * 기존 호출 사이트 (SettingsContent unit test 등) 가 깨지지 않는다.
   */
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

export function GeneralTab({
  api,
  onNavigate,
  onLogout,
  onReactivateDemo,
}: GeneralTabProps) {
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
  const hideToolFailures = settings?.features?.hideToolFailures === true;

  // Demo-only display preference — persisted immediately. The cross-window
  // `onSettingsUpdated` broadcast (subscribed above) flows the new value back
  // into `settings`, so the Switch reflects the saved state without a manual
  // refresh and the chat timeline re-renders live.
  const onToggleHideToolFailures = useCallback(
    (next: boolean) => {
      void api.updateSettings({ features: { hideToolFailures: next } });
    },
    [api],
  );

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

  // 2026-05-20 — 로그아웃 / 데모 자격증명 재입력 surfaces.
  //
  // 로그아웃 흐름 (Deliverable 1):
  //   1. 사용자 confirm dialog 동의 →
  //   2. `lvis:settings:delete-api-key` 로 active vendor 의 secret 삭제
  //      (다른 vendor key 는 보존 — multi-vendor 사용자가 잃을 자산 없음)
  //   3. `lvis:demo:clear` 로 .env.demo + LVIS_DEMO_* + main capture 비움
  //   4. `lvis:settings:update` 로 features.onboardingCompleted=false 회귀
  //   5. App.tsx 의 onLogout callback 으로 onboarding chain reducer 에
  //      `logout-reset` dispatch → 첫 부팅 ScenarioShowcase 재진입
  //
  // 재입력 흐름 (Deliverable 2):
  //   1. App.tsx 의 onReactivateDemo callback 으로 Settings dialog 닫고
  //      LoginModal 을 `forceActivation=true` 로 mount
  //   2. 사용자가 새 활성 코드 paste → 기존 lvis:demo:activate path 그대로
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
          setLogoutError("API 키 삭제 중 오류가 발생했습니다. 다시 시도해 주세요.");
          return;
        }
      }
      const cleared = await api.demo.clearDemo();
      if (!cleared.ok) {
        setLogoutError("데모 자격증명 삭제 중 오류가 발생했습니다. 다시 시도해 주세요.");
        return;
      }
      await api.updateSettings({ features: { onboardingCompleted: false } });
      setLogoutConfirmOpen(false);
      onLogout?.();
    } catch {
      setLogoutError("로그아웃 처리 중 오류가 발생했습니다. 다시 시도해 주세요.");
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

      {/* ── 인증 관리 ───────────────────────────────── */}
      {/* 2026-05-20: PR #1044 onboarding UX 재설계가 activation 입력 필드를
          first-boot LoginModal fullscreen page 로 옮기면서 첫 활성 이후
          *재입력 path* 가 사라졌다. 두 surface 로 복원:
            · 데모 자격증명 재입력 — LoginModal activation page 직접 mount
            · 로그아웃 — 모든 인증 + 데모 + onboarding state 초기화 →
              첫 부팅 ScenarioShowcase 재진입 */}
      <SettingsSection
        title="인증 관리"
        description="활성 코드를 다시 입력하거나, 모든 인증 정보를 삭제하고 첫 부팅 화면으로 돌아갈 수 있습니다."
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
            데모 자격증명 재입력
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
            로그아웃 (모든 인증 정보 삭제)
          </Button>
        </div>
      </SettingsSection>

      {/* ── 데모 표시 ───────────────────────────────── */}
      <SettingsSection
        title="데모 표시"
        description="시연 중 화면에 노출하고 싶지 않은 표시를 숨깁니다. 표시만 가릴 뿐 실제 도구 실행 결과와 감사 로그에는 영향을 주지 않습니다."
        actions={
          <Switch
            checked={hideToolFailures}
            onCheckedChange={onToggleHideToolFailures}
            aria-label="도구 실패 배지 숨기기"
            data-testid="general-tab-hide-tool-failures"
          />
        }
      >
        <p className="text-sm text-muted-foreground">
          도구 호출이 실패해도 대화 타임라인에 "실패" / "오류 있음" 배지를 표시하지 않습니다.
        </p>
      </SettingsSection>

      <Dialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
        <DialogContent size="sm" data-testid="general-tab-logout-confirm">
          <DialogHeader>
            <DialogTitle>로그아웃 하시겠습니까?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            모든 인증 정보 + 데모 활성 상태가 삭제되고 첫 부팅 화면으로 돌아갑니다. 진행하시겠습니까?
          </p>
          {logoutError && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
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
              취소
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void performLogout()}
              disabled={loggingOut}
              data-testid="general-tab-logout-confirm-button"
            >
              {loggingOut ? "처리 중…" : "로그아웃"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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

      {/* ── 시스템 동작 ─────────────────────────────── */}
      <SettingsSection
        title="시스템 동작"
        description="창 닫기 버튼을 눌렀을 때의 동작을 선택합니다."
      >
        <RadioGroup
          value={closeBehavior}
          onValueChange={onCloseBehaviorChange}
          className="gap-3"
        >
          <div className="flex items-start gap-3 rounded-md border bg-card/50 p-3">
            <RadioGroupItem value="hide-to-tray" id="close-hide-to-tray" className="mt-0.5" />
            <Label htmlFor="close-hide-to-tray" className="cursor-pointer">
              <div className="font-medium">트레이로 숨김 (기본)</div>
              <div className="text-xs text-muted-foreground">
                창을 닫아도 LVIS 가 시스템 트레이에서 계속 실행됩니다. 루틴, 브리핑, 플러그인 백그라운드 작업이 유지됩니다.
              </div>
            </Label>
          </div>
          <div className="flex items-start gap-3 rounded-md border bg-card/50 p-3">
            <RadioGroupItem value="quit" id="close-quit" className="mt-0.5" />
            <Label htmlFor="close-quit" className="cursor-pointer">
              <div className="font-medium">즉시 종료</div>
              <div className="text-xs text-muted-foreground">
                창을 닫으면 일반 앱처럼 LVIS 가 완전히 종료됩니다. 백그라운드 작업도 함께 중단됩니다.
              </div>
            </Label>
          </div>
        </RadioGroup>
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
          <div
            className="flex items-start gap-3 rounded-md border bg-card/50 p-3 sm:col-span-2"
            data-testid="general-tab-stack-info"
          >
            <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
            <div className="min-w-0 flex-1">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">기반 기술</dt>
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
