import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "../../i18n/react.js";
import { debugLog, isDebugStreamEnabled } from "../../lib/debug-stream.js";
import type { ChatEntry, ToolEntryItem } from "../../lib/chat-stream-state.js";
import {
  composeImportedTriggerOutgoing,
  composeOutgoing as composeOutgoingUtil,
} from "./utils/compose.js";
import { supportsVision } from "../../engine/llm/vendor-capabilities.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ThemeProvider } from "./theme/index.js";

// ─── Imports: types / constants / helpers / components / tabs ────────
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import { getPluginInstallAliases } from "./utils/plugin-install-aliases.js";
import { ApprovalDialog } from "./dialogs/ApprovalDialog.js";
import { DeferredQueueDialog } from "./dialogs/DeferredQueueDialog.js";
import { MemorySeedDialog } from "./dialogs/MemorySeedDialog.js";
import { SpotlightTour } from "./components/SpotlightTour.js";
import { PostTourFirstTask } from "./onboarding/PostTourFirstTask.js";
import { ScenarioShowcase } from "./onboarding/ScenarioShowcase.js";
import { PersonalizedWelcome } from "./onboarding/PersonalizedWelcome.js";
import { PluginShowcase } from "./onboarding/PluginShowcase.js";
import { summarizePluginReadiness } from "./onboarding/first-run-readiness.js";
import {
  initialOnboardingChainState,
  onboardingChainReducer,
  type OnboardingChainStage,
} from "./onboarding/onboarding-chain.js";
import { shouldOpenDemoReactivationOnBoot } from "./onboarding/demo-reactivation-gate.js";
import { hasSeenFirstBootTour } from "./onboarding/first-boot-tour-gate.js";
import { LoginModal } from "./components/LoginModal.js";
import { LLM_VENDORS } from "../../shared/llm-vendor-defaults.js";
import { buildQuickActions } from "./components/command-actions.js";
import { MainToolbar, type AppMode } from "./MainToolbar.js";
import { DEFAULT_APP_MODE, normalizeAppMode } from "../../shared/initial-app-mode.js";
import { Sidebar } from "./components/Sidebar.js";
import { useAppUpdate } from "./hooks/use-app-update.js";
import { DevToolsPanel } from "./components/DevToolsPanel.js";
import {
  ActionPanel,
  type ActionPanelActivityItem,
  type ActionPanelActivityState,
} from "./components/ActionPanel.js";
import { MainContent } from "./MainContent.js";
import { useStatusBar, type NotificationToastMeta } from "./hooks/use-status-bar.js";
import { useSettings } from "./hooks/use-settings.js";
import { lookupBillablePricingOptional } from "../../shared/pricing-data.js";
import { estimateMultimodalTokenOverhead } from "../../shared/multimodal-token-estimate.js";
import { useChatState } from "./hooks/use-chat-state.js";
import { useApproval } from "./hooks/use-approval.js";
import { useSearch } from "./hooks/use-search.js";
import { useContextBudget } from "./hooks/use-context-budget.js";
import { useCostEstimate } from "./hooks/use-cost-estimate.js";
import { useStarred } from "./hooks/use-starred.js";
import { useSessions } from "./hooks/use-sessions.js";
import { useMarketplaceUpdates } from "./hooks/use-marketplace-updates.js";
import { useMarketplaceAnnouncements } from "./hooks/use-marketplace-announcements.js";
import { useBootstrapStatus } from "./hooks/use-bootstrap-status.js";
import { MarketplaceUpdateBanner } from "./components/MarketplaceUpdateBanner.js";
import { MarketplaceAnnouncementBanner } from "./components/MarketplaceAnnouncementBanner.js";
import { BootstrapStatusBanner } from "./components/BootstrapStatusBanner.js";
import { DevConsoleToggle } from "./components/DevConsoleToggle.js";
import { SnapEdgeHighlight } from "./components/SnapEdgeHighlight.js";
import { usePluginMarketplace } from "./hooks/use-plugin-marketplace.js";
import { usePluginAuthStatuses } from "./hooks/use-plugin-auth-status.js";
import type { Attachment } from "./types/attachments.js";
import { useRolePresets } from "./hooks/use-role-presets.js";
import { useAppBootstrap } from "./hooks/use-app-bootstrap.js";
import { useWindowFileDropGuard } from "./hooks/use-window-file-drop-guard.js";
import { useChatActions } from "./hooks/use-chat-actions.js";
import { useChatContextValue } from "./hooks/use-chat-context-value.js";
import { CustomTitleBar } from "./components/CustomTitleBar.js";
import { useWorkflowTools } from "./hooks/use-workflow-tools.js";
import { useInstallingPlugins } from "./hooks/use-installing-plugins.js";
import { useMarketplaceUrl } from "./hooks/use-marketplace-url.js";
import { OverlayContextProvider } from "./context/OverlayContext.js";
import { UnifiedSearchPanel } from "./components/UnifiedSearchPanel.js";
import type { UserKeyboardIntentSnapshot } from "../../shared/chat-origin.js";
import { normalizeSettingsTab } from "../../shared/settings-tabs.js";

// ─── App ────────────────────────────────────────────

const SAFE_PLUGIN_AUTH_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
const ACTION_PANEL_ACTIVITY_LIMIT = 5;
const ACTION_PANEL_ICON_LIMIT = 10;
const FILE_CHANGE_TOOL_NAMES = new Set(["edit_file", "apply_patch", "write_file"]);
const READ_TOOL_PATTERN = /(^|[._:-])(read|open|cat|grep|rg|search|find|list|glob)([._:-]|$)/i;
const TERMINAL_TOOL_PATTERN = /(^|[._:-])(shell|bash|cmd|powershell|terminal|exec|run)([._:-]|$)/i;
const BROWSER_TOOL_PATTERN = /(browser|playwright|screenshot|chrome|viewport|open_url|web_page|web_fetch|fetch)/i;
const ACTION_PANEL_PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filepath",
  "filepaths",
  "filename",
  "filenames",
  "target",
  "targets",
]);

function isFileChangeTool(tool: ToolEntryItem): boolean {
  return FILE_CHANGE_TOOL_NAMES.has(tool.name) || tool.category === "write";
}

function isReadTool(tool: ToolEntryItem): boolean {
  return tool.category === "read" || READ_TOOL_PATTERN.test(tool.name);
}

function isTerminalTool(tool: ToolEntryItem): boolean {
  return tool.category === "shell" || TERMINAL_TOOL_PATTERN.test(tool.name);
}

function isBrowserTool(tool: ToolEntryItem): boolean {
  return tool.category === "network" || BROWSER_TOOL_PATTERN.test(tool.name);
}

function isPluginTool(tool: ToolEntryItem): boolean {
  return tool.source === "plugin" || Boolean(tool.pluginId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || looksLikeUrl(trimmed)) return false;
  return /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /\.[A-Za-z0-9]{1,12}$/.test(trimmed);
}

function collectUrls(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") return looksLikeUrl(value) ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectUrls(item, depth + 1));
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((item) => collectUrls(item, depth + 1));
}

function collectPathStrings(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") return looksLikeFilePath(value) ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectPathStrings(item, depth + 1));
  if (!isRecord(value)) return [];

  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (ACTION_PANEL_PATH_KEYS.has(normalizedKey)) {
      out.push(...collectPathStrings(child, depth + 1));
    } else if (normalizedKey === "patch" && typeof child === "string") {
      out.push(...extractPatchPaths(child));
    } else if (depth < 2) {
      out.push(...collectPathStrings(child, depth + 1));
    }
  }
  return out;
}

function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  const pattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(patch)) !== null) {
    const value = match[1]?.trim();
    if (value) paths.push(value);
  }
  return paths;
}

function addUniqueActivity(
  list: ActionPanelActivityItem[],
  item: ActionPanelActivityItem,
  limit = ACTION_PANEL_ACTIVITY_LIMIT,
): void {
  if (list.length >= limit) return;
  const key = `${item.label}\u0000${item.detail ?? ""}`;
  if (list.some((existing) => `${existing.label}\u0000${existing.detail ?? ""}` === key)) return;
  list.push(item);
}

function formatToolSource(tool: ToolEntryItem): string {
  const parts = [
    tool.source && tool.source !== "builtin" ? tool.source : null,
    tool.mcpServerId ? tool.mcpServerId : null,
    tool.pluginId ? tool.pluginId : null,
    tool.category ? tool.category : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

function formatUrlOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return value;
  }
}

function stringField(value: unknown, key: "code" | "error" | "message"): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

function sanitizePluginAuthErrorCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value.trim();
  return SAFE_PLUGIN_AUTH_ERROR_CODE.test(code) ? code : null;
}

function extractPluginAuthErrorCode(err: unknown): string | null {
  const explicitCode =
    sanitizePluginAuthErrorCode(stringField(err, "code")) ??
    sanitizePluginAuthErrorCode(stringField(err, "error"));
  if (explicitCode) return explicitCode;

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : stringField(err, "message");
  const bracketCode = message?.match(/\[([A-Za-z0-9][A-Za-z0-9._:-]{0,80})\]/)?.[1];
  return sanitizePluginAuthErrorCode(bracketCode);
}

/**
 * Read the persisted workspace mode that the main process injected before the
 * renderer loaded (preload exposes it as `window.__lvisInitialAppMode`, mirror
 * of the `__lvisInitialTheme` prime). Reading it here — at `useState`
 * initializer time, before first paint — means the shell renders the correct
 * mode layout on frame 0 instead of mounting in "work" and tweening to the
 * restored mode in a post-mount effect (the wrong-mode flash).
 *
 * `DEFAULT_APP_MODE` ("work") covers the non-Electron test harness and the
 * cold-boot-before-settings window — both legitimate first-run defaults.
 */
function readInitialAppMode(): AppMode {
  if (typeof window === "undefined") return DEFAULT_APP_MODE;
  const raw = (window as { __lvisInitialAppMode?: unknown }).__lvisInitialAppMode;
  return normalizeAppMode(raw) ?? DEFAULT_APP_MODE;
}

export function App() {
  const { t } = useTranslation();
  const api = useMemo(() => getApi(), []);

  // Block default file:// navigation when a file is dropped onto the window
  // (the drag-drop indexing feature was removed; this guard is all that remains).
  useWindowFileDropGuard();

  // Workflow tools (S1+S2) — lifted to App level so FloatingQuestionPanel
  // survives view navigation (question state persists across view changes).
  const {
    askQuestions,
    subAgentSpawns,
    loadedSkills,
    dismissAskQuestion,
    resetForNewSession,
  } = useWorkflowTools(api);

  // Chat state + stream lifecycle (useChatState is the sole owner of entries).
  const {
    entries, streaming, isCompacting, compactTriggerSource, isRecoveryExhausted, beginStreamingRequest, finishStreamingRequest, editingEntryIdx, setEditingEntryIdx, editBusy,
    entryIndexToHistoryIndex, handleEditSave, handleRetryEffort, handleContinueFromLastUser,
    resetStreamAccumulators, setErrorWithThought, handleCompactCommand,
    clearForNewChat, appendUserEntry, appendSystemEntry, applyInitialSession, applyLoadedSession, truncateToEntry,
    fallbackToast,
    insertImportedTriggerEntry,
  } = useChatState(api);
  // Top chat-area status surface: persistent operational items plus transient
  // toasts. Initialized early because plugin auth selection can emit toasts.
  const {
    persistent: statusPersistent,
    visibleToast: statusVisibleToast,
    pendingCount: statusPendingCount,
    pushToast: statusPushToast,
    removeToast: statusRemoveToast,
    upsertPersistent: statusUpsertPersistent,
    removePersistent: statusRemovePersistent,
  } = useStatusBar({ api });

  // App auto-update badge — surfaces main-process electron-updater events as a
  // permanent badge next to the Home button. User-gated: download/install only
  // run on explicit badge click. Declared after useStatusBar so the unsigned-
  // build manual-install fallback can raise a toast: an unsigned macOS build
  // can't self-install (Squirrel.Mac needs a Developer ID), so the main process
  // opens the release page and signals "manual-install-required" here instead
  // of leaving the badge a dead button.
  const appUpdate = useAppUpdate(api, () => {
    // Unsigned macOS build can't self-install (Squirrel.Mac needs a Developer
    // ID); the main process opened the LVIS homepage, which hosts the manual
    // update guide. Tell the user to finish up, quit, then update per the guide.
    statusPushToast({
      severity: "warning",
      message: t("app.manualInstallRequiredToast"),
      ttlMs: 20000,
    });
  });

  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const turnRequestRef = useRef(0);
  // In-flight guard for kind="action" plugin-panel dispatches — keyed by
  // `${pluginId}:${tool}`. Prevents duplicate fires from rapid double-clicks
  // when no panel transition is visible to throttle the user naturally.
  const pluginActionInflightRef = useRef<Set<string>>(new Set());
  // Detached auth gate — plugins awaiting an unauthed→authed transition before
  // their detached panel opens. Keyed by pluginId → the detached view key to
  // open once `manifest.auth` status flips to `authed`. Populated by
  // handleViewSelect when a detached auth plugin is selected while unauthed
  // (the host fires loginTool to open the SSO window, NOT the panel); drained
  // by the auth-transition effect below. See architecture.md §9.4a.
  const pendingDetachedAuthOpenRef = useRef<Map<string, string>>(new Map());
  const pendingInlineAuthOpenRef = useRef<Map<string, string>>(new Map());
  const pluginAuthLoginInflightRef = useRef<Set<string>>(new Set());
  const failedPluginAuthOpenRef = useRef<Set<string>>(new Set());
  // Ref so handlePluginPrimaryAction (defined before handleAsk) can call
  // handleAsk without a forward-declaration TS error. Updated each render.
  const handleAskRef = useRef<(
    q: string,
    mode?: "default" | "trigger-import",
    userIntent?: UserKeyboardIntentSnapshot,
  ) => Promise<void>>(
    async () => { /* populated below */ },
  );

  // App state
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  // Z onboarding chain (2026-05-19) — replaces the previous pair of
  // `onboardingOpen` + `appLoginOpen` flags with an explicit reducer
  // that drives every stage of the first-boot funnel:
  //   idle → showcase → login → welcome → memory → tour → plugins → done
  // The reducer keeps the JSX render branches small (each dialog
  // mounts only when its stage matches) and prevents the race where
  // multiple Radix Dialogs were mounted at once (#982/#990/#997).
  //
  // Initial state is `idle`. The boot probe (below) classifies the
  // boot exactly once and dispatches either `probe-start` → showcase
  // (fresh install, no key, onboarding incomplete) or `probe-skip` →
  // done (returning user). Starting at `idle` instead of `showcase`
  // eliminates the closet-flash race where a true fresh-state boot
  // briefly shows the intro Dialog and then collapses (#1014).
  const [chainState, dispatchChain] = useReducer(
    onboardingChainReducer,
    initialOnboardingChainState,
  );
  const chainStage: OnboardingChainStage = chainState.stage;
  /**
   * ScenarioShowcase carry — which card the user clicked in the first
   * step. Threaded into MemorySeed recommendations and PluginShowcase
   * ordering so the chain is personalised by the user's first choice.
   * `null` means the user reached the chain via skip / returning-user
   * paths and downstream stages should use their default ordering.
   */
  const selectedScenarioId: string | null = chainState.selectedScenarioId;
  // 2026-05-20: PersonalizedWelcome reads its display name + intro
  // straight from the chain's memorySeed context, which `memory-finish`
  // populates from the MemorySeed wizard inputs. No separate state.
  const memorySeedNickname = chainState.memorySeed.nickname;
  const memorySeedIntroduction = chainState.memorySeed.introduction;
  const [deferredQueueOpen, setDeferredQueueOpen] = useState(false);
  // 2026-05-20 — Settings → "데모 자격증명 재입력" 클릭 시 main window 가
  // LoginModal 을 forceActivation=true 로 mount 하도록 하는 flag.
  // `lvis:auth:reactivate-demo` broadcast 가 도착하면 true 로 flip 되고,
  // LoginModal 이 close 되면 false 로 reset.
  const [reactivationOpen, setReactivationOpen] = useState(false);
  // Z chain — `tourCompleted` gates the PostTourFirstTask proposal. It is
  // true ONLY once the user finished the full funnel (PluginShowcase closed
  // → `done` via `plugins-close`, recorded as completionReason "chain").
  // Two cases that previously leaked the card are now excluded:
  //   - `plugins` stage — PluginShowcase's own Dialog is still open, so a
  //     z-9000 card would overlay it.
  //   - `done` reached via `probe-skip` (returning user / demo relaunch) —
  //     the tour was never shown, so a "post-tour" proposal is wrong.
  const tourCompleted =
    chainStage === "done" && chainState.completionReason === "chain";
  const [activeView, setActiveView] = useState("home");
  // Inline-settings (work mode): which tab SettingsContent opens on, and the
  // view to return to via the back-to-home affordance. In chat mode Settings
  // detaches to its own BrowserWindow instead (see onOpenSettings), so these
  // only drive the work-mode activeView==="settings" inline render.
  const [settingsTab, setSettingsTab] = useState("general");
  const settingsReturnViewRef = useRef("home");
  // Workspace mode (Chat / Work). Default "work" preserves the historical
  // inline behavior: built-in + plugin views render inline in the main area and
  // the sidebar defaults expanded. In "chat" mode, selecting a detachable view
  // opens it in a separate window while the main area stays the chat. appMode
  // is the SOLE authority for inline-vs-detached; plugins cannot request
  // detachment (there is no plugin-side mode flag).
  // Seed from the persisted workspace mode injected by the main process
  // (preload's `window.__lvisInitialAppMode`). Reading it at initializer time
  // — before first paint — makes the shell render the saved mode's layout on
  // frame 0 (expanded rail for work, collapsed for chat) with no wrong-mode
  // flash followed by a post-mount tween. Defaults to "work" on first run /
  // non-Electron harness.
  const [appMode, setAppModeState] = useState<AppMode>(readInitialAppMode);
  // Sidebar collapse is owned by the shell (the floating-card Sidebar reads it
  // as a prop and never manages its own state). Seeded from the same persisted
  // mode so the rail starts at the correct width on frame 0 (no post-mount
  // width tween). The rail width is coupled to appMode on each transition (see
  // the effect below): work expands it, chat collapses it — a per-transition
  // default, NOT a lock.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readInitialAppMode() === "chat");
  // The 도구 활동 (Tool Activity) panel defaults to its collapsed rail: on a
  // fresh launch the full expanded card should not auto-show — the user opens it
  // on demand. (Only rendered in work mode; see the appMode gate at its mount.)
  const [actionPanelOpen, setActionPanelOpen] = useState(false);
  // Persist appMode to host settings and update local state. Guarded against
  // no-op writes (same mode) so a re-render or repeated toggle never fires a
  // redundant IPC write. Stable identity (useCallback with only `api`) so it is
  // safe in effect deps — no unstable-callback render loop (#1312 guard).
  const setAppMode = useCallback((next: AppMode) => {
    setAppModeState((prev) => {
      if (prev === next) return prev;
      // Persist the new mode so the next boot seeds from it. Fire-and-forget:
      // a failed write only means the next launch falls back to the previous
      // saved value — never blocks the toggle or surfaces an error toast.
      void api.updateSettings({ system: { appMode: next } });
      return next;
    });
  }, [api]);
  // appMode drives the rail's default width on each mode transition: work
  // mode expands it (wide working layout — inline views need the room), chat
  // mode collapses it to the focused icon rail (views detach to windows). This
  // makes toggling visibly widen/narrow the shell. It is a per-transition
  // default, NOT a lock — the user may still collapse/expand manually within a
  // mode without it snapping back until the next mode switch. On the initial
  // mount this re-asserts the already-seeded value (a no-op render), so it
  // costs nothing and keeps the transition semantics in one place.
  useEffect(() => {
    setSidebarCollapsed(appMode === "chat");
  }, [appMode]);
  // Resize the OS window to match the mode on mode CHANGES only. The window is
  // already created at the persisted mode's bounds (main.ts initialMainWindowBounds),
  // so firing resizeForMode on the initial mount would issue a same-target tween
  // — a needless animation on boot. The first-run ref skips that mount call;
  // subsequent toggles resize as before. The bridge is optional (absent in
  // jsdom / non-Electron); guard accordingly.
  const resizeForModeMountedRef = useRef(false);
  useEffect(() => {
    if (!resizeForModeMountedRef.current) {
      resizeForModeMountedRef.current = true;
      return;
    }
    void api.window?.resizeForMode?.(appMode);
  }, [appMode, api]);
  // Work mode is the inline workspace: every view renders in the main tab,
  // so any windows that were detached in chat mode must close on the
  // transition. The login/auth window is ALWAYS a separate window
  // regardless of mode and is excluded by the main process (auth windows are
  // never tracked as detached tabs). Fire-on-transition only: this depends
  // solely on stable refs (appMode + the stable api) and never sets state, so
  // it cannot re-trigger itself (#1312 render-loop guard).
  useEffect(() => {
    if (appMode !== "work") return;
    void api.window?.closeAllDetached?.();
  }, [appMode, api]);
  const [commandPopoverOpen, setCommandPopoverOpen] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);

  // Dev tools — Cmd/Ctrl+Shift+D toggles the floating panel.
  // Listener is only bound in dev mode (`window.__lvisDevMode === true`) so
  // packaged builds neither swallow the chord nor pay setState cost on every
  // press. Main process strips dev IPC handlers when packaged, so even if a
  // production build accidentally read true, the panel would render inert.
  useEffect(() => {
    if ((window as unknown as { __lvisDevMode?: boolean }).__lvisDevMode !== true) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setDevToolsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const {
    updates: marketplaceUpdates,
    dismiss: dismissMarketplaceUpdates,
    skip: skipMarketplaceUpdates,
  } = useMarketplaceUpdates(api);
  const { announcements: marketplaceAnnouncements, dismiss: dismissMarketplaceAnnouncement } = useMarketplaceAnnouncements(api);
  const { status: bootstrapStatus, dismiss: dismissBootstrapStatus, retry: retryBootstrap } = useBootstrapStatus(api);
  const { queue: approvalQueue, decide: handleApprovalDecide } = useApproval();

  // runningRoutines tracks in-flight LLM sessions.
  const [runningRoutines, setRunningRoutines] = useState<Set<string>>(new Set());

  // addFire ref is populated by OverlayContextProvider during render
  // so the IPC subscription below can call it without prop-drilling
  const addFireRef = useRef<import("./context/OverlayContext.js").OverlayContextValue["addFire"] | null>(null);
  const pushRoutineResult = useCallback((evt: import("../../shared/routines-types.js").RoutineFiredPayload) => {
    addFireRef.current?.({
      id: `${evt.id}-${evt.firedAt}`,
      source: { kind: "routine", routineId: evt.id, firedAt: evt.firedAt },
      title: evt.title,
      summary: evt.summary,
      running: false,
      routineSessionId: evt.routineSessionId,
    });
  }, []);

  // C1+M4: single subscription for routine IPC events. runningStarted pushes a
  // running OverlayItem immediately (running:true); fired replaces it with the
  // completed item (running:false + summary). runningRoutines Set is kept in
  // sync for OverlayContextProvider to derive running flags on queue items.
  useEffect(() => {
    const unsubStarted = api.onRoutineRunningStarted((payload) => {
      const { routineId, firedAt, title } = payload;
      setRunningRoutines((prev) => new Set([...prev, routineId]));
      addFireRef.current?.({
        id: `${routineId}-running`,
        source: { kind: "routine", routineId, firedAt },
        title,
        summary: "",
        running: true,
      });
    });

    const unsubFinished = api.onRoutineRunningFinished((routineId) => {
      setRunningRoutines((prev) => {
        const next = new Set(prev);
        next.delete(routineId);
        return next;
      });
    });

    // Major fix: clears running:true stuck OverlayItem when LLM session fails.
    // Uses the same stale-replace path as fired so the running OverlayItem
    // transitions to a visible error summary instead of staying spinning.
    const unsubFailed = api.onRoutineFailedV2((evt) => {
      setRunningRoutines((prev) => {
        const next = new Set(prev);
        next.delete(evt.routineId);
        return next;
      });
      addFireRef.current?.({
        id: `${evt.routineId}-running`,
        source: { kind: "routine", routineId: evt.routineId, firedAt: new Date().toISOString() },
        title: t("app.routineFailedTitle"),
        summary: t("app.routineFailedSummary", { error: evt.error }),
        running: false,
      });
    });

    void (async () => {
      try {
        const pending = await api.listPendingRoutineResultsV2();
        for (const result of pending) pushRoutineResult(result);
      } catch (err) {
        console.warn("[lvis] listPendingRoutineResults failed:", (err as Error).message);
      }
    })();

    // M1: fired payload uses explicit allowlist fields only (no ...routine spread)
    const unsubFired = api.onRoutineFiredV2(pushRoutineResult);

    return () => { unsubStarted(); unsubFinished(); unsubFailed(); unsubFired(); };
  }, [api, pushRoutineResult]);

  // Overlay items ref tracks all items pushed via onOverlayShow so
  // handlePluginPrimaryAction can look up pendingPrompt by id without needing
  // to reach into OverlayContext (App.tsx is the parent of OverlayContextProvider).
  const overlayItemsRef = useRef<Map<string, import("./context/OverlayContext.js").OverlayItem>>(new Map());

  // Overlay IPC subscriptions: main pushes plugin OverlayItems via OVERLAY_V1.show.
  useEffect(() => {
    if (typeof api.onOverlayShow !== "function") return;
    const unsubShow = api.onOverlayShow((item) => {
      // Populate lookup ref so handlePluginPrimaryAction can find the item
      overlayItemsRef.current.set(item.id, item);
      addFireRef.current?.(item);
    });
    const unsubDismiss = typeof api.onOverlayDismiss === "function"
      ? api.onOverlayDismiss((id) => {
          overlayItemsRef.current.delete(id);
        })
      : () => {};
    return () => { unsubShow(); unsubDismiss(); };
  }, [api]);

  // Plugin overlay primary action handler (user confirm → main chat insert).
  // Called from OverlayCardRegion with the OverlayItem.id after OverlayContext.dismiss()
  // has already removed the item from the queue. overlayItemsRef still holds it.
  const handlePluginPrimaryAction = useCallback(
    async (overlayItemId: string) => {
      const item = overlayItemsRef.current.get(overlayItemId);
      if (!item) return;

      const { source, pendingPrompt, summary, title } = item;
      if (source.kind !== "plugin" || !pendingPrompt) return;

      // Clean up lookup ref
      overlayItemsRef.current.delete(overlayItemId);

      // Insert as imported_trigger entry — overlay trigger provenance preserved,
      // NOT a plain user bubble (architecture §9 plugin provenance contract)
      insertImportedTriggerEntry({
        sessionId: source.eventId,
        pluginId: source.pluginId,
        prompt: pendingPrompt,
        summary,
        title,
      });

      // Start the main ConversationLoop turn immediately (user-in-the-loop
      // confirm → auto-process). trigger-import mode skips the user-bubble
      // append since the imported_trigger marker already represents the prompt.
      void handleAskRef.current(pendingPrompt, "trigger-import");
    },
    [api, insertImportedTriggerEntry],
  );

  const handleRoutineAcknowledge = useCallback(
    (routineId: string, firedAt: string) => {
      void api.acknowledgeRoutineResultV2(routineId, firedAt).catch((err) => {
        console.warn("[lvis] acknowledgeRoutineResult failed:", (err as Error).message);
      });
    },
    [api],
  );

  // Marketplace + plugin UI extensions
  const {
    pluginViews,
    pluginCards,
    installPlugin,
    refreshViews, refreshMarketplace, refreshCards,
  } = usePluginMarketplace(api);

  // Auth status for every plugin that declares `manifest.auth`
  // (architecture.md §9.4a). Drives the 미인증 badge in both Settings →
  // 플러그인 설정 (PluginConfigTab) and the chat-input plugin grid
  // (PluginGridButton). Hoisting to App.tsx means a single live-poll
  // + event-bridge subscription serves both surfaces — no duplicate
  // listeners, no stale-state divergence between the two views.
  const { statuses: pluginAuthStatuses, refresh: refreshPluginAuthStatus } = usePluginAuthStatuses(api, pluginCards);
  const [pluginAuthErrors, setPluginAuthErrors] = useState<Map<string, string>>(new Map());

  // Role preset, cost preview, multimodal attachments
  const { rolePresets, activePreset, activePresetId, setActivePresetId } = useRolePresets(api);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Strictly increasing N — never reassigned even after attachment removal so
  // textarea markers ([Image #N]) keep referring to the same payload.
  const attachmentNCounter = useRef(0);
  const [maxOutputTokens] = useState<number>(4096);

  // Search / starred / sessions
  const {
    open: searchOpen, query: searchQuery, caseSensitive: searchCase,
    matches: searchMatches, matchSet: searchMatchSet, matchIdx: searchIdx, highlight: searchHighlight,
    changeQuery: searchChangeQuery, toggleCase: searchToggleCase,
    openOverlay: searchOpenOverlay, toggleOverlay: searchToggleOverlay, closeOverlay: searchCloseOverlay,
    nextMatch: searchNext, prevMatch: searchPrev, jumpToMatch: searchJumpToMatch,
  } = useSearch(entries);
  const {
    starred,
    refreshStarred,
    isEntryStarred: starredIsEntry,
    handleToggleStar: starredToggle,
    isSessionStarred,
    handleToggleSessionStar,
  } = useStarred(api);
  const {
    currentSessionId, currentSessionKind, currentSessionTitle, sessions, refreshSessionId, refreshSessions,
    handleLoadSession: sessionLoad, handleFork: sessionFork,
  } = useSessions(api, applyInitialSession);
  const attachmentSessionScopeRef = useRef<{ initialized: boolean; sessionId?: string }>({
    initialized: false,
    sessionId: undefined,
  });

  useEffect(() => {
    const scope = attachmentSessionScopeRef.current;
    if (!scope.initialized) {
      scope.initialized = true;
      scope.sessionId = currentSessionId;
      return;
    }
    if (scope.sessionId === currentSessionId) return;
    scope.sessionId = currentSessionId;
    setAttachments([]);
  }, [currentSessionId]);

  const handleOpenRoutineSession = useCallback(
    async (sessionId: string) => {
      if (streaming) {
        console.warn("[lvis] openRoutineSession blocked during streaming");
        return false;
      }
      try {
        setActiveView("home");
        const loaded = await sessionLoad(sessionId, streaming, applyLoadedSession);
        if (loaded !== false) await refreshSessions();
        return loaded;
      } catch (err) {
        console.warn("[lvis] openRoutineSession failed:", (err as Error).message);
        return false;
      }
    },
    [applyLoadedSession, refreshSessions, sessionLoad, streaming],
  );

  useEffect(() => {
    if (!searchOpen) return;
    void refreshSessions();
    void refreshStarred();
  }, [refreshSessions, refreshStarred, searchOpen]);

  // Small adapter callbacks that bridge hook outputs to ChatView / MainToolbar.
  const {
    handleLoadSession, isEntryStarred, handleFork, handleToggleStar,
    handleAbort, handleGuide, handleFeedback, handleExport,
  } = useChatActions({
    api, streaming, currentSessionId, entries, entryIndexToHistoryIndex,
    applyLoadedSession, truncateToEntry, sessionLoad, sessionFork,
    starredIsEntry, starredToggle,
  });

  const handleLoadSessionAndRefresh = useCallback(async (sessionId: string) => {
    const loaded = await handleLoadSession(sessionId);
    if (loaded !== false) {
      await refreshSessions();
    }
    return loaded;
  }, [handleLoadSession, refreshSessions]);

  useEffect(() => {
    const unsubscribe = api.window?.onLoadSessionInMain?.((sessionId) => {
      setActiveView("home");
      return handleLoadSessionAndRefresh(sessionId);
    });
    return unsubscribe;
  }, [api, handleLoadSessionAndRefresh]);

  // LLM settings + context budget (single source of truth: src/shared/pricing-data.ts)
  const { llmVendor, llmModel, enableThinkingChat, refresh: refreshLlmSettings, toggleThinking } = useSettings(api);
  const draftAttachmentTokens = useMemo(
    () => estimateMultimodalTokenOverhead(attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => ({
        type: "image",
        mimeType: attachment.mimeType,
        width: attachment.width,
        height: attachment.height,
        bytes: attachment.bytes,
      }))),
    [attachments],
  );

  const { usedTokens, contextBudget, effectiveBudget, contextOverflowPct, tpmLimit, tpmPct, isTpmOverflow } =
    useContextBudget({ entries, llmVendor, llmModel, draftText: question, draftExtraTokens: draftAttachmentTokens });

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);
  const activePluginAuthError = activePluginView ? pluginAuthErrors.get(activePluginView.pluginId) ?? null : null;

  // Build flat PluginEntry list for InputActionBar plugin grid.
  // `unauthed` is set when the owning plugin declares `manifest.auth` AND its
  // current statusTool result is `kind: "unauthed"`. The grid renders a
  // small 🔒 indicator on those entries so users see the missing-auth state
  // without first opening Settings.
  const pluginEntries = useMemo<PluginEntry[]>(() => {
    const viewEntries: PluginEntry[] = pluginViews.map((view): PluginEntry => {
      const card = pluginCards.find((candidate) => candidate.id === view.pluginId);
      return {
        viewKey: toViewKey(view),
        pluginId: view.pluginId,
        installAliases: getPluginInstallAliases(view.pluginId, card?.installAliases),
        loadStatus: card?.loadStatus,
        preparationStatus: card?.preparationStatus,
        label: getPluginViewLabel(view),
        icon: view.icon,
        iconText: view.iconText,
        unauthed: pluginAuthStatuses.get(view.pluginId)?.kind === "unauthed",
      };
    });
    const viewKeys = new Set(viewEntries.map((entry) => entry.viewKey));
    const preparingCardEntries = pluginCards.flatMap((card) => {
      if (card.loadStatus !== "preparing") return [];
      return (card.uiExtensions ?? [])
        .map((extension): PluginEntry | null => {
          const viewKey = `plugin:${card.id}:${extension.id}`;
          if (viewKeys.has(viewKey)) return null;
          return {
            viewKey,
            pluginId: card.id,
            installAliases: getPluginInstallAliases(card.id, card.installAliases),
            loadStatus: card.loadStatus,
            preparationStatus: card.preparationStatus,
            label: extension.displayName?.trim() || extension.title || card.name,
            icon: card.icon,
            iconText: card.iconText,
            unauthed: false,
          };
        })
        .filter((entry): entry is PluginEntry => entry !== null);
    });
    return [...viewEntries, ...preparingCardEntries];
  }, [pluginViews, pluginAuthStatuses, pluginCards]);

  // Track in-flight plugin installs for the grid overlay spinner.
  const installingPlugins = useInstallingPlugins(api);
  const firstRunPluginSummary = useMemo(
    () => summarizePluginReadiness(pluginCards),
    [pluginCards],
  );

  const hasPreparingPlugin = useMemo(() => {
    if (pluginCards.some((card) => card.loadStatus === "preparing")) return true;
    return Array.from(installingPlugins.values()).some((phase) => phase === "preparing");
  }, [installingPlugins, pluginCards]);

  // Marketplace URL — sourced from settings (marketplace.cloudBaseUrl).
  const { marketplaceUrl, loaded: marketplaceUrlLoaded } = useMarketplaceUrl(api);
  // Ready only when settings have been fetched AND the URL is non-empty.
  const marketplaceUrlReady = marketplaceUrlLoaded && marketplaceUrl.length > 0;

  // Open marketplace in the system browser.
  // Guard against an empty URL during the initial settings load — calling
  // shell.openExternal("") produces undefined behaviour on some platforms.
  const onOpenMarketplace = useCallback(() => {
    if (!marketplaceUrlReady) return;
    void api.openExternalUrl(marketplaceUrl);
  }, [api, marketplaceUrl, marketplaceUrlReady]);

  const openDetachedPluginView = useCallback(
    async (viewKey: string): Promise<boolean> => {
      const openDetached = api.window?.openDetached;
      if (!openDetached) {
        setErrorWithThought(t("app.errorCannotOpenPluginWindow"));
        return false;
      }
      const result = await openDetached(viewKey);
      if (!result.ok) {
        console.warn(`[plugin-ui] detached plugin view ${viewKey} did not open`, result.error);
        setErrorWithThought(t("app.errorCannotOpenPluginWindowDetail", { error: result.error }));
        return false;
      }
      return true;
    },
    [api, setErrorWithThought],
  );

  const openDetachedBuiltInView = useCallback(
    async (viewKey: "work-board" | "routines" | "memory" | "starred"): Promise<boolean> => {
      const openDetached = api.window?.openDetached;
      if (!openDetached) {
        setErrorWithThought(t("app.errorCannotOpenNewWindow"));
        return false;
      }
      const result = await openDetached(viewKey);
      if (!result.ok) {
        console.warn(`[window] detached built-in view ${viewKey} did not open`, result.error);
        setErrorWithThought(t("app.errorCannotOpenNewWindowDetail", { error: result.error }));
        return false;
      }
      return true;
    },
    [api, setErrorWithThought],
  );

  const clearPluginAuthError = useCallback((pluginId: string) => {
    setPluginAuthErrors((prev) => {
      if (!prev.has(pluginId)) return prev;
      const next = new Map(prev);
      next.delete(pluginId);
      return next;
    });
  }, []);

  const formatPluginAuthLoginError = useCallback(
    (err: unknown): string => {
      const code = extractPluginAuthErrorCode(err);
      const detail =
        code === "non-corp-network"
          ? t("app.pluginAuthLoginFailedNonCorpNetwork")
          : t("app.pluginAuthLoginFailedGeneric");
      return code
        ? t("app.pluginAuthLoginFailedWithCode", { code, detail })
        : t("app.pluginAuthLoginFailedNoCode", { detail });
    },
    [t],
  );

  // In chat mode (appMode === "chat"), selecting a plugin view opens a
  // separate magnetic-snap BrowserWindow instead of switching the main
  // window's active view. The app's mode is the sole authority for this;
  // plugins do not get a say.
  //
  // Auth is a HOST-managed lifecycle (architecture.md §9.4a): the agent never
  // calls login/logout, and auth plugin view selection is login-first and
  // host-generic off `manifest.auth`. Selecting an auth plugin view:
  //   • authed   → open the plugin panel/page.
  //   • not authed → call loginTool via callPluginMethod (opens the SSO
  //     window), record a pending open, and open the panel/page when the
  //     plugin's status transitions to authed.
  //   • login failure → still open the plugin panel/page and surface a
  //     sanitized error code so the failure is not silent.
  // Plugins WITHOUT `manifest.auth.loginTool` open directly.
  const handleViewSelect = useCallback(
    (key: string) => {
      if (key.startsWith("plugin:")) {
        const view = pluginViews.find((v) => toViewKey(v) === key);
        if (!view) return;
        // kind="action" entries never open a panel/window — host directly
        // dispatches the declared tool. uiActions allowlist is enforced
        // downstream in runtime/index.ts:callFromUi. Active view state is
        // intentionally NOT changed so the user stays on whatever they
        // were looking at (chat / settings / etc.). slot==="sidebar" 는
        // (현재 schema 키 — 사용자에게는 "플러그인 패널") 강제하지만
        // future enum 확장 시 defense-in-depth.
        if (view.extension.kind === "action" && view.extension.slot === "sidebar") {
          const actionTool = view.extension.tool;
          if (typeof actionTool !== "string" || actionTool.length === 0) {
            console.warn(
              `[plugin-action] ${view.pluginId} extension ${view.extension.id} has kind="action" but no tool field — manifest validation should have caught this`,
            );
            return;
          }
          // In-flight guard: 사용자가 동일 action 아이콘을 빠르게 N번 클릭하면
          // N번 동시 디스패치 surface 가 열림 (mutating tool 일 때 실해). per
          // (pluginId, tool) 단위로 in-flight 추적해 진행 중이면 swallow.
          const inflightKey = `${view.pluginId}:${actionTool}`;
          if (pluginActionInflightRef.current.has(inflightKey)) {
            return;
          }
          pluginActionInflightRef.current.add(inflightKey);
          void (async () => {
            try {
              await api.callPluginMethod(actionTool);
            } catch (err) {
              // Raw err.message 는 OAuth refresh-token / Bearer header fragment
              // 가 포함될 수 있어 사용자 chat 영역에 그대로 노출하지 않는다.
              // 진단용 raw 는 console.warn 으로만 보존.
              console.warn(
                `[plugin-action] ${view.pluginId} tool '${actionTool}' failed`,
                err,
              );
              setErrorWithThought(t("app.errorCannotRunPluginAction"));
            } finally {
              pluginActionInflightRef.current.delete(inflightKey);
            }
          })();
          return;
        }
        const card = pluginCards.find((c) => c.id === view.pluginId);
        const loginTool = card?.auth?.loginTool;
        const authState = pluginAuthStatuses.get(view.pluginId)?.kind;
        const openPluginView = () => {
          if (appMode === "chat") {
            void openDetachedPluginView(key);
          } else {
            setActiveView(key);
          }
        };

        // appMode is the SOLE authority for inline-vs-detached. Work keeps
        // plugin views inline; chat pops plugin views into detached windows.
        if (!loginTool || authState === "authed") {
          clearPluginAuthError(view.pluginId);
          failedPluginAuthOpenRef.current.delete(view.pluginId);
          openPluginView();
          return;
        }

        const pendingMap =
          appMode === "chat"
            ? pendingDetachedAuthOpenRef.current
            : pendingInlineAuthOpenRef.current;
        pendingMap.set(view.pluginId, key);
        clearPluginAuthError(view.pluginId);
        failedPluginAuthOpenRef.current.delete(view.pluginId);

        const inflightKey = `${view.pluginId}:${loginTool}`;
        if (pluginAuthLoginInflightRef.current.has(inflightKey)) {
          return;
        }
        pluginAuthLoginInflightRef.current.add(inflightKey);
        void (async () => {
          try {
            await api.callPluginMethod(loginTool);
            refreshPluginAuthStatus(view.pluginId);
          } catch (err) {
            // Raw err.message may carry OAuth/Bearer fragments — keep raw in
            // console only, and surface a sanitized code-oriented message.
            console.warn(
              `[plugin-auth] ${view.pluginId} loginTool '${loginTool}' failed`,
              err,
            );
            pendingMap.delete(view.pluginId);
            failedPluginAuthOpenRef.current.add(view.pluginId);
            const message = formatPluginAuthLoginError(err);
            setPluginAuthErrors((prev) => {
              const next = new Map(prev);
              next.set(view.pluginId, message);
              return next;
            });
            statusPushToast({ severity: "error", message, ttlMs: 10000 });
          } finally {
            pluginAuthLoginInflightRef.current.delete(inflightKey);
          }
        })();
        return;
      }
      // Chat mode: built-in detachable views open in a separate window; home
      // (and every work-mode path) stays inline.
      if (
        appMode === "chat" &&
        (key === "work-board" ||
          key === "routines" ||
          key === "memory" ||
          key === "starred")
      ) {
        void openDetachedBuiltInView(key);
        return;
      }
      setActiveView(key);
    },
    [
      api,
      appMode,
      pluginViews,
      pluginCards,
      pluginAuthStatuses,
      openDetachedPluginView,
      openDetachedBuiltInView,
      setErrorWithThought,
      refreshPluginAuthStatus,
      clearPluginAuthError,
      formatPluginAuthLoginError,
      statusPushToast,
    ],
  );

  useEffect(() => {
    if (typeof api.onNotificationClicked !== "function") return undefined;
    return api.onNotificationClicked((payload) => {
      const contextRef = payload.contextRef;
      if (contextRef?.sessionId) {
        setActiveView("home");
        void handleLoadSessionAndRefresh(contextRef.sessionId);
        return;
      }
      if (payload.kind === "approval" || contextRef?.approvalId) {
        setActiveView("home");
        if (approvalQueue.length === 0) setDeferredQueueOpen(true);
        return;
      }
      if (payload.kind === "routine" || contextRef?.routineId) {
        handleViewSelect("routines");
        return;
      }
      if (payload.kind === "ask-user" || contextRef?.questionId) {
        setActiveView("home");
        return;
      }
      setActiveView("home");
    });
  }, [api, approvalQueue.length, handleLoadSessionAndRefresh, handleViewSelect]);

  // Auth gate drain — when a plugin the user selected while unauthed
  // transitions to authed (the usePluginAuthStatuses hook updates the map on
  // `${id}.auth.changed` or a manual refresh), open the panel/page that was
  // deferred. Only authed opens; an `error` status clears the pending entry
  // without silently navigating.
  useEffect(() => {
    if (
      pendingDetachedAuthOpenRef.current.size === 0 &&
      pendingInlineAuthOpenRef.current.size === 0
    ) return;
    for (const [pluginId, viewKey] of [...pendingDetachedAuthOpenRef.current]) {
      if (failedPluginAuthOpenRef.current.has(pluginId)) {
        pendingDetachedAuthOpenRef.current.delete(pluginId);
        continue;
      }
      const kind = pluginAuthStatuses.get(pluginId)?.kind;
      if (kind === "authed") {
        pendingDetachedAuthOpenRef.current.delete(pluginId);
        void openDetachedPluginView(viewKey);
      } else if (kind === "error") {
        pendingDetachedAuthOpenRef.current.delete(pluginId);
      }
    }
    for (const [pluginId, viewKey] of [...pendingInlineAuthOpenRef.current]) {
      if (failedPluginAuthOpenRef.current.has(pluginId)) {
        pendingInlineAuthOpenRef.current.delete(pluginId);
        continue;
      }
      const kind = pluginAuthStatuses.get(pluginId)?.kind;
      if (kind === "authed") {
        pendingInlineAuthOpenRef.current.delete(pluginId);
        setActiveView(viewKey);
      } else if (kind === "error") {
        pendingInlineAuthOpenRef.current.delete(pluginId);
      }
    }
  }, [pluginAuthStatuses, openDetachedPluginView]);

  useEffect(() => {
    setPluginAuthErrors((prev) => {
      let next: Map<string, string> | null = null;
      for (const pluginId of prev.keys()) {
        if (pluginAuthStatuses.get(pluginId)?.kind === "authed") {
          next ??= new Map(prev);
          next.delete(pluginId);
          failedPluginAuthOpenRef.current.delete(pluginId);
        }
      }
      return next ?? prev;
    });
  }, [pluginAuthStatuses]);

  // If the currently-open plugin view belongs to a plugin that just got
  // uninstalled, fall back to home so the renderer doesn't render a "view
  // not found" placeholder for a stale plugin id.
  useEffect(() => {
    if (!activeView.startsWith("plugin:")) return;
    if (activePluginView) return;
    setActiveView("home");
  }, [activeView, activePluginView]);

  // Inline settings exists only in work mode. Switching to chat mode while it
  // is open returns to home so chat mode's detached-Settings contract holds (a
  // subsequent sidebar Settings click then opens the detached BrowserWindow).
  useEffect(() => {
    if (appMode === "chat" && activeView === "settings") {
      setActiveView(settingsReturnViewRef.current === "settings" ? "home" : settingsReturnViewRef.current);
    }
  }, [appMode, activeView]);

  const checkApiKey = useCallback(async () => { const h = await api.hasApiKey(); setHasApiKey(h); return h; }, [api]);

  // Z onboarding chain — first-boot probe.
  //
  // Runs once on mount: when the user already has a vendor key or the
  // onboardingCompleted flag is set, the chain stays at `idle` and
  // resolves directly to `done`. Otherwise the reducer advances to
  // `showcase` which mounts the ScenarioShowcase intro screen. All
  // subsequent transitions are driven by user actions on the in-chain
  // dialogs (NOT by additional IPC probes), so the funnel is fully
  // deterministic and easy to reason about.
  // `bootProbeGen` is the explicit re-run gate. Initial mount fires the
  // probe once at gen=0; the logout broadcast bumps the generation so the
  // same effect re-evaluates `onboardingCompleted` / vendor keys on top of
  // the freshly-cleared state. Without this the original `firstBootProbedRef`
  // boolean gate (now removed) prevented logout from re-entering the
  // ScenarioShowcase.
  const [bootProbeGen, setBootProbeGen] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Populate `hasApiKey` state up-front so the downstream
        // `effectiveHasApiKey` mask can resolve to a concrete boolean
        // the moment the chain advances to `done`. Without this the
        // boot probe only dispatched chain events; `hasApiKey` stayed
        // `null` until the user opened+saved Settings, producing the
        // "로그인된 척" race (#1014 tracer Stage B).
        void checkApiKey();
        const settings = await api.getSettings();
        if (cancelled) return;
        const demoStatus = await api.demo.status().catch(() => null);
        if (cancelled) return;
        if (shouldOpenDemoReactivationOnBoot(settings, demoStatus)) {
          dispatchChain({ type: "probe-skip" });
          setReactivationOpen(true);
          return;
        }
        if (settings.features?.onboardingCompleted === true) {
          dispatchChain({ type: "probe-skip" });
          return;
        }
        // Returning user who already saw the first-boot SpotlightTour — skip
        // the chain even if `onboardingCompleted` was never persisted. That
        // flag only flips at the `done` stage (after PluginShowcase closes,
        // two stages past the tour), so a user who finished the tour but quit
        // before closing PluginShowcase left it `false` and the spotlight
        // re-appeared on every launch. The tour-state store is the source of
        // truth for "has seen the tour"; the boot probe previously ignored it.
        const tourState = await api.tour.getState().catch(() => null);
        if (cancelled) return;
        if (hasSeenFirstBootTour(tourState)) {
          dispatchChain({ type: "probe-skip" });
          return;
        }
        const anyKey = await Promise.all(
          LLM_VENDORS.map((v) => api.hasApiKey(v).catch(() => false)),
        );
        if (cancelled) return;
        if (anyKey.some(Boolean)) {
          // Existing-install flow — skip the whole Z chain so returning
          // users are never prompted to re-seed identity.
          dispatchChain({ type: "probe-skip" });
          return;
        }
        dispatchChain({ type: "probe-start" });
      } catch {
        // Probe failure is non-fatal — chat still works once a key exists.
        dispatchChain({ type: "probe-skip" });
      }
    })();
    return () => { cancelled = true; };
  }, [api, checkApiKey, bootProbeGen]);

  const markOnboardingCompleted = useCallback(async () => {
    try {
      await api.updateSettings({ features: { onboardingCompleted: true } });
    } catch {
      // Persist failure is non-fatal; the dialog still dismisses for the
      // current session even if the disk write fails.
    }
  }, [api]);

  // Z onboarding chain — persist completion + auto-trigger SpotlightTour.
  // Side-effects driven by the reducer state:
  //   - tour stage:    fan the host's tour broadcast so SpotlightTour
  //                    mounts the first-boot scenario without depending
  //                    on MemorySeedDialog firing the trigger itself.
  //   - done stage:    flip `features.onboardingCompleted=true` once so
  //                    the next boot skips the entire chain (idempotent
  //                    via the markOnboardingCompleted helper above).
  //
  // Both side-effects are guarded by a per-run ref so React 18 StrictMode's
  // double-invoked dev-mode effects (mount → cleanup → mount) cannot
  // broadcast `tour.start` twice — without the guard the second mount
  // re-fires the IPC, which re-enters the SpotlightTour subscriber and
  // visibly resets the scenario to step 0 ("스팟하이라이트 시퀀스가 2번 노출"
  // — user report 2026-05-19). The ref also protects against incidental
  // re-renders that change `api` / `markOnboardingCompleted` while
  // `chainStage === "tour"` stays pinned.
  const chainCompletionPersistedRef = useRef(false);
  const chainTourBroadcastRef = useRef(false);
  useEffect(() => {
    if (chainStage === "tour") {
      if (chainTourBroadcastRef.current) return;
      chainTourBroadcastRef.current = true;
      try {
        void api.tour.start("first-boot-essentials");
      } catch {
        // tour.start failure is non-fatal — user can still reach the
        // PluginShowcase via the SpotlightTour onComplete callback path
        // by pressing 다음 from within the tour.
      }
      return;
    }
    if (chainStage === "done" && !chainCompletionPersistedRef.current) {
      chainCompletionPersistedRef.current = true;
      void markOnboardingCompleted();
    }
  }, [api, chainStage, markOnboardingCompleted]);

  // appMode is the SOLE authority for inline-vs-detached, mirroring the other
  // views (업무보드/루틴/메모리/별표 + plugin views). In work mode Settings
  // joins that inline pattern: setActiveView("settings") + MainContent renders
  // SettingsContent inline. In chat mode Settings keeps the existing detached
  // BrowserWindow path untouched. Re-selecting Settings while already on the
  // inline view is a no-op (only the tab is refreshed) so the view never
  // re-mounts and loses its place.
  const onOpenSettings = useCallback((tab = "llm") => {
    if (appMode === "chat") {
      void api.openSettingsWindow(tab);
      return;
    }
    setSettingsTab(normalizeSettingsTab(tab));
    setActiveView((current) => {
      // Only capture the return view on the first entry into settings; a
      // re-click while already inline must not overwrite it with "settings".
      if (current !== "settings") settingsReturnViewRef.current = current;
      return "settings";
    });
  }, [api, appMode]);

  const handleCloseInlineSettings = useCallback(() => {
    const target = settingsReturnViewRef.current;
    setActiveView(target === "settings" ? "home" : target);
  }, []);

  // Inline settings save → refresh the same live state the detached window's
  // onSettingsWindowSaved listener refreshes (api key + LLM settings), without
  // an IPC round-trip since the content renders in-process.
  const handleInlineSettingsSaved = useCallback(() => {
    void checkApiKey();
    void refreshLlmSettings();
  }, [checkApiKey, refreshLlmSettings]);

  useEffect(() => {
    return api.onSettingsWindowSaved(() => {
      void checkApiKey();
      void refreshLlmSettings();
    });
  }, [api, checkApiKey, refreshLlmSettings]);

  // 2026-05-20 — Settings 의 로그아웃 / 데모 자격증명 재입력 broadcast 수신.
  //
  // 로그아웃 cue:
  //   1. chain reducer 에 `logout-reset` dispatch → 모든 stage 가 `idle` 로 collapse
  //   2. boot-probe ref 를 리셋해 onboardingCompleted=false 가 다시 평가됨
  //   3. side-effect ref (`chainTourBroadcastRef`, `chainCompletionPersistedRef`)
  //      도 reset 해서 재진입 chain 의 tour broadcast / completion persist 가
  //      한 번씩 다시 동작 가능하게 됨
  //   4. `hasApiKey` 를 다시 평가
  //
  // 재입력 cue:
  //   LoginModal 을 `forceActivation=true` 로 mount.
  useEffect(() => {
    // 일부 test fixture 가 `api.auth` 의 broadcast 메서드를 mock 하지 않으므로
    // optional chaining 으로 graceful degradation. production preload 는 항상
    // 두 메서드를 정의하고, undefined 일 때는 listener 만 비활성 (전체 effect 가
    // throw 하지 않는다).
    const unsubLogout = api.auth?.onLogoutReset?.(() => {
      dispatchChain({ type: "logout-reset" });
      chainTourBroadcastRef.current = false;
      chainCompletionPersistedRef.current = false;
      // Bump the boot-probe generation so the existing probe effect re-runs
      // against the now-cleared settings (`onboardingCompleted=false`) and
      // wipes-clear vendor keys. Without this the chain would stay at `idle`
      // forever because `dispatchChain({logout-reset})` collapses to idle
      // but no follow-up `probe-start` ever fires.
      setBootProbeGen((g) => g + 1);
      void checkApiKey();
    });
    const unsubReactivate = api.auth?.onReactivateDemo?.(() => {
      setReactivationOpen(true);
    });
    return () => {
      unsubLogout?.();
      unsubReactivate?.();
    };
  }, [api, checkApiKey]);

  // Tutorial-C SpotlightTour trigger (PR #983 follow-up). ⌘+Shift+/ ("⌘?")
  // is the canonical "help" shortcut on macOS; on Windows/Linux Ctrl+Shift+/
  // serves the same role. The handler fires `api.tour.start` which fans the
  // `lvis:tour:start` IPC broadcast out to every open window — including
  // detached panes — so the SpotlightTour component (always mounted in
  // App.tsx) flips on. Guarded against open dialogs so the shortcut never
  // races a modal interaction.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "?" && e.key !== "/") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!e.shiftKey) return;
      if (e.isComposing) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      e.preventDefault();
      void api.tour.start("first-boot-essentials");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [api]);

  const composeOutgoing = useCallback(
    (raw: string) => composeOutgoingUtil({ raw, activePreset, attachments }),
    [activePreset, attachments],
  );

  const handleAsk = useCallback(
    async (
      q: string,
      mode: "default" | "trigger-import" = "default",
      userIntent?: UserKeyboardIntentSnapshot,
      opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
    ) => {
      // Cache once per invocation — `window.lvis.env.debugStream` is fixed at
      // preload bootstrap, so reading it again per debugLog call is wasted
      // work. Guarding each call site with the cached flag also skips the
      // payload object allocation when diagnostics are off (#566 item 1).
      const debugStreamEnabled = isDebugStreamEnabled();
      if (debugStreamEnabled) debugLog("handleAsk", "enter", { mode, qLen: q.length, streaming });
      const trimmed = q.trim();
      if (!trimmed) {
        if (debugStreamEnabled) debugLog("handleAsk", "skip:empty");
        return;
      }
      if (mode === "default" && streaming) {
        // Issue #622: interrupt the current turn and start a new one.
        // chatAbort awaits until the active stream turn settles (interrupted),
        // then returns. The in-flight turn's finally block calls
        // finishStreamingRequest; the turnRequestRef increment below makes
        // its requestId stale so the call is a safe no-op. Partial response
        // is committed to history by post-turn-hook-chain with
        // stopReason="interrupted".
        if (debugStreamEnabled) debugLog("handleAsk", "interrupt:abort-and-proceed");
        try { await api.chatAbort(); } catch { /* no-op */ }
      }
      // Renderer only performs UX-level shortcuts for typed composer input.
      // Main owns the authoritative trust-origin classification.
      // queue-auto path 는 slash command 분기 우회 — 큐에 누적된 /compact,
      // /load 가 silent execute 되는 회귀 차단 (Round 3 critic C1-NEW).
      // 큐는 단순 user message inject 로만 동작 — slash command literal 은
      // LLM 에 plain text 로 전달.
      if (mode === "default" && opts?.inputOrigin !== "queue-auto") {
        if (await handleCompactCommand(trimmed)) {
          if (debugStreamEnabled) debugLog("handleAsk", "skip:compact-command-handled");
          setQuestion("");
          return;
        }
        if (trimmed === "/load" || trimmed.startsWith("/load ")) {
          const requested = trimmed.slice("/load".length).trim();
          if (requested.length === 0) {
            setErrorWithThought(t("app.loadCommandUsage"));
            return;
          }
          const listed = await api.chatSessions();
          const match = listed.sessions.find((session) => session.id.startsWith(requested));
          if (!match) {
            setErrorWithThought(t("app.sessionNotFound", { requested }));
            return;
          }
          await sessionLoad(match.id, false, applyLoadedSession);
          await refreshSessionId();
          await refreshSessions();
          if (debugStreamEnabled) debugLog("handleAsk", "load-session:handled", { sessionId: match.id });
          return;
        }
      }
      if (!(await checkApiKey())) {
        onOpenSettings("llm");
        return;
      }
      const requestId = ++turnRequestRef.current;
      const streamingRequestId = beginStreamingRequest();
      if (debugStreamEnabled) debugLog("handleAsk", "begin", { requestId, streamingRequestId });
      setQuestion("");
      const composed = mode === "trigger-import"
        ? composeImportedTriggerOutgoing(trimmed)
        : composeOutgoing(trimmed);
      const outgoing = composed.text;
      // queue-auto path 는 큐 schema (텍스트 only) 라 사용자가 별도로 추가한
      // 첨부 파일이 따라가면 mental model 위배 + silent corruption (Round 3
      // code-reviewer CRITICAL). queue-auto 시 attachments 강제 빈 배열.
      let outgoingAttachments = opts?.inputOrigin === "queue-auto" ? [] : composed.attachments;
      // Vendor vision capability gate. The composer accepts images
      // regardless of the active model so the user can switch models
      // freely; check at send time and confirm before silently dropping
      // image parts on a text-only model.
      const hasImageParts = outgoingAttachments.some((p) => p.type === "image");
      if (hasImageParts && !supportsVision(llmVendor, llmModel)) {
        const proceed = window.confirm(t("app.visionNotSupportedConfirm", { llmModel }));
        if (!proceed) {
          // Restore the original (untrimmed) draft text so the user can
          // switch models and resend without retyping. We use `q` rather
          // than `t = q.trim()` to preserve any intentional leading /
          // trailing whitespace or newlines the user typed. setQuestion("")
          // was called above before we knew about this guard branch.
          setQuestion(q);
          if (turnRequestRef.current === requestId) finishStreamingRequest(streamingRequestId);
          return;
        }
        outgoingAttachments = outgoingAttachments.filter((p) => p.type !== "image");
      }
      // trigger-import: skip only the user-bubble append. The imported_trigger
      // marker already represents the plugin-authored overlay prompt
      // visibly, and rendering the wrapped envelope as a user bubble
      // would misattribute authorship.
      if (mode !== "trigger-import") {
        appendUserEntry(trimmed, opts?.injectHint);
      }
      resetStreamAccumulators();
      try {
        await api.chatSend(
          outgoing,
          outgoingAttachments,
          opts?.inputOrigin === "queue-auto"
            ? "queue-auto"
            : mode === "trigger-import"
              ? "plugin-emitted"
              : "user-keyboard",
          // queue-auto path 는 user gesture 없이 IPC stream context 에서
          // 발생하므로 userIntent 전달 안 함 (validator 가 userActivation
          // 검사 우회).
          opts?.inputOrigin === "queue-auto"
            ? undefined
            : mode === "default" ? userIntent : undefined,
          opts?.inputOrigin === "queue-auto"
            ? undefined
            : mode === "default" ? composed.personaPromptId : undefined,
        );
        if (debugStreamEnabled) debugLog("handleAsk", "chatSend:resolved", { requestId });
        // After successful send, clear attachments — the textarea was
        // already cleared by setQuestion(""). N counter persists across
        // turns so re-attached items get fresh numbers.
        if (outgoingAttachments.length > 0 || attachments.length > 0) {
          setAttachments([]);
        }
      } catch (err) {
        if (debugStreamEnabled) {
          debugLog("handleAsk", "chatSend:rejected", {
            requestId,
            err: (err as Error)?.message,
          });
        }
        setErrorWithThought(t("app.errorGeneric", { message: (err as Error).message }));
      } finally {
        const turnMatch = turnRequestRef.current === requestId;
        if (debugStreamEnabled) {
          debugLog("handleAsk", "finally", {
            requestId,
            currentTurnRef: turnRequestRef.current,
            turnMatch,
            willCallFinish: turnMatch,
          });
        }
        if (turnMatch) finishStreamingRequest(streamingRequestId);
      }
    },
    [
      api,
      streaming,
      checkApiKey,
      composeOutgoing,
      appendUserEntry,
      resetStreamAccumulators,
      beginStreamingRequest,
      finishStreamingRequest,
      setErrorWithThought,
      handleCompactCommand,
      sessionLoad,
      applyLoadedSession,
      refreshSessionId,
      refreshSessions,
      // attachments is read directly at the post-send cleanup branch
      // (line ~260) and is also a transitive dep via composeOutgoing,
      // but listing it explicitly avoids stale-closure surprises if
      // composeOutgoing's deps drift. llmVendor/llmModel are read by
      // the supportsVision gate.
      attachments,
      llmVendor,
      llmModel,
      onOpenSettings,
    ],
  );
  // Keep ref in sync so handlePluginPrimaryAction can call handleAsk
  // without a forward-declaration error (ref is populated before first use).
  handleAskRef.current = handleAsk;

  const { costEstimate, costBadgeClass } =
    useCostEstimate({ entries, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing });
  // Strict variant — `undefined` means "model not in catalog" so the cost
  // toggle in TokenCostBadge stays disabled rather than showing $0 from
  // FALLBACK_PRICING.
  const activePricing = useMemo(
    () => lookupBillablePricingOptional(llmVendor, llmModel),
    [llmVendor, llmModel],
  );

  const handleNewChat = useCallback(async () => {
    if (streaming) { console.warn("new chat blocked during streaming"); return; }
    await api.chatNew();
    clearForNewChat();
    resetForNewSession();
    setActiveView("home");
    await refreshSessionId();
    await refreshSessions();
  }, [api, streaming, refreshSessionId, refreshSessions, clearForNewChat, resetForNewSession]);

  // ─── Effects ──────────────────────────────────
  const toggleCommandPopover = useCallback(() => {
    if (activeView !== "home") {
      setActiveView("home");
      setCommandPopoverOpen(true);
    } else {
      setCommandPopoverOpen((prev) => !prev);
    }
  }, [activeView]);

  useAppBootstrap({
    api, refreshViews, refreshCards: async () => { await refreshCards(); }, checkApiKey,
    setActiveView,
    toggleCommandPopover,
  });
  // Refresh plugin views + marketplace catalog when a lvis:// deep-link
  // install completes in the main process, so new plugin entries appear
  // (and uninstalled ones disappear) without requiring an app restart.
  useEffect(() => {
    if (typeof api.onPluginInstallResult !== "function") return;
    const unsubscribe = api.onPluginInstallResult(({ success }) => {
      if (!success) return;
      void refreshViews();
      void refreshMarketplace();
      void refreshCards();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshMarketplace, refreshCards]);

  useEffect(() => {
    if (typeof api.onPluginRuntimeUpdated !== "function") return;
    const unsubscribe = api.onPluginRuntimeUpdated(() => {
      void refreshViews();
      void refreshCards();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshCards]);

  useEffect(() => {
    if (typeof api.onPluginInstallProgress !== "function") return;
    const unsubscribe = api.onPluginInstallProgress((payload) => {
      if (payload.phase !== "preparing") return;
      void refreshCards();
      void refreshViews();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshCards]);

  useEffect(() => {
    if (!hasPreparingPlugin) return;
    const refresh = () => {
      void refreshCards();
      void refreshViews();
    };
    refresh();
    const interval = window.setInterval(refresh, 750);
    return () => window.clearInterval(interval);
  }, [hasPreparingPlugin, refreshViews, refreshCards]);

  // Same lifecycle for uninstall — PluginConfigTab and any other surface
  // drive uninstall through the IPC handler which now broadcasts a result
  // event. Without this subscription plugin entry state would stay stale
  // until the app reloads.
  useEffect(() => {
    if (typeof api.onPluginUninstallResult !== "function") return;
    const unsubscribe = api.onPluginUninstallResult(({ success }) => {
      if (!success) return;
      void refreshViews();
      void refreshMarketplace();
      void refreshCards();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshMarketplace, refreshCards]);

  useEffect(() => {
    const unsubs = [
      api.onAgentInstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
      api.onAgentUninstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
      api.onSkillInstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
      api.onSkillUninstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
    ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");
    return () => {
      for (const unsubscribe of unsubs) unsubscribe();
    };
  }, [api, refreshMarketplace]);

  // Auto-close CommandPopover when navigating away from home — the popover
  // is only mounted on the home view so leaving it open causes stuck state.
  useEffect(() => {
    if (activeView !== "home") setCommandPopoverOpen(false);
  }, [activeView]);

  const commandActions = useMemo(
    () =>
      buildQuickActions({
        setActiveView: handleViewSelect,
        openSettings: onOpenSettings,
        handleNewChat,
        pluginViews,
      }),
    [pluginViews, handleNewChat, handleViewSelect, onOpenSettings],
  );

  const actionPanelActivity = useMemo<ActionPanelActivityState>(() => {
    const activity: ActionPanelActivityState = {
      readFileCount: 0,
      writtenFileCount: 0,
      mcpCallCount: 0,
      pluginCallCount: 0,
      toolCallCount: 0,
      fetchedPageCount: 0,
      readFiles: [],
      writtenFiles: [],
      pluginCalls: [],
      mcpCalls: [],
      fetchedPages: [],
    };
    const visibleEntries = entries as ChatEntry[];
    const readFileKeys = new Set<string>();
    const writtenFileKeys = new Set<string>();
    const fetchedPageKeys = new Set<string>();

    for (let entryIndex = visibleEntries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = visibleEntries[entryIndex];
      if (entry.kind !== "tool_group") continue;

      for (let toolIndex = entry.tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
        const tool = entry.tools[toolIndex];
        const source = formatToolSource(tool);
        const sourceDetail = source || (isTerminalTool(tool) ? "terminal" : isBrowserTool(tool) ? "web" : undefined);

        activity.toolCallCount += 1;
        if (isPluginTool(tool)) {
          activity.pluginCallCount += 1;
          addUniqueActivity(activity.pluginCalls, {
            id: `plugin:${tool.toolUseId}`,
            label: tool.name,
            detail: tool.pluginId ?? sourceDetail,
            status: tool.status,
          }, ACTION_PANEL_ICON_LIMIT);
        }

        if (tool.source === "mcp" || tool.mcpServerId) {
          activity.mcpCallCount += 1;
          addUniqueActivity(activity.mcpCalls, {
            id: `mcp:${tool.toolUseId}`,
            label: tool.name,
            detail: tool.mcpServerId ?? sourceDetail,
            status: tool.status,
          }, ACTION_PANEL_ICON_LIMIT);
        }

        if (isBrowserTool(tool)) {
          for (const url of new Set(collectUrls(tool.input))) {
            if (!fetchedPageKeys.has(url)) {
              fetchedPageKeys.add(url);
              activity.fetchedPageCount += 1;
            }
            addUniqueActivity(activity.fetchedPages, {
              id: `url:${tool.toolUseId}:${url}`,
              label: formatUrlOrigin(url),
              detail: url,
              target: url,
              status: tool.status,
            });
          }
        }

        if (isFileChangeTool(tool)) {
          for (const path of new Set(collectPathStrings(tool.input))) {
            if (!writtenFileKeys.has(path)) {
              writtenFileKeys.add(path);
              activity.writtenFileCount += 1;
            }
            addUniqueActivity(activity.writtenFiles, {
              id: `write:${tool.toolUseId}:${path}`,
              label: path,
              detail: tool.name,
              status: tool.status,
            });
          }
        } else if (isReadTool(tool)) {
          for (const path of new Set(collectPathStrings(tool.input))) {
            if (!readFileKeys.has(path)) {
              readFileKeys.add(path);
              activity.readFileCount += 1;
            }
            addUniqueActivity(activity.readFiles, {
              id: `read:${tool.toolUseId}:${path}`,
              label: path,
              detail: tool.name,
              status: tool.status,
            });
          }
        }
      }
    }

    return activity;
  }, [entries]);

  const openActionPanelUrl = useCallback((url: string) => {
    void api.openExternalUrl(url);
  }, [api]);

  const onNewChat = useCallback(() => { void handleNewChat(); }, [handleNewChat]);
  const handleMarketplaceAnnouncementDismiss = useCallback(
    (id: number) => {
      dismissMarketplaceAnnouncement(id).catch((err) => {
        console.error(
          "[marketplace-announcement] dismiss persistence failed",
          err,
        );
      });
    },
    [dismissMarketplaceAnnouncement],
  );

  // ChatView context bundle — avoids drilling ~40 props through the tree.
  //
  // Mask `hasApiKey === false` while the onboarding chain is still in
  // progress so the "Claude API 키 설정 필요" empty state never paints
  // underneath the Z chain dialogs. The chain itself is the canonical
  // first-boot CTA; surfacing a competing empty state below it leaks
  // through the Radix Dialog backdrop and confuses the user (the bug
  // this fix resolves). Returning users with `chainStage === "done"`
  // (probe-skip or chain completion) still see the empty state when
  // they remove their key from Settings, so the safety-net behaviour
  // for that path is preserved.
  // Tracer Stage B race fix (#1014): only surface the boolean when BOTH
  // (a) the Z chain has finished AND (b) the boot probe has resolved
  // `hasApiKey` to a concrete boolean. Any other state — chain still
  // running, or probe still pending — returns `null` so downstream
  // empty-state branches stay in their loading shape. This prevents the
  // "로그인된 척" race where chain advanced to `done` but `hasApiKey`
  // hadn't been populated yet, letting `hasApiKey !== false` falsely
  // paint the ready-state empty prompt.
  const effectiveHasApiKey: boolean | null =
    chainStage === "done" && hasApiKey !== null ? hasApiKey : null;
  const chatContextValue = useChatContextValue({
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId, hasApiKey: effectiveHasApiKey, onOpenSettings,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay, searchToggleOverlay,
    contextOverflowPct, usedTokens, contextBudget, effectiveBudget,
    tpmLimit, tpmPct, isTpmOverflow,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachments, setAttachments, attachmentNCounter,
    enableThinkingChat, toggleThinking, costEstimate, costBadgeClass,
    activePricing,
    activeVendor: llmVendor,
  });

  // Issue #260 — when a notification toast is clicked, dispatch the click via
  // notifyClick IPC (which restores+focuses the window) and dismiss the
  // toast. Other toast producers leave `notification` undefined so this
  // handler is a no-op for them.
  // Show a persistent StatusBar indicator while a pre-turn auto-compact runs.
  // `compact_started` sets isCompacting → this effect upserts the item.
  // `compact_notice` clears isCompacting → this effect removes the item.
  // Issue #916: force-recover (autoCompact OFF-override) shows a distinct label.
  useEffect(() => {
    const COMPACT_ITEM_ID = "auto-compact-in-progress";
    if (isCompacting) {
      const isForceRecover = compactTriggerSource === "force-recover";
      const isRateLimitRecover = compactTriggerSource === "rate-limit";
      statusUpsertPersistent({
        id: COMPACT_ITEM_ID,
        severity: isForceRecover || isRateLimitRecover ? "warning" : "info",
        label: t("app.compactStatusLabel"),
        value: isForceRecover
          ? t("app.compactForceRecoverValue")
          : isRateLimitRecover
            ? t("app.compactRateLimitValue")
            : t("app.compactInProgressValue"),
      });
    } else {
      statusRemovePersistent(COMPACT_ITEM_ID);
    }
  }, [isCompacting, compactTriggerSource, statusUpsertPersistent, statusRemovePersistent]);

  // Issue #917: show a persistent warning banner when force-recover budget is exhausted.
  // Cleared when the user starts a new chat (clearForNewChat resets isRecoveryExhausted).
  useEffect(() => {
    const EXHAUSTED_ITEM_ID = "recovery-exhausted";
    if (isRecoveryExhausted) {
      statusUpsertPersistent({
        id: EXHAUSTED_ITEM_ID,
        severity: "error",
        label: t("app.compactExhaustedLabel"),
        value: t("app.compactExhaustedValue"),
      });
    } else {
      statusRemovePersistent(EXHAUSTED_ITEM_ID);
    }
  }, [isRecoveryExhausted, statusUpsertPersistent, statusRemovePersistent]);

  const handleStatusToastClick = useCallback(
    (toast: { id: string; notification?: NotificationToastMeta }) => {
      if (!toast.notification) return;
      try {
        void api.notifyClick?.({
          kind: toast.notification.kind,
          contextRef: toast.notification.contextRef,
        });
      } catch {
        // notifyClick is best-effort UX; failure must not crash the bar.
      }
      statusRemoveToast(toast.id);
    },
    [api, statusRemoveToast],
  );

  // ─── Render ───────────────────────────────────
  return (
    <ErrorBoundary fallback={t("app.appErrorFallback")}>
    <ThemeProvider api={api}>
    <TooltipProvider>
    <OverlayContextProvider
      onOpenSession={handleOpenRoutineSession}
      addFireRef={addFireRef}
      runningRoutines={runningRoutines}
    >
        {/* `relative` makes THIS full-height shell column the positioning
            context for the floating-card Sidebar, so the card's `top-0` reaches
            the window top — extending UP into the traffic-light band and
            reclaiming that vertical space on the left. */}
        <div className="relative flex h-screen flex-col overflow-hidden">
          {/* Single top band — window controls + the app toolbar cluster live
              together here. The toolbar content is passed as children so it
              renders IN the band (no separate toolbar row below it). */}
          <CustomTitleBar>
            <MainToolbar
              activeView={activeView}
              streaming={streaming}
              hasApiKey={effectiveHasApiKey}
              appMode={appMode}
              onToggleAppMode={setAppMode}
              onOpenDevTools={() => setDevToolsOpen((v) => !v)}
              appUpdateState={appUpdate.state}
              appUpdateInFlight={appUpdate.inFlight}
              onDownloadAppUpdate={appUpdate.download}
              onInstallAppUpdate={appUpdate.install}
              onSkipAppUpdate={appUpdate.skip}
            />
          </CustomTitleBar>
        {/* The floating-card Sidebar is anchored against the full-height shell
            column above (NOT this content row) so its `top-0` spans up into the
            band. The content `<main>` carries left padding equal to the card
            width + insets so the rail never occludes the canvas. */}
        <Sidebar
          activeView={activeView}
          onSelect={handleViewSelect}
          pluginViews={pluginViews}
          pluginAuthStatuses={pluginAuthStatuses}
          hasApiKey={effectiveHasApiKey}
          onOpenSettings={() => onOpenSettings()}
          onNewChat={onNewChat}
          streaming={streaming}
          onOpenMarketplace={onOpenMarketplace}
          marketplaceUrlReady={marketplaceUrlReady}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
          onOpenUnifiedSearch={() => {
            searchOpenOverlay();
          }}
          isCurrentSessionStarred={Boolean(currentSessionId && isSessionStarred(currentSessionId))}
          onToggleCurrentSessionStar={() => currentSessionId
            ? handleToggleSessionStar(currentSessionId, sessions.find((s) => s.id === currentSessionId)?.title)
            : Promise.resolve()}
          onExport={handleExport}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <main
          className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-background transition-[padding] duration-200 ease-out motion-reduce:transition-none ${
            sidebarCollapsed ? "pl-[4rem]" : "pl-[14.5rem]"
          }`}
        >
          {/* Floating notification stack — update/announcement banners are an
              OVERLAY, not in-flow content. They float over the canvas anchored
              top-RIGHT so they never push MainContent or the composer down. The
              wrapper is pointer-events-none (clicks pass through the gaps); each
              banner card re-enables pointer-events so Update/dismiss still work.
              The left edge is inset by the sidebar width (`left-[4.5rem]` /
              `left-[15rem]`, tracking <main>'s collapsed/expanded padding) so a
              wide banner (max-w-md) in a narrow window can never slide UNDER the
              floating sidebar card — absolute positioning resolves against
              main's padding box, which starts at the window edge beneath the
              rail. Multiple DISTINCT banners (bootstrap / update / announcement)
              stack vertically; each component collapses its own N items into a
              single counted card, so the stack height stays bounded. */}
          <div
            className={`pointer-events-none absolute right-2 top-2 z-50 ml-auto flex max-w-md flex-col gap-2 transition-[left] duration-200 ease-out motion-reduce:transition-none [&>*]:pointer-events-auto [&>*]:m-0 ${
              sidebarCollapsed ? "left-[4.5rem]" : "left-[15rem]"
            }`}
          >
            <BootstrapStatusBanner status={bootstrapStatus} onDismiss={dismissBootstrapStatus} onRetry={() => void retryBootstrap()} />
            <MarketplaceUpdateBanner
              updates={marketplaceUpdates}
              onDismiss={dismissMarketplaceUpdates}
              onSkip={skipMarketplaceUpdates}
              onUpdate={installPlugin}
            />
            <MarketplaceAnnouncementBanner
              announcements={marketplaceAnnouncements}
              onDismiss={handleMarketplaceAnnouncementDismiss}
            />
          </div>
          {fallbackToast && (
            <div className="bg-warning text-warning-foreground text-xs px-4 py-2 border-b border-warning">
              {fallbackToast}
            </div>
          )}
          <DevToolsPanel
            api={api}
            open={devToolsOpen}
            onClose={() => setDevToolsOpen(false)}
          />
          {searchOpen && (
            <UnifiedSearchPanel
              api={api}
              open={searchOpen}
              query={searchQuery}
              caseSensitive={searchCase}
              entries={entries}
              conversationMatches={searchMatches}
              currentConversationMatch={searchIdx}
              sessions={sessions}
              starred={starred}
              onChangeQuery={searchChangeQuery}
              onToggleCase={searchToggleCase}
              onNextConversationMatch={searchNext}
              onPrevConversationMatch={searchPrev}
              onJumpToConversationMatch={(matchIndex) => {
                setActiveView("home");
                searchJumpToMatch(matchIndex);
              }}
              onOpen={searchOpenOverlay}
              onClose={searchCloseOverlay}
              onLoadSession={async (sessionId) => {
                const loaded = await handleLoadSessionAndRefresh(sessionId);
                if (loaded !== false) setActiveView("home");
                return loaded;
              }}
              onOpenMemoryView={() => {
                setActiveView("memory");
                searchCloseOverlay();
              }}
              onOpenRoutinesView={() => {
                setActiveView("routines");
                searchCloseOverlay();
              }}
              currentSessionId={currentSessionId}
              streaming={streaming}
              onRefreshSessions={refreshSessions}
              onJumpToEntry={(entryIndex) => {
                // Calendar popover in the search bar jumps to entries tagged
                // with data-chat-entry-index in ChatView. Switch the view to
                // home before scrolling so the entry is mounted.
                // ChatView (and its Suspense-wrapped children) may not be in
                // the DOM at the next paint — retry a bounded number of
                // frames so the scroll lands once mount completes.
                if (!Number.isInteger(entryIndex) || entryIndex < 0) return;
                setActiveView("home");
                const selector = `[data-chat-entry-index="${entryIndex}"]`;
                const MAX_SCROLL_RETRY_FRAMES = 10; // ~160ms ceiling at 60fps
                let attempts = 0;
                const tryScroll = () => {
                  const el = document.querySelector<HTMLElement>(selector);
                  if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "start" });
                    return;
                  }
                  if (++attempts >= MAX_SCROLL_RETRY_FRAMES) return;
                  requestAnimationFrame(tryScroll);
                };
                requestAnimationFrame(tryScroll);
              }}
            />
          )}

          {/* Inner ErrorBoundary scoped to MainContent so a single failing
              plugin (e.g. stale manifest schema mismatch — issue #736) does
              NOT bring down MainToolbar / Settings dialog / Marketplace tab.
              The user must remain able to update / uninstall the broken
              plugin via Settings, otherwise they are locked out and the only
              recovery is manually rm-ing ~/.lvis/plugins/<id>/.
              onReset: refresh plugin state then re-render — for transient
              throws this avoids the deterministic reload-into-same-crash
              loop where the bad data is reloaded with the page. */}
          <ErrorBoundary
            boundaryName="main-content"
            fallback={t("app.mainContentErrorFallback")}
            onReset={() => {
              // Refresh plugin views/cards in case the failure was caused by
              // a transient state mismatch. activeView reset to "home" gives
              // the user a clean baseline to navigate from.
              void refreshViews();
              void refreshCards();
              setActiveView("home");
            }}
          >
          <MainContent
            activeView={activeView}
            api={api}
            appMode={appMode}
            settingsTab={settingsTab}
            onSettingsSaved={handleInlineSettingsSaved}
            onCloseSettings={handleCloseInlineSettings}
            starred={starred}
            currentSessionId={currentSessionId}
            currentSessionKind={currentSessionKind}
            currentSessionTitle={currentSessionTitle}
            sessions={sessions}
            refreshStarred={refreshStarred}
            onActivateHome={() => setActiveView("home")}
            onJumpToSession={handleLoadSessionAndRefresh}
            onRefreshSessions={refreshSessions}
            chatContextValue={chatContextValue}
            onAsk={(q, intent, opts) => handleAsk(q, "default", intent, opts)}
            /* opts 의 inputOrigin / injectHint 가 그대로 handleAsk 4번째
               인자로 전달 — queue-auto inject path 활성. */
            onEditSave={handleEditSave}
            onFork={handleFork}
            onToggleStar={handleToggleStar}
            onRetryEffort={handleRetryEffort}
            onContinueFromLastUser={handleContinueFromLastUser}
            isEntryStarred={isEntryStarred}
            onAbort={handleAbort}
            onGuide={handleGuide}
            onGuideError={(msg) => appendSystemEntry(t("app.guideErrorMessage", { msg }))}
            onFeedback={handleFeedback}
            subAgentSpawns={subAgentSpawns}
            loadedSkills={loadedSkills}
            hasAskQuestions={askQuestions.length > 0}
            askQuestions={askQuestions}
            onResolveAskQuestion={dismissAskQuestion}
            plugins={pluginEntries}
            onSelectPlugin={handleViewSelect}
            onOpenApprovalQueue={() => setDeferredQueueOpen(true)}
            commandActions={commandActions}
            commandPopoverOpen={commandPopoverOpen}
            onCommandPopoverOpenChange={setCommandPopoverOpen}
            activePluginView={activePluginView ?? null}
            pluginAuthError={activePluginAuthError}
            onPluginPrimaryAction={(id) => { void handlePluginPrimaryAction(id); }}
            onRoutineAcknowledge={handleRoutineAcknowledge}
            statusBar={{
              persistent: statusPersistent,
              visibleToast: statusVisibleToast,
              pendingCount: statusPendingCount,
              onToastClick: handleStatusToastClick,
              onToastDismiss: (toast) => statusRemoveToast(toast.id),
            }}
          />
          </ErrorBoundary>
          {/* StatusBar notifications render inside ChatView, directly above
              the composer. The composer's own status sub-row keeps showing
              the ring / permission / model cells. */}
        </main>
        {/* The 도구 활동 panel is a work-mode affordance only. In chat mode the
            shell is the focused conversation surface, so the panel (and its
            collapsed rail) is omitted from the DOM entirely. */}
        {appMode !== "chat" && (
          <ActionPanel
            open={actionPanelOpen}
            onOpenChange={setActionPanelOpen}
            activity={actionPanelActivity}
            onOpenExternalUrl={openActionPanelUrl}
          />
        )}
        </div>
      </div>

      {/* ask_user_question cards now render inline inside ChatView
          (immediately after the active turn's entries),
          so the previous App-level FloatingQuestionPanel mount is gone.
          See <AskUserQuestionCard> + ChatView ask-question slot. */}
      <DeferredQueueDialog open={deferredQueueOpen} onOpenChange={setDeferredQueueOpen} />
      <ApprovalDialog queue={approvalQueue} onDecide={handleApprovalDecide} />
      {/* Z onboarding chain — staged sequence of dialogs.
          The chain reducer guarantees only one of these dialogs is
          ever mounted at a time, so the historical multi-Dialog
          race (#982/#990/#997) cannot recur. */}
      <ScenarioShowcase
        open={chainStage === "showcase"}
        onStart={(scenarioId) =>
          dispatchChain({ type: "showcase-start", scenarioId })
        }
      />
      <LoginModal
        api={api}
        open={chainStage === "login"}
        onOpenChange={(next) => {
          if (chainStage !== "login") return;
          if (!next) {
            // Radix closed the dialog — treat any close that didn't
            // already advance the chain as a user-initiated skip.
            dispatchChain({ type: "login-skip" });
          }
        }}
        onSuccess={() => {
          void checkApiKey();
          dispatchChain({ type: "login-success" });
        }}
      />
      {/* 2026-05-20 — Settings 의 "데모 자격증명 재입력" entry. onboarding
          chain 과는 독립된 modal — 사용자가 이미 onboarding 을 끝낸
          returning user 의 *자발적 재입력 path*. LoginModal 의 forceActivation
          prop 으로 chip 1/2/3 surface 를 우회하고 곧장 activation 입력
          page 를 mount 한다. */}
      <LoginModal
        api={api}
        open={reactivationOpen}
        forceActivation
        onOpenChange={(next) => {
          if (!next) setReactivationOpen(false);
        }}
        onSuccess={() => {
          void checkApiKey();
          setReactivationOpen(false);
        }}
      />
      {/* Tutorial-B (O-X2) — Memory Seed Onboarding Wizard. 2026-05-20:
          MemorySeed now mounts BEFORE the welcome card so the typed
          호칭/자기소개 can personalize the welcome greeting that follows.
          The chain reducer drives `open` from stage "memory" only;
          `onDismissed` advances the chain to "personalized_welcome".

          The wrapper below intentionally swallows MemorySeed's own
          `startTour()` IPC so the chain-effect on stage="tour" remains
          the single canonical broadcaster (preserves the #1029 fix). */}
      <MemorySeedDialog
        open={chainStage === "memory"}
        selectedScenarioId={selectedScenarioId}
        onOpenChange={(next) => {
          if (chainStage !== "memory") return;
          if (!next) {
            // Radix-side close. The MemorySeed's own onDismissed
            // already fires for Submit / Skip; this branch covers the
            // Esc / outside-click paths.
            dispatchChain({ type: "memory-finish" });
          }
        }}
        api={{
          ...api,
          tour: {
            ...api.tour,
            // Swallow the MemorySeed's internal tour.start fire — the
            // Z chain effect on stage="tour" already broadcasts the
            // canonical scenario. Double-broadcast would reset the
            // SpotlightTour to step 0 visibly.
            start: async () => ({ ok: true as const, scenarioId: "first-boot-essentials" }),
          },
        } as typeof api}
        onDismissed={() => {
          // Read the typed 호칭/자기소개 from the DOM at the dismissal
          // frame and feed them into the chain reducer so the
          // PersonalizedWelcome card can address the user by name.
          // The MemorySeed wizard's own write to MEMORY.md is unaffected
          // (it runs inside the wizard before this callback fires).
          let nickname = "";
          let introduction = "";
          if (typeof document !== "undefined") {
            const nameEl = document.querySelector<HTMLInputElement>(
              '[data-testid="memory-seed-dialog:name"]',
            );
            const introEl = document.querySelector<HTMLTextAreaElement>(
              '[data-testid="memory-seed-dialog:intro"]',
            );
            nickname = nameEl?.value?.trim() ?? "";
            introduction = introEl?.value?.trim() ?? "";
          }
          dispatchChain({
            type: "memory-finish",
            nickname,
            introduction,
          });
        }}
      />
      {/* PersonalizedWelcome (2026-05-20) — replaces WelcomeQuestion.
          Mounted after MemorySeed so the card greets the user by the
          호칭 they just typed and references their 자기소개. Forced
          choice — there is no skip; pressing "예, 시작할게요 →" is
          the only path forward. The card also pings the LLM provider
          on mount and surfaces vendor/model/latency inline as a
          connection-confirmation cue. */}
      <PersonalizedWelcome
        open={chainStage === "personalized_welcome"}
        nickname={memorySeedNickname}
        introduction={memorySeedIntroduction}
        pingAiProvider={api.pingAiProvider}
        getRuntimeCounts={api.getRuntimeCounts}
        getRuntimeEnv={api.getRuntimeEnv}
        pluginSummary={firstRunPluginSummary}
        marketplaceUrlReady={marketplaceUrlReady}
        bootstrapStatus={bootstrapStatus}
        onRetryBootstrap={retryBootstrap}
        onContinue={() =>
          dispatchChain({ type: "personalized-welcome-accept" })
        }
      />
      {/* Tutorial-C — SpotlightTour mounts always; it stays invisible until
          a `lvis:tour:start` broadcast flips it on. Production trigger:
          ⌘+Shift+/ (macOS "⌘?" help shortcut) / Ctrl+Shift+/ — see the
          useEffect above. State lives in `~/.lvis/onboarding/`. The
          `onComplete` callback fires only when the user reaches the
          final tour step (not on early-dismissal); the Z chain
          dispatches `tour-finish` so PluginShowcase mounts next. */}
      <SpotlightTour
        api={api}
        onComplete={() => {
          if (chainStage === "tour") dispatchChain({ type: "tour-finish" });
        }}
        onDismiss={() => {
          if (chainStage === "tour") dispatchChain({ type: "tour-skip" });
        }}
      />
      {/* Z onboarding chain — PluginShowcase. Mounted only at stage
          "plugins"; carries the host's installed pluginCards so each
          card reflects what the user actually has. Closing the
          showcase finishes the chain (state → done) and the
          markOnboardingCompleted side-effect persists the flag. */}
      <PluginShowcase
        open={chainStage === "plugins"}
        installedPluginIds={pluginCards.map((c) => c.id)}
        api={api}
        onClose={() => dispatchChain({ type: "plugins-close" })}
        prioritizedScenarioId={selectedScenarioId}
      />
      {/* Tutorial-X5 — Post-tour first-task proposal. Mounts always,
          stays invisible until the user finishes a tour AND at least one
          installed plugin has a registered proposal in first-task-proposals.
          The composerSeedText callback writes directly to the chat
          composer state setter so the user is one click away from a real
          plugin invocation — no hidden IPC. */}
      <PostTourFirstTask
        api={{
          composerSeedText: (text: string) => {
            setQuestion(text);
          },
        }}
        installedPluginIds={pluginCards.map((c) => c.id)}
        tourCompleted={tourCompleted}
      />
      {/* v6: ApprovalQueueStatus floating chip 제거. 자연어 승인 칩
          (DeferredApprovalChip) 은 ChatView 의 컴포저 바로 위에서 렌더된다.
          Spec docs/blueprints/composer-redesign-message-queue.md "제거" 섹션. */}
      <DevConsoleToggle />
      {/* Snap edge highlight — shown when a detached child window enters the snap zone */}
      <SnapEdgeHighlight />
    </OverlayContextProvider>
    </TooltipProvider>
    </ThemeProvider>
    </ErrorBoundary>
  );
}
