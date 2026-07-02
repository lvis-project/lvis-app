import { ArrowDownToLine, Download, PanelRightClose, PanelRightOpen, RefreshCw, Wrench, X } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";
import { useTranslation } from "../../i18n/react.js";

/**
 * Every interactive control in the toolbar lives inside the window-control
 * band (see CustomTitleBar). The band is an Electron drag region in its empty
 * zones, so each control must opt OUT of dragging or it would be un-clickable.
 * `NoDrag` wraps a control with `WebkitAppRegion: "no-drag"`.
 *
 * The search / star / export controls + the collapse toggle no longer live
 * here — they moved into the floating sidebar's CLUSTER STRIP next to the
 * traffic lights (see Sidebar.tsx). This band now hosts only the right-aligned
   * controls: the app-update badge, the Dev badge, the Chat/Work mode toggle,
   * and the right-side work-panel toggle.
 */
function NoDrag({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={className}
      style={{
        // @ts-expect-error — Electron-specific CSS extension
        WebkitAppRegion: "no-drag",
      }}
    >
      {children}
    </span>
  );
}

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
 * Workspace mode. MainToolbar owns this type because it hosts the toggle UI;
 * App.tsx imports it. "work" (default) renders built-in + plugin views
 * inline in the main area with the sidebar expanded; "chat" pops detachable
 * views into separate windows so the main area stays the chat.
 */
export type AppMode = "chat" | "work";

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
  /** Current workspace mode (Chat / Work). Drives the segmented toggle. */
  appMode: AppMode;
  /** Fired when the user picks a segment in the Chat/Work toggle. */
  onToggleAppMode: (mode: AppMode) => void;
  /** Whether the right-side work panel is open. */
  sidePanelOpen: boolean;
  /** Toggle the right-side work panel. */
  onToggleSidePanel: () => void;
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
  hasApiKey: _hasApiKey,
  appMode,
  onToggleAppMode,
  sidePanelOpen,
  onToggleSidePanel,
  onOpenDevTools,
  appUpdateState = { kind: "idle" },
  appUpdateInFlight = false,
  onDownloadAppUpdate,
  onInstallAppUpdate,
  onSkipAppUpdate,
}: MainToolbarProps) {
  const { t } = useTranslation();
  // The toolbar content lives IN the window-control band (CustomTitleBar). The
  // search / star / export controls + the collapse toggle moved into the
  // floating sidebar's cluster strip next to the traffic lights, so this band
  // hosts only the RIGHT-aligned controls. A leading spacer (stays a drag
  // region) pushes them to the far-right edge; each control is wrapped `no-drag`
  // so the surrounding band stays draggable.
  return (
    <div
      data-testid="main-toolbar"
      className="flex min-w-0 flex-1 items-center gap-2"
    >
      {/* ── Spacer pushes the trailing controls to the far-right edge (stays drag) */}
      <div className="flex-1" aria-hidden="true" />

      {/* ── App update badge — permanent (NOT a toast) until acted on; clicking
          maps to download (available) → install (downloaded). The download step
          is the user's first explicit consent (사용자 명시 클릭 전엔 절대
          다운로드 금지). */}
      <NoDrag>
        <AppUpdateBadge
          state={appUpdateState}
          inFlight={appUpdateInFlight}
          onDownload={onDownloadAppUpdate}
          onInstall={onInstallAppUpdate}
          onSkip={onSkipAppUpdate}
        />
      </NoDrag>

      {/* ── Dev badge — only visible in non-production (LVIS_DEV). Stays next to
          the mode toggle at the far-right end. */}
      {isDevMode() && onOpenDevTools !== undefined && (
        <NoDrag>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[10.5px] font-mono text-warning"
                onClick={onOpenDevTools}
                title={t("mainToolbar.devToolsTitle")}
                aria-label={t("mainToolbar.devToolsTitle")}
                data-testid="dev-tools-toggle"
              >
                <Wrench className="h-3 w-3" />
                <span>Dev</span>
                <kbd className="rounded border border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) px-1 text-[9.5px]">⇧⌘D</kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("mainToolbar.devToolsTooltip")}</TooltipContent>
          </Tooltip>
        </NoDrag>
      )}

      {/* ── Workspace mode (Chat / Work) — pinned to the FAR-RIGHT end of the
          top bar. Work keeps views inline (sidebar expanded); Chat pops
          detachable views into windows. */}
      <NoDrag>
        <AppModeToggle mode={appMode} onToggle={onToggleAppMode} />
      </NoDrag>

      <NoDrag>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="h-7 w-7 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              title={sidePanelOpen ? t("chatPreviewRail.close") : t("chatPreviewRail.open")}
              aria-label={sidePanelOpen ? t("chatPreviewRail.close") : t("chatPreviewRail.open")}
              aria-pressed={sidePanelOpen}
              onClick={onToggleSidePanel}
              data-testid="chat-side-panel-toggle"
            >
              {sidePanelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{sidePanelOpen ? t("chatPreviewRail.close") : t("chatPreviewRail.open")}</TooltipContent>
        </Tooltip>
      </NoDrag>
    </div>
  );
}

/**
 * Workspace mode segmented control — two compact segments ("채팅" / "업무").
 * The active segment is filled (`bg-primary` / `text-primary-foreground`); the
 * inactive segment is muted with an accent hover. Token classes only.
 */
function AppModeToggle({ mode, onToggle }: { mode: AppMode; onToggle: (mode: AppMode) => void }) {
  const { t } = useTranslation();
  const segment = (value: AppMode, label: string, ariaLabel: string) => {
    const active = mode === value;
    return (
      <Button
        variant="ghost"
        size="sm"
        className={`h-6 rounded-md px-2 text-[11px] font-medium ${
          active
            ? "bg-primary text-primary-foreground hover:bg-primary"
            : "text-muted-foreground hover:bg-accent hover:text-foreground"
        }`}
        onClick={() => onToggle(value)}
        aria-pressed={active}
        aria-label={ariaLabel}
        data-testid={`app-mode-${value}`}
      >
        {label}
      </Button>
    );
  };
  return (
    <div
      role="group"
      aria-label={t("appMode.groupAriaLabel")}
      className="flex h-7 items-center gap-0.5 rounded-lg border border-border bg-muted/(--opacity-medium) p-px shrink-0"
      data-testid="app-mode-toggle"
    >
      {segment("chat", t("appMode.chat"), t("appMode.chatAriaLabel"))}
      {segment("work", t("appMode.work"), t("appMode.workAriaLabel"))}
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
              className="h-7 gap-1 px-2 text-[11px] font-medium text-info border border-info/(--opacity-medium) bg-info/(--opacity-subtle) hover:bg-info/(--opacity-light) disabled:opacity-60"
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
            className="h-7 gap-1 px-2 text-[11px] font-medium text-muted-foreground border border-border bg-muted/(--opacity-medium) cursor-progress"
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
            className="h-7 gap-1 px-2 text-[11px] font-medium text-success border border-success/(--opacity-medium) bg-success/(--opacity-subtle) hover:bg-success/(--opacity-light) disabled:opacity-60"
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
          className="h-7 w-7 aspect-square text-muted-foreground hover:text-foreground disabled:opacity-60"
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
