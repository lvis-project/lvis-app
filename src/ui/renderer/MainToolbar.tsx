import { ArrowDownToLine, Download, ExternalLink, KeyRound, Menu, RefreshCw, Search, Star, Wrench, X } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";
import { useTranslation } from "../../i18n/react.js";

/**
 * App auto-update state mirrored from the main process via
 * `api.onAppUpdateState`. The badge next to Home renders one of four
 * affordances:
 *   idle         → not rendered (zero footprint)
 *   available    → "↓ v0.1.5" pill, click starts the user-gated download
 *   downloading  → spinner + percent, click is disabled
 *   downloaded   → "v0.1.5 적용" pill (success tint), click → quit & install
 *
 * Type is re-exported (not redeclared) from the cross-process SoT in
 * `src/shared/update-state.ts` so main / preload / renderer / this UI
 * stay in lockstep when a new variant is ever added.
 */
import type { UpdateState } from "../../shared/update-state.js";
export type AppUpdateBadgeState = UpdateState;

/**
 * Dev mode 감지 — preload (`src/preload.ts`) 가 `window.__lvisDevMode` 를
 * runtime 에 set. main process 가 `scripts/run-electron.mjs` 에서
 * NODE_ENV=development 설정한 결과를 reads. webpack build-time 치환에 의존
 * 안 함 (renderer build 가 default production 모드라서 build-time literal
 * 은 항상 false 가 됨).
 */
function isDevMode(): boolean {
  return (window as unknown as { __lvisDevMode?: boolean }).__lvisDevMode === true;
}

export interface MainToolbarProps {
  activeView: string;
  streaming: boolean;
  hasApiKey: boolean | null;
  isCurrentSessionStarred: boolean;
  onNewChat: () => void;
  onToggleCurrentSessionStar: () => void | Promise<void>;
  onExport: (format: "markdown" | "json") => void | Promise<void>;
  onOpenHome: () => void;
  onOpenWorkBoardView: () => void;
  onOpenRoutinesView: () => void;
  onOpenMemoryView: () => void;
  onOpenSettings: () => void;
  onOpenUnifiedSearch: () => void;
  onOpenStarredView: () => void;
  onOpenDetachedView: (viewKey: "routines" | "memory" | "starred") => void | Promise<void>;
  /** Dev mode 만 사용 — clicking the wrench opens the floating DevToolsPanel. */
  onOpenDevTools?: () => void;
  /** Latest app-update state from the main process. */
  appUpdateState?: AppUpdateBadgeState;
  /** When true, the user-initiated download/install IPC is in flight —
   *  disables the badge to prevent rapid double-clicks during the IPC
   *  round-trip window. */
  appUpdateInFlight?: boolean;
  /** Triggered when the badge is in "available" state and clicked. */
  onDownloadAppUpdate?: () => void | Promise<void>;
  /** Triggered when the badge is in "downloaded" state and clicked. */
  onInstallAppUpdate?: () => void | Promise<void>;
  /** Hide the current available/downloaded app update until a newer version exists. */
  onSkipAppUpdate?: () => void | Promise<void>;
}

export function MainToolbar({
  activeView: _activeView,
  streaming: _streaming,
  hasApiKey,
  isCurrentSessionStarred,
  onNewChat: _onNewChat,
  onToggleCurrentSessionStar,
  onExport,
  onOpenHome: _onOpenHome,
  onOpenWorkBoardView: _onOpenWorkBoardView,
  onOpenRoutinesView: _onOpenRoutinesView,
  onOpenMemoryView: _onOpenMemoryView,
  onOpenSettings,
  onOpenUnifiedSearch,
  onOpenStarredView: _onOpenStarredView,
  onOpenDetachedView,
  onOpenDevTools,
  appUpdateState = { kind: "idle" },
  appUpdateInFlight = false,
  onDownloadAppUpdate,
  onInstallAppUpdate,
  onSkipAppUpdate,
}: MainToolbarProps) {
  const { t } = useTranslation();
  return (
    <div data-testid="main-toolbar" className="h-[52px] border-b bg-card shadow-sm px-3 flex items-center">
      <div className="flex min-w-0 w-full items-center gap-2">
        {/* ── App update badge — anchors the left edge of the toolbar now
            that Home nav lives in the persistent Sidebar. Permanent (NOT
            a toast) until acted on; clicking maps to download (available)
            → install (downloaded). The download step is the user's first
            explicit consent (사용자 명시 클릭 전엔 절대 다운로드 금지). */}
        <AppUpdateBadge
          state={appUpdateState}
          inFlight={appUpdateInFlight}
          onDownload={onDownloadAppUpdate}
          onInstall={onInstallAppUpdate}
          onSkip={onSkipAppUpdate}
        />

        {/* ── Dev tools indicator — only visible in non-production. */}
        {isDevMode() && onOpenDevTools !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[10.5px] font-mono text-warning"
                onClick={onOpenDevTools}
                title="Dev Tools (Cmd/Ctrl+Shift+D)"
                aria-label="Dev Tools (Cmd/Ctrl+Shift+D)"
                data-testid="dev-tools-toggle"
              >
                <Wrench className="h-3 w-3" />
                <span>Dev</span>
                <kbd className="rounded border border-warning/40 bg-warning/10 px-1 text-[9.5px]">⇧⌘D</kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("mainToolbar.devToolsTooltip")}</TooltipContent>
          </Tooltip>
        )}

        {/* ── Spacer pushes remaining items to the right ─────────────── */}
        <div className="flex-1" />

        {/* ── Unified search — opens the top-attached search panel ───────
            Z onboarding chain — this button anchors the "chat-history"
            spotlight step. The Unified Search panel surfaces both saved
            and recent sessions, which is the "최근 대화 목록" the tour
            references.  */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 aspect-square p-0 shrink-0"
              onClick={onOpenUnifiedSearch}
              title={t("mainToolbar.unifiedSearch")}
              aria-label={t("mainToolbar.unifiedSearch")}
              data-tour-anchor="chat-history"
            >
              <Search className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("mainToolbar.unifiedSearch")}</TooltipContent>
        </Tooltip>

        {/* ── Current session star — immediate session-level action ───── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 aspect-square p-0 shrink-0"
              onClick={() => void onToggleCurrentSessionStar()}
              title={isCurrentSessionStarred ? t("mainToolbar.sessionUnstar") : t("mainToolbar.sessionStar")}
              aria-label={isCurrentSessionStarred ? t("mainToolbar.sessionUnstar") : t("mainToolbar.sessionStar")}
              aria-pressed={isCurrentSessionStarred}
            >
              <Star key={isCurrentSessionStarred ? "on" : "off"} className={`h-4 w-4 ${isCurrentSessionStarred ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{isCurrentSessionStarred ? t("mainToolbar.sessionUnstar") : t("mainToolbar.sessionStar")}</TooltipContent>
        </Tooltip>

        {/* ── Hamburger — wraps infrequent actions ────────────────────── */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                {/* Z onboarding chain — spotlight anchor for the
                    "settings-entry" step. Settings + Routines + Memory
                    + Export all live inside this menu, so anchoring
                    the trigger is the stable selector. */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 aspect-square p-0 shrink-0"
                  title={t("mainToolbar.moreMenu")}
                  aria-label={t("mainToolbar.moreMenu")}
                  data-tour-anchor="settings-entry"
                >
                  <Menu className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("mainToolbar.moreMenu")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-[240px]">
            {/* ── Detached built-in views ── */}
            <DropdownMenuItem data-testid="toolbar-detach-routines" onClick={() => void onOpenDetachedView("routines")}>
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              <span>{t("mainToolbar.detachRoutines")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="toolbar-detach-memory" onClick={() => void onOpenDetachedView("memory")}>
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              <span>{t("mainToolbar.detachMemory")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="toolbar-detach-starred" onClick={() => void onOpenDetachedView("starred")}>
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              <span>{t("mainToolbar.detachStarred")}</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* ── Export submenu ── */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Download className="mr-2 h-3.5 w-3.5" />
                <span>{t("mainToolbar.export")}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => void onExport("markdown")}>Markdown (.md)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void onExport("json")}>JSON (.json)</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            {/* ── Settings ── */}
            <DropdownMenuItem onClick={onOpenSettings}>
              <KeyRound className="mr-2 h-3.5 w-3.5" />
              <span className={hasApiKey === false ? "text-destructive" : ""}>{t("mainToolbar.settings")}</span>
              {hasApiKey === false && (
                <span className="ml-auto text-[10px] text-destructive">{t("mainToolbar.apiKeyRequired")}</span>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * Update badge next to the Home button — three render branches:
 *
 *   available   → solid info pill ("↓ v0.1.5"); click fires the download.
 *   downloading → muted pill with a spinner + percent; click is a no-op.
 *   downloaded  → solid success pill ("v0.1.5 적용"); click quits & installs.
 *
 * Nothing renders for `idle`, so the toolbar gains zero visual weight when
 * there's no update — important because most app launches are no-op
 * (already on latest).
 */
function AppUpdateBadge({
  state,
  inFlight = false,
  onDownload,
  onInstall,
  onSkip,
}: {
  state: AppUpdateBadgeState;
  /** When true, an IPC action (download/install) is in flight — disables
   *  the button to prevent rapid double-click during the round-trip
   *  window before the main process broadcasts the next state. */
  inFlight?: boolean;
  onDownload?: () => void | Promise<void>;
  onInstall?: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  if (state.kind === "idle") return null;

  if (state.kind === "available") {
    return (
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px] font-medium text-info border border-info/40 bg-info/10 hover:bg-info/20 disabled:opacity-60"
              onClick={() => void onDownload?.()}
              disabled={inFlight}
              title={t("mainToolbar.updateAvailableTitle", { version: state.version })}
              aria-label={t("mainToolbar.updateDownloadAriaLabel", { version: state.version })}
              data-testid="app-update-badge-available"
            >
              <ArrowDownToLine className="h-3 w-3" />
              <span>v{state.version}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("mainToolbar.updateAvailableTitle", { version: state.version })}</TooltipContent>
        </Tooltip>
        <SkipUpdateButton version={state.version} disabled={inFlight} onSkip={onSkip} />
      </div>
    );
  }

  if (state.kind === "downloading") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] font-medium text-muted-foreground border border-border bg-muted/40 cursor-progress"
            disabled
            title={t("mainToolbar.downloadingTitle", { version: state.version, percent: state.percent })}
            aria-label={t("mainToolbar.downloadingAriaLabel", { percent: state.percent })}
            data-testid="app-update-badge-downloading"
          >
            <RefreshCw className="h-3 w-3 animate-spin" />
            <span>{state.percent}%</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("mainToolbar.downloadingTooltip", { version: state.version, percent: state.percent })}</TooltipContent>
      </Tooltip>
    );
  }

  // downloaded
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] font-medium text-success border border-success/40 bg-success/10 hover:bg-success/20 disabled:opacity-60"
            onClick={() => void onInstall?.()}
            disabled={inFlight}
            title={t("mainToolbar.downloadedTitle", { version: state.version })}
            aria-label={t("mainToolbar.updateInstallAriaLabel", { version: state.version })}
            data-testid="app-update-badge-downloaded"
          >
            <Download className="h-3 w-3" />
            <span>{t("mainToolbar.applyUpdate", { version: state.version })}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("mainToolbar.downloadedTitle", { version: state.version })}</TooltipContent>
      </Tooltip>
      <SkipUpdateButton version={state.version} disabled={inFlight} onSkip={onSkip} />
    </div>
  );
}

function SkipUpdateButton({
  version,
  disabled,
  onSkip,
}: {
  version: string;
  disabled?: boolean;
  onSkip?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  if (!onSkip) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 aspect-square text-muted-foreground hover:text-foreground disabled:opacity-60"
          onClick={() => void onSkip()}
          disabled={disabled}
          title={t("mainToolbar.skipUpdateTitle", { version })}
          aria-label={t("mainToolbar.skipUpdateAriaLabel", { version })}
          data-testid="app-update-skip"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("mainToolbar.skipUpdateTitle", { version })}</TooltipContent>
    </Tooltip>
  );
}
