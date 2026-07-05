// Types extracted from src/renderer.tsx.
// Pure type declarations — no React runtime, no hook state, no side effects.

import type { PluginUiExtensionView } from "../../plugin-ui-host.js";
import type { Locale } from "../../i18n/locale.js";
import type { StreamEvent, ChatEntry } from "../../lib/chat-stream-state.js";
import type { McpServerConfig, McpServerConfigDto, McpServerState } from "../../mcp/types.js";
import type { SerializedHistoryMessage } from "../../shared/chat-history.js";
import type { PluginConfigRecord } from "../../shared/plugin-config.js";
import type { ChatSendInputOrigin } from "../../shared/chat-origin.js";
import type { RolePreset } from "../../data/role-presets.js";
import type { PermissionEvaluationContext as PermissionEvaluationContextShape } from "../../permissions/evaluation-context.js";
import type { ApprovalPurposeSuggestion } from "../../shared/permission-review-status.js";
import type {
  AssistantAgentSummary,
  AssistantSkillSummary,
  MarketplacePackageType,
} from "../../shared/assistant-context.js";
import type {
  AssistantContextMenuAction,
  AssistantContextMenuPayload,
} from "../../shared/assistant-context-menu.js";
import type { AiProviderPingIpcResult } from "../../shared/ai-provider-ping.js";
import type {
  OpenHtmlPreviewWindowPayload,
  OpenHtmlPreviewWindowResult,
} from "../../shared/render-html-preview.js";
import type { SessionTodoItem } from "../../shared/session-todo.js";
import type { MarketplaceAnnouncementPayload } from "../../shared/marketplace-announcements.js";
import type { NetworkAccessAcknowledgement } from "../../shared/network-access.js";
import type {
  SandboxCapabilityInfo,
  SandboxConfinement,
  SandboxWindowsStatusInfo,
  SandboxWindowsInstallResult,
} from "../../shared/sandbox-capability-info.js";

// Re-export MCP types for renderer-side consumers (type-only, no main-process runtime)
export type { McpServerConfig, McpServerConfigDto, McpServerState };
export type { PermissionEvaluationContext } from "../../permissions/evaluation-context.js";

// Re-export checkpoint types for renderer-side consumers (type-only, no main-process runtime).
export type { CheckpointTrigger, Checkpoint } from "../../memory/memory-manager.js";

export type MarketplaceItem = {
  id: string;
  name: string;
  description: string;
  packageSpec: string;
  installed: boolean;
  enabled: boolean;
  isManaged?: boolean;
  /**
   * Install policy from the catalog manifest. "admin" plugins gain system-wide
   * administrator privileges on install, so the marketplace UI gates them
   * behind an explicit consent step (#1098). Delivered by the backend via
   * `MarketplaceListItem extends PluginMarketplaceItem`.
   */
  installPolicy?: "admin" | "user";
  pluginType?: MarketplacePackageType;
  mcpAuth?: {
    mode: "none" | "api-key" | "sso" | "oauth";
    transport?: "stdio" | "http";
  };
  networkAccess?: {
    allowedDomains: string[];
    reasoning?: string;
    allowPrivateNetworks?: boolean;
  };
};

export type PluginUiExtension = PluginUiExtensionView;
export type PluginManifestUiExtensionSummary = PluginUiExtensionView["extension"];

export type PluginConfigSchemaPropertySummary = {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "secret" | "uri" | "email" | "date-time";
  items?: { type: "string" | "number" | "integer" | "boolean"; enum?: Array<string | number | boolean> };
};

export type PluginConfigSchemaSummary = {
  $schema?: string;
  properties: Record<string, PluginConfigSchemaPropertySummary>;
  required?: string[];
  customPanel?: { entry: string; exportName: string };
};

export type PluginCardSummary = {
  id: string;
  name: string;
  description: string;
  sampleTools: string[];
  capabilities: string[];
  tools: string[];
  toolDescriptions?: Record<string, string>;
  isManaged?: boolean;
  /** Install policy from the plugin manifest: "admin" (IT-managed only) or "user" (anyone). */
  installPolicy?: "admin" | "user";
  loadStatus?: "loaded" | "preparing" | "failed" | "disabled";
  /** Whether the plugin's tools are currently exposed to the model. */
  active?: boolean;
  /** Whether the plugin instance is loaded and callable even when inactive. */
  runtimeLoaded?: boolean;
  preparationStatus?: {
    phase: string;
    message: string;
    progressPct?: number;
    updatedAt: string;
  };
  /** Optional Lucide icon name declared in the plugin manifest. */
  icon?: string;
  /** Optional short text rendered in place of a Lucide icon. */
  iconText?: string;
  /** Manifest-declared sidebar UI metadata, even before the plugin is loaded. */
  uiExtensions?: PluginManifestUiExtensionSummary[];
  version?: string;
  publisher?: string;
  /** Declarative settings schema, when the manifest declares one. */
  configSchema?: PluginConfigSchemaSummary;
  /** Optional declarative auth contract for the host UI surface. */
  auth?: PluginAuthSummary;
  /** Declarative egress disclosure copied from the plugin manifest. */
  networkAccess?: {
    allowedDomains: string[];
    reasoning?: string;
    allowPrivateNetworks?: boolean;
  };
  /** Marketplace request slugs that should collapse onto this installed plugin. */
  installAliases?: string[];
};

/**
 * Mirror of host-side `PluginAuthSpec` for renderer consumption — kept as a
 * separate name to make the renderer/host boundary explicit. Field shape
 * matches the host contract.
 */
export type PluginAuthSummary = {
  label?: string;
  statusTool: string;
  loginTool: string;
  logoutTool?: string;
};

/** Recommended return shape of `auth.statusTool`. Host parses defensively. */
export type PluginAuthStatusResult = {
  authenticated: boolean;
  account?: string;
};

export type LLMVendorSettingsRenderer = {
  model: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
  enableThinking: boolean;
  thinkingBudgetTokens: number;
};

export type AppSettings = {
  llm: {
    /**
     * #893 — Top-level auth toggle. `"manual"` shows the vendor dropdown +
     * per-vendor settings; `"login"` collapses everything down to a single
     * Login button whose backend chooses the vendor.
     */
    authMode: "manual" | "login";
    provider: string;
    vendors: Record<string, LLMVendorSettingsRenderer>;
    streamSmoothing: "none" | "word" | "char";
    fallbackChain: Array<{ provider: string; model: string }>;
    /** Manual-mode Chromium host-resolver map (persisted /etc/hosts-style text). */
    hostResolverMap?: string;
  };
  chat: { systemPrompt: string; autoCompact: boolean };
  webSearch: { provider: string };
  routine?: Record<string, unknown>;
  privacy?: { piiRedactEnabled: boolean };
  plugins?: Record<string, never>;
  marketplace?: {
    backend?: "real-cloud";
    cloudBaseUrl?: string;
    cloudAllowPrivateNetwork?: boolean;
    /** Announcement banner ids the user has dismissed (persisted). */
    dismissedAnnouncementIds?: number[];
    /** Plugin update versions skipped until the marketplace publishes a newer version. */
    skippedPluginUpdates?: Record<string, string>;
  };
  updates?: {
    autoCheckEnabled?: boolean;
    /** App version skipped until a newer app version is available. */
    skippedVersion?: string;
  };
  /** Visual theme preferences. */
  appearance?: {
    schemaVersion?: 2;
    bundleId?: string;
    followSystem?: boolean;
    /** UI language (i18n). SOT: `AppearanceSettings` in settings-store. */
    language?: Locale;
    /** User-configurable font family + size. */
    font?: {
      /** `"system"` = HOST_FONT_STACK default; otherwise a validated raw stack. */
      family?: "system" | string;
      /** Multiplier on `1rem` base. Allowed: 0.875 / 1 / 1.125 / 1.25. */
      sizeScale?: 0.875 | 1 | 1.125 | 1.25;
    };
  };
  /** §B1 — external URL viewer policy (in-app vs system browser). */
  webView?: {
    preferredFlow: "in-app" | "system-browser";
  };
  /** Window close-button behaviour. SOT: `SystemSettings` in settings-store. */
  system?: {
    closeBehavior: "hide-to-tray" | "quit";
    /** Persisted workspace mode (chat vs work). SOT: `SystemSettings`. */
    appMode?: "chat" | "work";
    /** Persisted docked side-panel width (px). SOT: `SystemSettings`. */
    sidePanelWidth?: number;
    /** Persisted primary navigation sidebar width (px). SOT: `SystemSettings`. */
    sidebarWidth?: number;
    /**
     * Persisted TOP-pane percent of the workspace-rail vertical (list↕viewer)
     * split, per tab kind (file-browser / preview / subagent). Browser excluded.
     * SOT: `SystemSettings` in settings-store.
     */
    sidePanelSplitFilePercent?: number;
    sidePanelSplitPreviewPercent?: number;
    sidePanelSplitSubagentPercent?: number;
    /** Persisted active sidebar tab ("chats" | "projects"). SOT: `SystemSettings`. */
    sidebarActiveTab?: "chats" | "projects";
    /** Pinned project roots — sort to the top of the sidebar's Projects tab. SOT: `SystemSettings`. */
    pinnedProjectRoots?: string[];
  };
  /** Experimental feature flags — all default false. */
  features?: {
    idlePreferenceRefresh?: boolean;
    /** #893 — `true` after the user has dismissed the first-boot onboarding. */
    onboardingCompleted?: boolean;
    /**
     * Permission policy host-classifies-risk migration gate. Mirrors the
     * main-process SOT in `src/data/settings-store.ts`
     * `FeatureFlags.hostClassifiesRisk`. Default true on ALL platforms (PR #1390
     * — host classifies plugin risk + foreground plugin read-relaxation). Safe
     * all-platform because the read-relaxation is COUPLED to the OS sandbox
     * being active: on a non-sandbox platform it falls back to the pre-exec ask.
     */
    hostClassifiesRisk?: boolean;
    /**
     * OS tool sandbox opt-in. Mirrors the main-process SOT in
     * `src/data/settings-store.ts` `FeatureFlags.osToolSandbox`. STAGED default
     * (macOS-first): true on `darwin`, false on `linux`/`win32` (opt-in) until
     * the C/D-series QA is green. Takes effect only when a platform sandbox
     * runner is available.
     */
    osToolSandbox?: boolean;
  };
};

export type IpcErrorResult = { ok: false; error: string; message?: string };
export type SettingsUpdateResult = AppSettings | IpcErrorResult;

export function isIpcErrorResult(value: unknown): value is IpcErrorResult {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

// ─── Plugin Performance types (Observability) ──────
export type PluginPerfStats = {
  startupMs: number;
  toolCallCount: number;
  errorCount: number;
  totalExecMs: number;
  lastCallAt: number | null;
};

// ─── Usage types ────────────────────────────────────
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  unknownCostTurns?: number;
};
export type UsagePerX = UsageTotals & { vendor: string; model: string };
export type UsageTrendPt = UsageTotals & { date: string };
export type UsageConv = UsageTotals & { sessionId: string; turns: number; firstInput?: string };
export type UsageSummaryShape = {
  today: UsageTotals;
  thisWeek: UsageTotals;
  thisMonth: UsageTotals;
  perVendor: UsagePerX[];
  perModel: UsagePerX[];
  trend: UsageTrendPt[];
  topConversations: UsageConv[];
  generatedAt: string;
};

export type UsageDailySummaryInput = {
  date: string;
  locale?: string;
  sessions?: Array<{
    title?: string;
    preview?: string;
    projectName?: string;
  }>;
  starred?: Array<{
    role?: string;
    text?: string;
  }>;
  usage?: Partial<UsageTotals> | null;
};

export type UsageDailySummaryResult =
  | { ok: true; summary: string; generatedAt: string }
  | { ok: false; error: string };

export type ProjectQueryOptions = {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
};

export type PluginMarketplaceActionResult =
  | { ok: true; pluginId: string; installed?: true; uninstalled?: true; version?: string }
  | { ok: false; error: string; message?: string };

export type PluginMarketplaceInstallOptions = {
  networkAccessAcknowledgement?: NetworkAccessAcknowledgement;
};

export type LvisApi = {
  /**
   * Deterministic file:// URL of the bundled `plugin-preload.js`. Computed in
   * the host preload from `__dirname` (= `dist/src/`) so the plugin <webview>
   * can be mounted with a stable preload regardless of `window.location.href`.
   */
  pluginPreloadUrl: string;
  permission: LvisPermissionApi;
  approval: LvisApprovalApi;
  policy: LvisPolicyApi;
  mcp: LvisMcpApi;
  attach: LvisAttachApi;
  /**
   * Deterministic file:// URL of the bundled `plugin-ui-shell.html`. Same
   * stability guarantee as `pluginPreloadUrl` — read directly from the host
   * renderer instead of resolving against `window.location.href`.
   */
  pluginShellUrl: string;
  notifyPluginTheme: (payload: {
    bundleId: string;
    shell: "light" | "dark";
    tokens: Record<string, string>;
  }) => Promise<{ ok: boolean; error?: string }>;
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: DeepPartial<AppSettings>) => Promise<SettingsUpdateResult>;
  /** Save the manual host-resolver map and relaunch the app to apply it. */
  applyHostMap: (
    hostResolverMap: string,
  ) => Promise<{ ok: boolean; error?: string; message?: string }>;
  onSettingsUpdated: (handler: (settings: AppSettings) => void) => () => void;
  listPersonaPromptSummaries: () => Promise<{ prompts: Array<Pick<RolePreset, "id" | "name">> }>;
  listPersonaPrompts: () => Promise<{ prompts: RolePreset[] }>;
  savePersonaPrompt: (prompt: { id: string; name: string; systemPromptAdd: string }) => Promise<
    | { ok: true; prompt: RolePreset }
    | { ok: false; error: string }
  >;
  deletePersonaPrompt: (id: string) => Promise<
    | { ok: true; deleted: boolean }
    | { ok: false; error: string }
  >;
  onPersonaPromptsUpdated?: (handler: () => void) => () => void;
  setApiKey: (vendor: string, k: string) => Promise<{ ok: true }>;
  hasApiKey: (vendor?: string) => Promise<boolean>;
  deleteApiKey: (vendor: string) => Promise<{ ok: true }>;
  setWebApiKey: (provider: string, k: string) => Promise<{ ok: true }>;
  hasWebApiKey: (provider: string) => Promise<boolean>;
  deleteWebApiKey: (provider: string) => Promise<{ ok: true }>;
  setMarketplaceApiKey: (k: string) => Promise<{ ok: true }>;
  hasMarketplaceApiKey: () => Promise<boolean>;
  deleteMarketplaceApiKey: () => Promise<{ ok: true }>;
  /**
   * #893 — Top-level mockup credential login. On `ok: true` the host has
   * installed the demo API key into the encrypted secret store AND flipped
   * top-level settings (`authMode = "login"`, `provider = <vendor>`). The
   * vendor is decided by the backend (captured `LVIS_DEMO_VENDOR`, default
   * `"azure-foundry"`) — the renderer never sends one. The `error` codes are
   * kebab-case English (`invalid-credentials`, `no-demo-key`); the
   * user-facing Korean text is constructed in the caller.
   */
  loginMockup: (payload: { username: string; password: string }) => Promise<
    | {
        ok: true;
        vendor: string;
        model?: string;
        baseUrl?: string;
        vertexProject?: string;
        vertexLocation?: string;
        fieldsApplied: string[];
      }
    | { ok: false; error: string }
  >;
  /**
   * Tutorial-X1 — Auth progress IPC. The host emits real progress events
   * for each step of the `loginMockup` flow on `lvis:auth:progress` so the
   * LoginModal checklist animates against actual main-process work, not a
   * renderer `setTimeout` illusion. `onProgress` returns the unsubscribe
   * function. Event payloads use kebab-case English `step` + `status`
   * codes (CLAUDE.md error-language rule).
   */
  auth: {
    onProgress: (
      handler: (event: {
        step:
          | "credentials-validating"
          | "llm-key-issuing"
          | "sandbox-preparing"
          | "complete";
        status: "running" | "done" | "failed";
        vendor?: string;
        error?: string;
      }) => void,
    ) => () => void;
    /**
     * 2026-05-20 — Settings 가 별도 BrowserWindow 로 mount 되기 때문에 GeneralTab
     * 의 로그아웃 / 데모 자격증명 재입력 entry 는 cross-window broadcast 가 필요.
     * `broadcast*` 는 main 프로세스에서 모든 window 로 fan-out 하고, `on*` 은
     * main window 의 App.tsx 가 subscribe 한다. payload 가 없는 단순 cue.
     *
     * Optional 로 선언한 이유: 다수 test fixture 가 `api.auth` 를 `onProgress`
     * 만 mock 한 채 LvisApi 로 cast 한다. production preload 는 항상 정의하므로
     * runtime presence 는 보장되지만 strict-typed test 가 깨지지 않도록 optional.
     */
    broadcastLogoutReset?: () => Promise<
      | { ok: true }
      | { ok: false; error: "unauthorized-frame" }
    >;
    broadcastReactivateDemo?: () => Promise<
      | { ok: true }
      | { ok: false; error: "unauthorized-frame" }
    >;
    onLogoutReset?: (handler: () => void) => () => void;
    onReactivateDemo?: (handler: () => void) => () => void;
  };
  /**
   * Interactive PTY terminal (#1444, workspace rail). `spawn` is idempotent per
   * tab (a remount replays the scrollback rather than starting a fresh shell);
   * `onData` / `onExit` return unsubscribe functions (the onChatStream pattern).
   * Optional so test fixtures casting a partial object to LvisApi keep compiling
   * — production preload always defines it.
   */
  terminal?: {
    spawn: (payload: { tabId: string; cwd?: string; cols?: number; rows?: number }) => Promise<
      | { ok: true; tabId: string; replayed: boolean }
      | { ok: false; reason: string; message: string }
    >;
    input: (tabId: string, data: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    resize: (
      tabId: string,
      cols: number,
      rows: number,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    kill: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    onData: (handler: (payload: { tabId: string; chunk: string }) => void) => () => void;
    onExit: (
      handler: (payload: { tabId: string; exitCode: number; signal?: number }) => void,
    ) => () => void;
  };
  /**
   * Side chat (workspace rail) — a second, independently-streaming chat session
   * driven by a dedicated ConversationLoop in main. `onStream` / `onFallback`
   * subscribe to the DEDICATED CHANNELS.sidechat.{stream,fallback} events (never
   * the main chat.stream), so a main-chat stream frame never reaches this
   * subscriber and vice versa. Optional so test fixtures casting a partial
   * object to LvisApi keep compiling — production preload always defines it.
   */
  sideChat?: {
    send: (input: string, attachments?: unknown[]) => Promise<
      | { ok: true; result: unknown }
      | { ok: false; error: string }
    >;
    new: () => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
    load: (sessionId: string) => Promise<
      | { ok: true; sessionId: string; messages: SerializedHistoryMessage[] }
      | { ok: false; error: string; messages: SerializedHistoryMessage[] }
    >;
    list: () => Promise<{
      current: string | null;
      sessions: Array<{ id: string; modifiedAt: string; title: string }>;
    }>;
    abort: () => Promise<{ ok: true } | { ok: false; error: string }>;
    onStream: (handler: (event: StreamEvent) => void) => () => void;
    onFallback: (handler: (payload: { from: string; to: string }) => void) => () => void;
  };
  /**
   * Demo activation bridge. `status` exposes only the captured activation
   * state from main; it does not read `process.env` in the renderer because
   * packaged builds scrub `LVIS_DEMO_*` before preload inherits env. `activate`
   * decrypts a pasted activation string back into the original `.env.demo`
   * payload, persists it under `~/.lvis/secrets/.env.demo`, and injects the
   * keys so the downstream auth handler can see them.
   *
   * Error codes are kebab-case English; the renderer translates each into
   * a Korean message in the LoginModal.
   */
  demo: {
    status: () => Promise<
      | { ok: true; activated: boolean; vendor: string | null; autoActivatable: boolean }
      | { ok: false; error: "unauthorized-frame" }
    >;
    activate: (code: string) => Promise<
      | { ok: true; vendor: string; requiresRelaunch?: boolean }
      | { ok: false; error: "invalid-code" | "no-vendor" | "invalid-vendor" | "no-demo-key" | "missing-foundry-endpoint" | "invalid-foundry-endpoint" | "missing-foundry-host-map" | "foundry-host-map-mismatch" | "invalid-foundry-host-map-target" | "persist-failed" | "unauthorized-frame" }
    >;
    /**
     * Embedded activation — same chain as `activate` with the build-time
     * embedded key as the code source (`status().autoActivatable` advertises
     * availability). `no-embedded-code` routes back to manual paste.
     */
    activateEmbedded: () => Promise<
      | { ok: true; vendor: string; requiresRelaunch?: boolean }
      | { ok: false; error: "no-embedded-code" | "invalid-code" | "no-vendor" | "invalid-vendor" | "no-demo-key" | "missing-foundry-endpoint" | "invalid-foundry-endpoint" | "missing-foundry-host-map" | "foundry-host-map-mismatch" | "invalid-foundry-host-map-target" | "persist-failed" | "unauthorized-frame" }
    >;
    relaunchAfterActivation: () => Promise<
      | { ok: true }
      | { ok: false; error: "not-armed" | "unauthorized-frame" }
    >;
    /**
     * 2026-05-20 — Logout / 데모 자격증명 재입력 path. 활성 상태(`.env.demo`
     * + `LVIS_DEMO_*` + main 의 captured demo state) 를 한 번에 비운다. 다음
     * `status()` 호출은 `activated=false` 를 반환하므로 LoginModal 의 activation
     * 입력 화면이 다시 mount 될 수 있다.
     */
    clearDemo: () => Promise<
      | { ok: true }
      | { ok: false; error: "clear-failed" | "unauthorized-frame" }
    >;
  };
  /**
   * Tutorial-C — SpotlightTour state + broadcast bridge. The host persists
   * the tour state under `~/.lvis/onboarding/tour-state.json` (Storage
   * Namespace per Feature). `tour.start` fans out to every open window
   * so any renderer surface can launch the tour without owning tour state.
   */
  tour: {
    getState: () => Promise<
      | {
          ok: true;
          state: {
            lastSeenScenario: string | null;
            completedScenarios: string[];
            dismissedAt: string | null;
          };
        }
      | { ok: false; error: string; message: string }
    >;
    markComplete: (scenarioId: string) => Promise<
      | {
          ok: true;
          state: {
            lastSeenScenario: string | null;
            completedScenarios: string[];
            dismissedAt: string | null;
          };
        }
      | { ok: false; error: string; message: string }
    >;
    dismiss: (scenarioId: string) => Promise<
      | {
          ok: true;
          state: {
            lastSeenScenario: string | null;
            completedScenarios: string[];
            dismissedAt: string | null;
          };
        }
      | { ok: false; error: string; message: string }
    >;
    start: (scenarioId: string) => Promise<
      | { ok: true; scenarioId: string }
      | { ok: false; error: string; message: string }
    >;
    onStart: (handler: (payload: { scenarioId: string }) => void) => () => void;
  };
  /**
   * Install a plugin from the Memory Seed recommendation flow. Delegates to
   * the canonical `lvis:plugins:install` channel so onboarding reuses the
   * entire marketplace install pipeline (download → verify → register →
   * restart broadcasts) rather than forking an onboarding-only install loop.
   * Error codes are kebab-case English; the renderer translates for the user.
   */
  tutorialInstallPlugin: (pluginId: string) => Promise<
    | { ok: true; pluginId: string }
    | { ok: false; error: string; message: string }
  >;
  /**
   * Tutorial-X4 — write the synthesized onboarding context to
   * `~/.lvis/onboarding/onboarding-context.md`. The host's
   * SystemPromptBuilder picks this up as section id=9.86 "User Onboarding
   * Context" on every subsequent turn (until the file is cleared). The
   * renderer wizard composes a short markdown block (호칭 + 자기소개 +
   * installed plugin ids + last completed walkthrough) and calls this
   * once after `MemorySeedDialog` dismissal. Capped server-side at 4 KB.
   */
  onboardingContextSet: (content: string) => Promise<
    | { ok: true }
    | { ok: false; error: string; message: string }
  >;
  openSettingsWindow: (initialTab?: string) => Promise<{ ok: true; windowId: number } | { ok: false; error: string }>;
  notifySettingsWindowSaved: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onSettingsWindowSaved: (handler: () => void) => () => void;
  onSettingsWindowTab: (handler: (initialTab: string) => void) => () => void;
  /** Open an http(s) URL in the system browser. Main-side rejects any other scheme. */
  openExternalUrl: (url: string) => Promise<{
    ok: boolean;
    error?: string;
    protocol?: string;
    message?: string;
  }>;
  /** #FU259 — MCP catalog (filtered to plugin_type === "mcp"). */
  listMcpCatalog: () => Promise<Array<{
    id: string;
    name: string;
    description: string;
    version?: string;
    publisher?: string;
    pluginType?: MarketplacePackageType;
    installed: boolean;
    enabled: boolean;
    isManaged?: boolean;
  }>>;
  installMcpFromMarketplace: (slug: string) => Promise<
    | { ok: true; slug: string; installDir: string; connected: boolean; warning?: string; needsCredential: boolean; authMode: "none" | "api-key" | "sso" | "oauth" }
    | { ok: false; error: string; message: string }
  >;
  /** #FU262 — Claude Desktop config import. */
  previewClaudeDesktopMcpImport: (raw: string) => Promise<{
    entries: Array<{
      id: string;
      config: McpServerConfig;
      suspectedSecretEnvKeys: string[];
      warning?: string;
    }>;
    errors: Array<{ id: string; reason: string }>;
  }>;
  applyClaudeDesktopMcpImport: (payload: { raw: string; conflictPolicy?: "skip" | "overwrite" }) => Promise<
    | {
        ok: true;
        results: Array<{
          id: string;
          action: "added" | "skipped-conflict" | "overwritten" | "failed";
          reason?: string;
          warning?: string;
        }>;
        parseErrors: Array<{ id: string; reason: string }>;
      }
    | { ok: false; error: string }
  >;
  // Provider-auth bridge methods are plugin-owned.
  chatHasProvider: () => Promise<boolean>;
  captureUserKeyboardIntent: () => import("../../shared/chat-origin.js").UserKeyboardIntentSnapshot;
  chatSend: (
    input: string,
    attachments: import("../../engine/llm/types.js").UserContentPart[] | undefined,
    inputOrigin: ChatSendInputOrigin,
    userIntent?: import("../../shared/chat-origin.js").UserKeyboardIntentSnapshot,
    personaPromptId?: string,
  ) => Promise<unknown>;
  chatGuide: (input: string) => Promise<unknown>;
  chatNew: (opts?: { projectRoot?: string; projectName?: string }) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  chatSessions: (opts?: { kind?: "main" | "routine" | "all"; routineId?: string; projectRoot?: string; limit?: number; before?: string; beforeId?: string; after?: string }) => Promise<{ current: string; sessions: Array<{ id: string; modifiedAt: string; title: string; sessionKind: "main" | "routine"; routineId?: string; routineTitle?: string; routineFiredAt?: string; projectRoot?: string; projectName?: string; branchedFromCompactNum?: number }> }>;
  onChatStream: (h: (e: StreamEvent) => void) => () => void;
  onChatFallback: (h: (payload: { from: string; to: string }) => void) => () => void;
  chatGetHistory: () => Promise<{ sessionId: string; sessionTitle?: string; sessionKind: "main" | "routine"; routineId?: string; routineTitle?: string; projectRoot?: string; projectName?: string; projectIsDefault?: boolean; messages: SerializedHistoryMessage[] }>;
  chatMainActiveState: () => Promise<{ mainActiveSessionId: string | null; mainActiveMode: "resume" | "fresh"; updatedAt: string } | null>;
  chatSessionHistory: (sessionId: string) => Promise<{
    ok: boolean;
    sessionTitle?: string;
    sessionKind?: "main" | "routine";
    routineId?: string;
    routineTitle?: string;
    routineFiredAt?: string;
    projectRoot?: string;
    projectName?: string;
    messages: SerializedHistoryMessage[];
    /** Chars in the rolling summary preamble applied to this session. 0 = no preamble. */
    preambleChars?: number;
  }>;
  chatEditResend: (messageIndex: number, newText: string) => Promise<{ ok: boolean; error?: string }>;
  chatFork: (messageIndex: number) => Promise<{ ok: boolean; sessionId: string | null }>;
  chatContinueLastUser: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  chatRetryEffort: (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  chatExport: (format: "markdown" | "json") => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  chatCompact: () => Promise<{ compacted: boolean; compactedAt: string | null; summary: string; removedMessageCount: number }>;
  chatSessionResume: (sessionId: string) => Promise<{ ok: boolean; compacted: boolean; compactedAt: string | null; removedMessageCount: number }>;
  // Checkpoint view and explicit branch actions.
  // Note: enter/branch return discriminated unions without `ok`; exit follows the
  // standard { ok: boolean } pattern. Callers guard with `"error" in result`.
  chatEnterCheckpointView: (sessionId: string, compactNum: number) => Promise<{ messageIndexAtCreation: number } | { error: string }>;
  chatExitCheckpointView: () => Promise<{ ok: boolean }>;
  chatBranchFromCheckpoint: (sessionId: string, compactNum: number) => Promise<{
    newSessionId: string;
    lastMessageRole: "user" | "assistant" | "tool_result" | null;
    shouldAutoContinue: boolean;
  } | { error: string }>;
  chatAbort: () => Promise<{ ok: boolean }>;
  /** Lazy-load in-session verbatim content for a compacted tool_result.
   * Returns null when: session changed, toolUseId not found, verbatim
   * already flushed to disk stub, or meta.compactedAt was never set. lineCount
   * is pre-computed server-side. */
  chatGetVerbatimToolResult: (
    sessionId: string,
    toolUseId: string,
  ) => Promise<{ content: string; lineCount: number } | null>;
  /** Issue #749: lazy-load full write_file diff when content exceeded preview limit.
   * Returns { before, after } from ~/.lvis/diff-cache/<sessionId>/<toolUseId>.json,
   * or null when sidecar not found / session id invalid. */
  chatGetWriteDiff: (
    sessionId: string,
    toolUseId: string,
  ) => Promise<{ before: string; after: string } | null>;
  submitFeedback: (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) => Promise<{ ok: boolean; error?: string }>;
  starredList: () => Promise<Array<{ id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string }>>;
  starredAdd: (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => Promise<{ ok: boolean; entry?: { id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string } }>;
  starredRemove: (opts: { id?: string; sessionId?: string; messageIndex?: number }) => Promise<{ ok: boolean }>;
  memoryListEntries: (opts?: ProjectQueryOptions) => Promise<Array<{ filename: string; title: string; content: string; updatedAt?: string; projectRoot?: string; projectName?: string }>>;
  memorySaveEntry: (t: string, c: string, opts?: ProjectQueryOptions) => Promise<unknown>;
  memoryDeleteEntry: (f: string) => Promise<void>;
  memorySearchEntries: (q: string, opts?: ProjectQueryOptions) => Promise<Array<{ filename?: string; title: string; content?: string; excerpt: string; updatedAt: string; projectRoot?: string; projectName?: string }>>;
  memoryGetIndex: (opts?: ProjectQueryOptions) => Promise<string>;
  memoryUpdateIndexIfUnchanged: (expectedContent: string, nextContent: string) => Promise<boolean>;
  memoryUpdateIndexSections: (sections: { urgentMemory?: string; references?: string }) => Promise<unknown>;
  memoryListSessions: (opts?: ProjectQueryOptions) => Promise<Array<{ sessionId: string; title?: string; matchedMessage: string; timestamp: string }>>;
  memorySearchSessions: (q: string, opts?: ProjectQueryOptions) => Promise<Array<{ sessionId: string; title?: string; matchedMessage: string; timestamp: string }>>;
  memoryGetAgentsMd: () => Promise<string>;
  memoryUpdateAgentsMd: (content: string) => Promise<unknown>;
  memoryGetUserPrefs: () => Promise<string>;
  memoryUpdateUserPrefs: (content: string) => Promise<unknown>;
  memoryRefreshUserPrefs: () => Promise<
    | {
        ok: true;
        content: string;
        refreshedAt?: string;
        sources?: string[];
      }
    | { ok: false; error: string }
  >;
  listMarketplacePlugins: () => Promise<MarketplaceItem[]>;
  listAgentProfiles: () => Promise<{ agents: AssistantAgentSummary[] }>;
  listSkills: () => Promise<{ skills: AssistantSkillSummary[] }>;
  installAgentFromMarketplace: (slug: string) => Promise<
    | { ok: true; slug: string; agentId: string; version: string }
    | { ok: false; error: string; message: string }
  >;
  uninstallAgentPackage: (slug: string) => Promise<
    | { ok: true; slug: string; agentId: string }
    | { ok: false; error: string; message: string }
  >;
  installSkillFromMarketplace: (slug: string) => Promise<
    | { ok: true; slug: string; skillId: string; version: string }
    | { ok: false; error: string; message: string }
  >;
  uninstallSkillPackage: (slug: string) => Promise<
    | { ok: true; slug: string; skillId: string }
    | { ok: false; error: string; message: string }
  >;
  listPluginUiExtensions: () => Promise<PluginUiExtension[]>;
  readPluginUiModule: (pluginId: string, viewId: string) => Promise<string>;
  callPluginMethod: (
    m: string,
    p?: unknown,
    options?: { userAction?: boolean },
  ) => Promise<unknown>;
  /**
   * Subscribe to plugin-emitted events forwarded by the host event bridge
   * (`boot/steps/ipc-bridge.ts` → `lvis:plugin:event`). Plugin must declare
   * the type in `manifest.emittedEvents[]`. The preload layer rejects
   * subscriptions whose namespace prefix appears in `PLUGIN_PRIVATE_NAMESPACES`
   * by returning a no-op unsubscribe without wiring the IPC listener — so
   * renderer code can never observe sensitive host state (memory contents,
   * secrets, audit trails, DLP decisions) through this API. Returns an
   * unsubscribe function. Used by `usePluginAuthStatuses` for
   * `<pluginId>.auth.changed`.
   */
  onPluginEvent?: (eventType: string, handler: (data: unknown) => void) => (() => void);
  listPluginCards: () => Promise<PluginCardSummary[]>;
  /**
   * #1176 — toggle a plugin active/inactive. Inactive plugins stay loaded but
   * their tools are hidden from the model's per-turn scope.
   */
  setPluginEnabled: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<
    | { ok: true; pluginId: string; enabled: boolean }
    | { ok: false; error: string; message: string }
  >;
  // routine_schedule v2 — persistent routine list + lifecycle
  listRoutinesV2: () => Promise<import("../../shared/routines-types.js").RoutineRecord[]>;
  dismissRoutineV2: (id: string) => Promise<{ ok: boolean; error?: string }>;
  removeRoutineV2: (id: string) => Promise<{ ok: boolean; error?: string }>;
  triggerRoutineNowV2: (id: string) => Promise<{ ok: boolean; error?: string }>;
  listPendingRoutineResultsV2: () => Promise<import("../../shared/routines-types.js").RoutineFiredPayload[]>;
  acknowledgeRoutineResultV2: (routineId: string, firedAt: string) => Promise<{ ok: boolean; error?: string }>;
  addRoutineV2: (
    input: import("../../shared/routines-types.js").AddRoutineInput,
  ) => Promise<
    | { ok: true; routine: import("../../shared/routines-types.js").RoutineRecord }
    | { ok: false; error: string }
  >;
  onRoutineFiredV2: (
    handler: (event: import("../../shared/routines-types.js").RoutineFiredPayload) => void,
  ) => () => void;
  // Routine running indicator
  // C1: enriched payload includes title+firedAt so renderer can push OverlayItem immediately
  onRoutineRunningStarted: (handler: (payload: { routineId: string; firedAt: string; title: string }) => void) => () => void;
  onRoutineRunningFinished: (handler: (routineId: string) => void) => () => void;
  // failed: clears running:true stuck OverlayItem when the LLM session throws
  onRoutineFailedV2: (handler: (event: { routineId: string; error: string }) => void) => () => void;
  // Overlay IPC bridges
  onOverlayShow: (handler: (item: import("./context/OverlayContext.js").OverlayItem) => void) => () => void;
  onOverlayUpdate: (handler: (id: string, patch: Partial<import("./context/OverlayContext.js").OverlayItem>) => void) => () => void;
  onOverlayDismiss: (handler: (id: string) => void) => () => void;
  // Routine session history
  listRoutineSessionsV2: (
    routineId: string,
    limit?: number,
  ) => Promise<Array<{ routineId: string; firedAt: string; sessionId: string; title: string; preview: string }>>;
  // ─── Work Board — personal board CRUD + lifecycle ───
  // Result envelopes are the store's discriminated `status` unions (or
  // `{ ok:false, error }` for unauthorized-frame / no-store). Shared types come
  // from the renderer-safe `shared/work-board-types.js` (no Node built-ins).
  listWorkBoard: (
    filter?: import("../../shared/work-board-types.js").WorkItemListFilter,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemListResult
    | { ok: false; error: string }
  >;
  getWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemGetResult
    | { ok: false; error: string }
  >;
  addWorkBoardItem: (
    input: import("../../shared/work-board-types.js").WorkItemCreateInput,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemCreateResult
    | { ok: false; error: string }
  >;
  updateWorkBoardItem: (
    id: number,
    patch: import("../../shared/work-board-types.js").WorkItemUpdateInput,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemUpdateResult
    | { ok: false; error: string }
  >;
  transitionWorkBoardItem: (
    id: number,
    to: import("../../shared/work-board-types.js").WorkItemStatusStored,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemTransitionResult
    | { ok: false; error: string }
  >;
  completeWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemCompleteResult
    | { ok: false; error: string }
  >;
  reopenWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemReopenResult
    | { ok: false; error: string }
  >;
  removeWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemDeleteResult
    | { ok: false; error: string }
  >;
  // Board view live refresh: emitted after any successful board mutation so the
  // renderer re-lists without polling.
  onWorkBoardItemChanged: (
    handler: (payload: import("../../shared/work-board-types.js").WorkItemChangedEventPayload) => void,
  ) => () => void;
  // Agent-orchestration run: kick off plan→approve→execute for one item. The
  // promise resolves with the terminal run result; live phase + coarse marker
  // updates flow over the on* subscriptions below. `opts.agentName` selects a
  // named agent profile (drives the child model for both phases).
  runWorkBoardItem: (
    id: number,
    opts?: { agentName?: string },
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemRunResult
    | { ok: false; error: string }
  >;
  // Generate a daily / weekly personal work report (markdown) from the board
  // state + activity log + learned memory.
  generateWorkBoardReport?: (
    kind: "daily" | "weekly",
    input?: { date?: string; weekIso?: string; weekOffset?: number; projectRoot?: string; includeUnscoped?: boolean },
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkBoardReportResult
    | { ok: false; error: string }
  >;
  // Read a past run's persisted transcript (plan+execute conversation) for the
  // run-history view. Resolves with the ordered events (empty when absent).
  getWorkBoardRunTranscript?: (
    itemId: number,
    runId: string,
  ) => Promise<
    | { events: import("../../shared/work-board-types.js").RunTranscriptEvent[] }
    | { ok: false; error: string }
  >;
  // Live per-phase progress for an in-flight run. Payload === the engine's
  // WorkBoardRunEvent (aliased RunProgressEventPayload).
  onWorkBoardRunProgress: (
    handler: (payload: import("../../shared/work-board-types.js").RunProgressEventPayload) => void,
  ) => () => void;
  // Coarse markers so the renderer can set/clear a per-item running indicator
  // without re-listing.
  onWorkBoardRunStarted: (
    handler: (payload: { itemId: number; at: string }) => void,
  ) => () => void;
  onWorkBoardRunFinished: (
    handler: (payload: {
      itemId: number;
      status: "completed" | "denied" | "not_found" | "error" | "already_running";
      at: string;
    }) => void,
  ) => () => void;
  onWorkBoardRunFailed: (
    handler: (payload: { itemId: number; reason: string; at: string }) => void,
  ) => () => void;
  onMarketplaceUpdatesAvailable: (h: (updates: Array<{
    pluginId: string;
    pluginName?: string;
    installedVersion: string;
    latestVersion: string;
    networkAccess?: MarketplaceItem["networkAccess"];
  }>) => void) => () => void;
  /**
   * Marketplace announcement stream — the host pushes the currently-active,
   * not-yet-dismissed announcements whenever the announcement poller runs.
   * The renderer shows them in a banner and persists dismissals via
   * `updateSettings({ marketplace: { dismissedAnnouncementIds } })`.
   */
  onMarketplaceAnnouncements: (h: (announcements: MarketplaceAnnouncementPayload) => void) => () => void;
  /**
   * App auto-update state stream — emitted by the main process whenever
   * the updater state changes (available → downloading → downloaded).
   * Renderer renders a permanent badge next to the Home button based on
   * this state. Download is user-gated (badge click) — see `downloadAppUpdate`.
   *
   * Both this method and `getAppUpdateState` reference the SoT
   * `UpdateState` union from `src/shared/update-state.ts` — never inline
   * the discriminated literals here (Field-Addition Sweep rule).
   */
  onAppUpdateState: (
    handler: (state: import("../../shared/update-state.js").UpdateState) => void,
  ) => () => void;
  /** Late-mount sync: fetch the last broadcasted state. */
  getAppUpdateState: () => Promise<import("../../shared/update-state.js").UpdateState>;
  /** Trigger download. Valid only when state is "available". */
  downloadAppUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  /** Quit & install after main-owned native confirmation. Valid only when state is "downloaded". */
  installAppUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  /** Hide the current available/downloaded app update until a newer version appears. */
  skipAppUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  onBootstrapStatus: (
    h: (status:
      | { phase: "start" }
      | { phase: "complete"; installed: string[]; failed: Array<{ id: string; error: string }>; skippedReason?: string }
      | { phase: "error"; message: string }
    ) => void,
  ) => () => void;
  retryBootstrap: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onPluginInstallResult: (h: (payload: { slug: string; success: boolean; preparing?: boolean; error?: string }) => void) => () => void;
  onPluginUninstallResult: (h: (payload: { slug: string; success: boolean; error?: string }) => void) => () => void;
  /** #1176 — plugin active/inactive toggled (this surface or another). */
  onPluginEnabledChanged?: (h: (payload: { pluginId: string; enabled: boolean }) => void) => () => void;
  /** Fires after a loaded plugin runtime is restarted/reloaded without a full app restart. */
  onPluginRuntimeUpdated?: (h: (payload: { pluginId: string }) => void) => () => void;
  onAgentInstallResult: (h: (payload: { slug: string; success: boolean; agentId?: string; error?: string }) => void) => () => void;
  onAgentUninstallResult: (h: (payload: { slug: string; success: boolean; agentId?: string; error?: string }) => void) => () => void;
  onSkillInstallResult: (h: (payload: { slug: string; success: boolean; skillId?: string; error?: string }) => void) => () => void;
  onSkillUninstallResult: (h: (payload: { slug: string; success: boolean; skillId?: string; error?: string }) => void) => () => void;
  /**
   * Dev-only: open a folder picker and install a local plugin directory.
   *
   * Return shape:
   *   - `null` — the user cancelled the folder picker. NOT an error.
   *   - `{ pluginId, installed: true }` — install succeeded.
   *   - throws — auth/dev-mode/IO error. Callers must catch + surface as a
   *     toast/alert; collapsing the error into `null` would hide failures.
   */
  installLocalPlugin: () => Promise<{ pluginId: string; installed: true } | null>;
  onPluginInstallProgress: (h: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" | "preparing" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => () => void;
  onAgentInstallProgress: (h: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => () => void;
  onSkillInstallProgress: (h: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => () => void;
  getRuntimeCounts: () => Promise<{ tools: number; plugins: number; mcps: number }>;
  getRuntimeEnv: () => Promise<{ platform: string; hostname: string; user: string }>;
  pingMarketplace: () => Promise<{ configured: boolean; online: boolean }>;
  pingAiProvider: () => Promise<AiProviderPingIpcResult>;
  /**
   * Settings "일반" dashboard host metadata. SoT for `version` is the LVIS
   * project package.json resolved by the main process via
   * `app.getAppPath()`; stack fields (`electronVersion` / `nodeVersion` /
   * `chromeVersion` / `v8Version`) come from `process.versions`. The
   * renderer never duplicates these values.
   */
  getAppInfo: () => Promise<{
    version: string;
    electronVersion: string;
    nodeVersion: string;
    chromeVersion: string;
    v8Version: string;
    platform: NodeJS.Platform;
    arch: string;
    userDataPath: string;
  }>;
  registerPluginWebview: (payload: { webContentsId: number; pluginId: string; entryUrl: string }) => Promise<{ ok: boolean; error?: string }>;
  onViewActivate: (h: (k: string) => void) => () => void;
  getUsageSummary: (days?: number) => Promise<UsageSummaryShape>;
  getUsageRange: (opts: { dateFrom: string; dateTo: string }) => Promise<UsageSummaryShape>;
  getUsageDailySummary: (input: UsageDailySummaryInput) => Promise<UsageDailySummaryResult>;
  exportUsageCsv: (rows: Array<Record<string, string | number>>) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean }>;
  plugins: {
    getPerfStats: () => Promise<Record<string, PluginPerfStats>>;
  };
  // Workflow tools — routines v2
  onAskUserQuestion: (
    h: (req: {
      id: string;
      questions: Array<{
        question: string;
        choices?: string[];
        recommendedIndex?: number;
        altIndices?: number[];
        allowFreeText: boolean;
        allowMultiple?: boolean;
        placeholder?: string;
        summaryHint?: string;
      }>;
      createdAt: number;
    }) => void,
  ) => () => void;
  respondAskUserQuestion: (response: {
    requestId: string;
    answers?: Array<{
      choice?: string;
      /** Multi-select selections (only set when the question allowMultiple). */
      choices?: string[];
      freeText?: string;
    }>;
    dismissed?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** Renderer is notified when the gate's 5-minute timeout fires. */
  onAskUserQuestionTimeout?: (
    h: (payload: { requestId: string }) => void,
  ) => () => void;
  listSessionTodos: (sessionId?: string) => Promise<SessionTodoItem[]>;
  clearSessionTodos: (sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
  onSessionTodoChanged: (
    h: (payload: {
      sessionId: string;
      items: SessionTodoItem[];
    }) => void,
  ) => () => void;
  onAgentSpawnEvent: (
    // Structurally mirrors `AgentSpawnEvent` in `tools/agent-spawn.ts`. The
    // renderer can't import that module (it pulls Node built-ins), so the shape
    // is duplicated here; both reference the pure `ChatEntry` model from
    // `lib/chat-stream-state.ts`. `entries` is the FULL child transcript
    // snapshot (idempotent replace on activity/done).
    h: (event: {
      spawnId: string;
      type: "start" | "activity" | "done" | "error";
      title?: string;
      entries?: ChatEntry[];
      summary?: string;
      toolCallCount?: number;
      message?: string;
      toolUseId?: string;
      // JOIN KEY for unifying a spawn + its resumes into one transcript (see
      // `AgentSpawnEvent.childSessionId` in `tools/agent-spawn.ts`).
      childSessionId?: string;
    }) => void,
  ) => () => void;
  onSkillLoaded: (
    h: (event: {
      name: string;
      description: string;
    }) => void,
  ) => () => void;
  // ─── Notifications (#260) ────────────────────────
  onNotificationToast?: (
    h: (payload: {
      kind: "turn-end" | "routine" | "ask-user" | "approval" | "plugin" | "system";
      title: string;
      body: string;
      contextRef?: {
        sessionId?: string;
        routineId?: string;
        questionId?: string;
        approvalId?: string;
      };
    }) => void,
  ) => () => void;
  onNotificationClicked?: (
    h: (payload: {
      kind: "turn-end" | "routine" | "ask-user" | "approval" | "plugin" | "system";
      contextRef?: {
        sessionId?: string;
        routineId?: string;
        questionId?: string;
        approvalId?: string;
      };
    }) => void,
  ) => () => void;
  notifyClick?: (payload: {
    kind: "turn-end" | "routine" | "ask-user" | "approval" | "plugin" | "system";
    contextRef?: {
      sessionId?: string;
      routineId?: string;
      questionId?: string;
      approvalId?: string;
    };
  }) => Promise<{ ok: boolean }>;

  // ─── Window management (tab detach + magnetic snap) ─────────────────────
  window?: {
    openDetached: (viewKey: string) => Promise<{ ok: true; windowId: number } | { ok: false; error: string }>;
    closeDetached: () => Promise<{ ok: true } | { ok: false; error: string }>;
    listDetached: () => Promise<Array<{ windowId: number; viewKey: string; snapped: boolean }>>;
    /** Close all detached windows (fired on the work-mode transition). Auth/login windows are excluded. */
    closeAllDetached: () => Promise<{ ok: true } | { ok: false; error: string }>;
    loadSessionInMain: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    /** Resize the main window to match the workspace mode (work → centered canvas; chat → 기존 right-docked). */
    resizeForMode: (mode: "chat" | "work") => Promise<{ ok: true } | { ok: false; error: string }>;
    /** Resize the chat-mode main window when the right-side work panel opens/closes. */
    resizeForSidePanel: (open: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
    openHtmlPreview: (payload: OpenHtmlPreviewWindowPayload) => Promise<OpenHtmlPreviewWindowResult>;
    onSnapEdge: (handler: (edge: "n" | "s" | "e" | "w" | null) => void) => () => void;
    /** Subscribe to in-place navigation (single-instance shell content swap). */
    onDetachedNavigate: (handler: (viewKey: string) => void) => () => void;
    onLoadSessionInMain: (handler: (sessionId: string) => boolean | void | Promise<boolean | void>) => () => void;
  };
  /**
   * Dev tools bridge — only useful in non-production NODE_ENV. Renderer
   * floating panel uses these to adjust token preflight threshold at
   * runtime. production builds reject set/get with `production-disabled`.
   */
  dev: {
    setPreflightOverride: (tokens: number | null) => Promise<
      { ok: true; value: number | null } | { ok: false; error: string }
    >;
    getPreflightStatus: () => Promise<
      | { ok: true; runtimeOverride: number | null; envOverride: number | null; effective: number; provider: string; model: string }
      | { ok: false; error: string }
    >;
  };
};

// ─── Approval types (mirrored from approval-gate.ts — no node import in renderer) ─
export type ApprovalChoice = "allow-once" | "allow-session" | "allow-always" | "deny-once" | "deny-always";

/**
 * Permission policy — discriminated approval kinds. Renderer routes on this to
 * pick the right card. Default `"tool"` is the standard approval dialog.
 */
export type ApprovalKind = "tool" | "out-of-allowed-dir" | "agent-action";

export type ApprovalRequest = {
  id: string;
  category: "tool" | "agent-action";
  /** Permission policy — discriminator (defaults to "tool" when absent). */
  kind?: ApprovalKind;
  toolName: string;
  /** Permission policy category for the invocation shown in the UI. */
  toolCategory?: "read" | "write" | "shell" | "network" | "meta";
  /** Reviewer verdict when the ask came from auto-review. */
  reviewerVerdict?: { level: "low" | "medium" | "high"; reason: string };
  /** Captured policy/sandbox context for user review. */
  evaluationContext?: PermissionEvaluationContextShape;
  /** Suggested natural-language purpose shown in the approval dialog. */
  approvalPurpose?: ApprovalPurposeSuggestion;
  args: unknown;
  reason: string;
  source?: "builtin" | "plugin" | "mcp";
  /** Plugin id that issued this approval request, when source === "plugin". */
  sourcePluginId?: string;
  /** Manifest-declared plugin approval scope for agent-action requests. */
  approvalScope?: string;
  createdAt: number;
  requireExplicit: boolean;
  target?: { filePath?: string };
  isReadOnly?: boolean;
  mode?: "default" | "ask_all" | "plan" | "full_auto";
  /** Confused-deputy nonce issued by the main process; renderer echoes verbatim. */
  nonce?: string;
  /** HMAC over (id, nonce, toolName, args) — echoed verbatim for confused-deputy defense. */
  hmac?: string;
  /**
   * Permission policy — present when `kind === "out-of-allowed-dir"`. Carries
   * the auto-suggest payload so the renderer can render the directory-
   * confirm card without re-running validation.
   */
  outOfAllowedDir?: {
    candidatePath: string;
    suggestedParent: string | null;
    currentAllowed: readonly string[];
    adjacencyWarnings: readonly string[];
  };
  /** Permission policy trust-origin classification, e.g. "user" / "agent". */
  trustOrigin?: string;
  /**
   * Semantic cache key for the approval (e.g. a stable hash of
   * the tool invocation, distinct from the raw args string). Propagated from
   * the main process so the renderer can include it in the record IPC call,
   * ensuring record/lookup key symmetry in user-approval-store.
   */
  approvalCacheKey?: string;
  /**
   * Issue #691 — OS-level execution sandbox capability captured at
   * request build time. Renderer surfaces this in the approval card so
   * the user can see whether the tool will run under the ASRT sandbox
   * (`asrt`) or with no isolation.
   *
   * Mirrors the canonical SandboxKind union in
   * src/permissions/sandbox-capability.ts. `platform` is typed
   * `NodeJS.Platform` (strict enum) instead of `string` so the renderer type
   * cannot silently widen the canonical SOT shape.
   */
  sandboxCapability?: {
    kind: "none" | "asrt" | "partial" | "fs-only";
    confidence: "verified" | "assumed" | "policy-best-effort";
    platform: NodeJS.Platform;
    reason: string;
    /**
     * Per-dimension confinement (filesystem / process / network) for the
     * substrate this capability describes. Mirrors the optional `confines`
     * field on the canonical SandboxCapability so the approval dialog can show
     * an HONEST label — e.g. Windows ASRT confines filesystem + network but not
     * process, and the dialog must not show a blanket full-isolation label.
     * Absent ⇒ "not declared";
     * callers MUST NOT read absence as "all confined".
     */
    confines?: SandboxConfinement;
  };
};
export type ApprovalDecision = {
  requestId: string;
  choice: ApprovalChoice;
  rememberPattern?: string;
  /** One-shot MCP elicitation form content returned with an allow decision. */
  elicitationContent?: Record<string, unknown>;
  /** Echoed nonce from the matching ApprovalRequest (confused-deputy defense). */
  nonce?: string;
  /** Echoed HMAC from the matching ApprovalRequest (confused-deputy defense). */
  hmac?: string;
};

  export type LvisApprovalApi = {
  onRequest: (cb: (req: ApprovalRequest) => void) => () => void;
  respond: (decision: ApprovalDecision) => Promise<unknown>;
};

/** User-Approval Store API */
/**
 * Approval scope + verdict — re-uses the union literal types from the
 * shared SOT (`UserApprovalScope` / `UserApprovalVerdict`) so renderer
 * types stay in lockstep with the IPC contract. Issue #802 follow-up
 * (cross-cutting review of PRs #822-#827).
 */
import type {
  PermissionReviewSuggestionPayload,
  UserApprovalHitPayload,
  UserApprovalScope,
  UserApprovalVerdict,
} from "../../shared/permissions-events.js";

export type LvisUserApprovalApi = {
  record: (entry: {
    /** #799 P0: ID of the in-flight ApprovalRequest. Main process reads the
     *  authoritative trustOrigin/source/approvalCacheKey from this ID via
     *  ApprovalGate.getRequestSnapshot — renderer-supplied authority fields
     *  below are ignored (kept on the wire for legacy callers + audit). */
    requestId: string;
    toolName: string;
    args: string;
    source: string;
    scope: UserApprovalScope;
    verdictAtApproval: UserApprovalVerdict;
    nlJustification: string | null;
    /** Propagate trust origin for record/lookup key symmetry. */
    trustOrigin?: string;
    /** Propagate cache key for record/lookup key symmetry. */
    approvalCacheKey?: string;
  }) => Promise<{ ok: boolean; error?: string; message?: string }>;
  revokeByKey: (key: string) => Promise<{ ok: boolean; error?: string; message?: string }>;
  list: () => Promise<Array<{
    key: string;
    approvedAt: string;
    scope: UserApprovalScope;
    verdictAtApproval: UserApprovalVerdict;
    nlJustification: string | null;
    revokedAt: string | null;
    /** Display metadata stored alongside the entry. */
    toolName?: string;
    source?: string;
  }>>;
};

export type PermissionRule = { pattern: string; action: "allow" | "deny"; source?: string };

export type AddRuleResult =
  | { ok: true; rule: PermissionRule }
  | { ok: false; error: string; message?: string };

export type RemoveRuleResult =
  | { ok: true }
  | { ok: false; error: string; message?: string };

/** Permission policy — deferred-queue entry shape mirrored from main process. */
export interface DeferredQueueEntry {
  id: string;
  ts: string;
  toolName: string;
  source: "builtin" | "plugin" | "mcp";
  category: "read" | "write" | "shell" | "network" | "meta";
  inputSummary: string;
  /** Captured policy/sandbox context for user review. */
  evaluationContext?: PermissionEvaluationContextShape;
  verdict: { level: "low" | "medium" | "high"; reason: string };
  status: "pending" | "approved" | "rejected";
  resolvedAt?: string;
  resolutionReason?: string;
}

export interface HookTrustRow {
  fileName: string;
  hookType: "pre" | "post" | "perm";
  sha256: string;
  state: "trusted" | "new" | "changed" | "removed" | "disabled";
  previousSha256?: string;
  /**
   * #811 command-hooks — additive trust-review fields. Present on the
   * `hooks.json` config trust-unit row so the trust list can surface its
   * declared command/event/matcher entries. Absent on legacy `.sh` rows.
   * Mirrors `src/hooks/hook-trust-commands.ts::HookTrustRow` (additive).
   */
  source?: "sh" | "config";
  entryCount?: number;
  entries?: Array<{ event: "pre" | "post" | "perm"; matcher?: string; command: string }>;
}

export type PermissionReviewerMode = "disabled" | "rule" | "llm" | "strict";
export type PermissionReviewerProvider = "openai" | "anthropic" | "google" | "foundry" | "gcp-playground";
export type PermissionReviewerFallbackOnError = "deny" | "rule";
/** Issue #690 — interactive reviewer auto-approve scope. */
export type PermissionReviewerInteractiveAutoApprove = "off" | "low";

export interface PermissionReviewerSettings {
  mode: PermissionReviewerMode;
  provider: PermissionReviewerProvider;
  model: string;
  fallbackOnError: PermissionReviewerFallbackOnError;
  interactive: { autoApprove: PermissionReviewerInteractiveAutoApprove };
}

export type PermissionReviewerDispatchResult =
  | {
      ok: true;
      verb: "show" | "mode" | "provider" | "model" | "fallback" | "interactive";
      settings: PermissionReviewerSettings;
      /**
       * Runtime degrade flag — true when the persisted reviewer mode is "llm"
       * but boot wiring could not instantiate the LLM provider (no chat
       * provider/key configured) and fell back to the rule classifier. The UI
       * surfaces a banner. Undefined on legacy/main builds that do not report it.
       */
      reviewerDegradedToRule?: boolean;
    }
  | { ok: false; error: string };

export type LvisPermissionApi = {
  getMode: () => Promise<{ mode: string }>;
  setMode: (mode: string) => Promise<
    | { ok: true; mode: string }
    | { ok: false; error: string; message?: string }
  >;
  onModeChanged: (cb: (mode: string) => void) => () => void;
  /**
   * Hint event — directory config mutated. Listeners refresh state via
   * `permission.dirDispatch("list")` rather than receiving payload data
   * (slash dispatcher is the single source of truth).
   */
  onConfigChanged: (cb: () => void) => () => void;
  listRules: () => Promise<PermissionRule[]>;
  addRule: (pattern: string, action: "allow" | "deny") => Promise<AddRuleResult>;
  removeRule: (pattern: string, action: "allow" | "deny") => Promise<RemoveRuleResult>;
  /** Permission policy — list pending HIGH-risk deferred entries from reviewer. */
  deferredList: () => Promise<
    | { ok: true; pending: DeferredQueueEntry[]; total: number }
    | { ok: false; error: string }
  >;
  /** Permission policy issue #633 — list active + quarantined script hooks. */
  hookTrustList: () => Promise<
    | { ok: true; active: HookTrustRow[]; disabled: HookTrustRow[]; totalDisabled: number }
    | { ok: false; error: string }
  >;
  /** Permission policy — `/permission dir ...` slash dispatch. */
  dirDispatch: (
    rawArgs: string,
  ) => Promise<
    | { ok: true; verb: "allow"; persisted: string[]; sessionOnly: boolean; warnings: string[] }
    | { ok: true; verb: "deny"; persisted: string[] }
    | { ok: true; verb: "list"; defaults: string[]; userAdditions: string[]; effective: string[] }
    | { ok: false; error: string }
  >;
  /**
   * Permission policy — resolve a pending entry with user gesture.
   *
   * `approvalSource` records how the user gestured:
   *   - "button"           — clicked the DeferredQueuePanel button
   *   - "natural-language" — clicked the chat-surface chip after the
   *                          renderer's intent matcher detected an
   *                          approval phrase. NOT auto-applied; the
   *                          chip still requires an explicit click.
   * Required: every deferred resolution must explicitly declare
   * provenance before main writes the tamper-evident audit row.
   */
  deferredResolve: (
    id: string,
    decision: "approved" | "rejected",
    reason: string | undefined,
    approvalSource: "button" | "natural-language",
  ) => Promise<
    | { ok: true; entry: DeferredQueueEntry }
    | { ok: false; error: string }
  >;
  /** Permission policy — subscribe to foreground-entry deferred-pending events. */
  onDeferredPending: (cb: (summary: { pending: number }) => void) => () => void;
  /** Permission policy — subscribe to manifest-integrity violation notifications. */
  onManifestViolation: (
    handler: (payload: {
      pluginId: string;
      toolName: string;
      attempted: string;
    }) => void,
  ) => () => void;
  /**
   * Permission policy CRITICAL 4.1 — subscribe to user-approval memory-hit
   * disclosure events. Fires when a user-approval cache entry auto-resolves
   * a tool invocation that would otherwise have prompted. Renderer is
   * expected to surface a transient toast/banner so the user sees that a
   * stored approval was applied. Returns an unsubscribe function.
   */
  onUserApprovalHit: (cb: (payload: UserApprovalHitPayload) => void) => () => void;
  /** Read-only: honest OS sandbox capability for the current platform. */
  sandboxCapability: () => Promise<SandboxCapabilityInfo>;
  /** Read-only: Windows srt-win install readiness (group + WFP + verbatim instructions). */
  sandboxWindowsStatus: () => Promise<SandboxWindowsStatusInfo>;
  /**
   * MUTATING: trigger the one-time Windows srt-win install (one self-elevating
   * UAC prompt). The ONLY user-consented privilege-escalation entry point —
   * call ONLY from an explicit "Install now" click. Resolves `{cancelled:true}`
   * on UAC dismissal (revert the toggle), else the post-install group + WFP state.
   */
  sandboxWindowsInstall: () => Promise<SandboxWindowsInstallResult>;
  /** Subscribe to default-mode repeated-approval hints for LLM permission review. */
  onReviewSuggestion?: (cb: (payload: PermissionReviewSuggestionPayload) => void) => () => void;
  /** Permission policy — `/permission reviewer ...` slash dispatch. */
  reviewerDispatch: (
    rawArgs: string,
  ) => Promise<PermissionReviewerDispatchResult>;
  /**
   * Permission policy C3 — check whether an API key (or GCP service account)
   * is stored for a given reviewer provider. Used by the settings UI to
   * determine which providers are selectable (key-driven dynamic activation).
   */
  reviewerProviderHasKey: (provider: PermissionReviewerProvider) => Promise<boolean>;
  /** Permission policy — `/permission audit show` — recent permission audit entries. */
  auditShow: (last: number) => Promise<
    | {
        ok: true;
        entries: PermissionAuditEntrySummary[];
        total: number;
        summary: { files: number; bytes: number };
      }
    | { ok: false; error: string }
  >;
  /** Permission policy — `/permission audit verify` — HMAC chain integrity check. */
  auditVerify: () => Promise<
    | {
        ok: true;
        intact: boolean;
        totalFiles: number;
        totalEntries: number;
        firstBrokenFile?: string;
        perDay: Array<{
          file: string;
          totalLines: number;
          chainOk: boolean;
          firstBrokenLineIndex?: number;
          reason?: string;
          sealMatch: boolean | null;
        }>;
      }
    | { ok: false; error: string }
  >;
};

/**
 * Permission policy — minimal audit entry shape surfaced to the renderer's
 * `AuditPanel`. The full discriminated union (with `decision` field
 * + per-decision payload) is sent verbatim — this type is just a
 * structural tag the panel uses to gate the expand/filter UI.
 */
export interface PermissionAuditEntrySummary {
  ts: string;
  auditId: string;
  decision: string;
  trustOrigin: string;
  prevHash: string;
  /** Anything else from the discriminated union — opaque to the renderer. */
  [key: string]: unknown;
}

export type LvisPolicyApi = {
  get: () => Promise<{
    version: 1;
    requireExplicitApproval: boolean;
    managed: boolean;
    updatedAt: string;
    source: "defaults" | "user" | "admin" | "merged";
    adminOverrides?: string[];
    adminPath?: string;
  }>;
  set: (patch: unknown) => Promise<{ ok: boolean; policy?: unknown; error?: string; message?: string }>;
};

export type LvisPluginConfigApi = {
  get: (pluginId: string) => Promise<
    | { ok: true; config: PluginConfigRecord }
    | { ok: false; error: string; message?: string }
  >;
  set: (pluginId: string, config: Record<string, unknown>) => Promise<
    | { ok: true; config: PluginConfigRecord }
    | { ok: false; error: string; message?: string }
  >;
  /** Fetch the manifest's declarative settings schema. */
  getSchema: (pluginId: string) => Promise<
    | { ok: true; schema: PluginConfigSchemaSummary | null }
    | { ok: false; error: string; message?: string }
  >;
  /**
   * Persist a `format: "secret"` field. The value lands in
   * the encrypted keychain (`lvis-secrets.json`) and the host strips any
   * stale cleartext mirror from `pluginConfigs`.
   */
  setSecret: (pluginId: string, key: string, value: string) => Promise<
    | { ok: true }
    | { ok: false; error: string; message?: string }
  >;
  /**
   * US-3c.1 — batch secret-presence query. Returns the list of
   * `format:"secret"` keys from the plugin's configSchema for which the
   * keychain currently holds a value. Use this to populate `secretsPresent`
   * in PluginConfigSchemaForm so the masked "**** (저장됨)" placeholder
   * appears correctly. Fewer IPC round-trips than per-key checks.
   */
  listSecretKeys: (pluginId: string) => Promise<
    | { ok: true; keys: string[] }
    | { ok: false; error: string; message?: string }
  >;
};

export type LvisPluginsApi = {
  cards: () => Promise<PluginCardSummary[]>;
};

export type LvisHostMarketplaceApi = {
  installMarketplacePlugin: (
    id: string,
    expectedVersion?: string,
    options?: PluginMarketplaceInstallOptions,
  ) => Promise<PluginMarketplaceActionResult>;
  uninstallMarketplacePlugin: (id: string) => Promise<PluginMarketplaceActionResult>;
  installMarketplaceAgent?: (slug: string) => Promise<PluginMarketplaceActionResult>;
  uninstallMarketplaceAgent?: (slug: string) => Promise<PluginMarketplaceActionResult>;
  installMarketplaceSkill?: (slug: string) => Promise<PluginMarketplaceActionResult>;
  uninstallMarketplaceSkill?: (slug: string) => Promise<PluginMarketplaceActionResult>;
};

export type LvisHostApi = {
  takePluginMarketplaceApi: () => LvisHostMarketplaceApi | null;
};

export type LvisMcpApi = {
  servers: () => Promise<McpServerState[]>;
  kill: (id: string) => Promise<void>;
  getConfigs: () => Promise<McpServerConfigDto[]>;
  getConfigPath: () => Promise<string>;
  addConfig: (config: McpServerConfig) => Promise<{ connected: boolean; warning?: string }>;
  setApiKey: (id: string, apiKey: string) => Promise<{ connected: boolean; warning?: string }>;
  removeConfig: (id: string) => Promise<void>;
  /** MCP Apps UI resource fetch. */
  readUiResource: (serverId: string, uri: string) => Promise<string>;
};

export type ExecMode = "default" | "strict" | "auto" | "allow";

export type RenderHtmlPayload = {
  kind: "lvis.render_html";
  title?: string;
  height: number;
  html: string;
  warnings?: string[];
};

/**
 * Composer attachment API. Wired in `src/ipc/domains/attach.ts` (main) and
 * `src/preload.ts` (renderer bridge). Exposes file picker, image reader,
 * clipboard-image saver (writes to OS tmp), and shell-open.
 */
export interface LvisAttachApi {
  openFile: () => Promise<{
    canceled: boolean;
    files: Array<{
      path: string;
      name: string;
      ext: string;
      bytes: number;
      isImage: boolean;
      mimeType?: string;
    }>;
    rejected: string[];
  }>;
  readImage: (filePath: string) => Promise<{
    ok: boolean;
    dataUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
    error?: string;
  }>;
  saveClipboardImage: (base64: string) => Promise<{
    ok: boolean;
    path?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
    dataUrl?: string;
    error?: string;
  }>;
  openExternal: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Preview file-read surface (§6.10). Reads a text file for in-panel preview,
 * gated by the SAME traversal guard as the builtin `read_file` tool — never a
 * broader read authority. `error` is a kebab-case code the renderer maps to a
 * Korean message; `message` is English dev detail.
 */
export interface LvisPreviewApi {
  readFile: (path: string) => Promise<{
    ok: boolean;
    content?: string;
    path?: string;
    bytes?: number;
    truncated?: boolean;
    error?:
      | "unauthorized"
      | "path-not-allowed"
      | "sensitive-path"
      | "not-a-file"
      | "binary-file"
      | "too-large"
      | "read-failed";
    message?: string;
  }>;
}

/**
 * Workspace file-browser surface (§6.10). Project roots are persisted to
 * `permissions.additionalDirectories` (the executor's Layer 1 allow-list SOT),
 * so a browsable folder is exactly a readable folder.
 */
export interface LvisWorkspaceApi {
  listRoots: () => Promise<{
    ok: boolean;
    defaultRoot?: string;
    roots?: Array<{ path: string; isDefault: boolean }>;
    error?: string;
  }>;
  pickRoot: (opts?: { ackToken?: string }) => Promise<{
    ok: boolean;
    canceled?: boolean;
    added?: string;
    roots?: Array<{ path: string; isDefault: boolean }>;
    warnings?: string[];
    /** Adjacency warnings present + not persisted — renderer must confirm. */
    requiresAcknowledgement?: boolean;
    /** Picked path awaiting acknowledgement — display only. */
    pendingPath?: string;
    /** One-time token bound to the picked path — confirm by echoing it via `ackToken`. */
    ackToken?: string;
    error?: string;
  }>;
  listDir: (path: string) => Promise<{
    ok: boolean;
    path?: string;
    entries?: Array<{ name: string; path: string; type: "file" | "directory" }>;
    truncated?: boolean;
    error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-a-dir" | "read-failed";
    message?: string;
  }>;
  /** Remove an additional project root from the read allow-list. Never the default root. */
  removeRoot: (path: string) => Promise<{
    ok: boolean;
    removed?: string;
    roots?: Array<{ path: string; isDefault: boolean }>;
    error?: "unauthorized" | "invalid-path" | "not-an-additional-root" | "cannot-remove-default";
    message?: string;
  }>;
  /** Reveal a scope-revalidated file/folder in the OS file manager (location only, never opens it). */
  reveal: (path: string) => Promise<{
    ok: boolean;
    error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-found";
    message?: string;
  }>;
  /**
   * Drag-drop add-root, step 1 (#1458). Submit a renderer-resolved dropped folder
   * path (from `window.lvisDrop.resolveDroppedPaths`) for Layer-0 hard-deny +
   * is-a-directory validation. On success returns a one-time ack token bound to
   * the now-main-owned path — confirm the add via `pickRoot({ ackToken })`.
   */
  dropPrepare: (path: string) => Promise<{
    ok: boolean;
    error?: string;
    warnings?: string[];
    /** Validated main-owned path awaiting acknowledgement — display only. */
    pendingPath?: string;
    /** One-time token bound to the path — confirm by echoing it via `pickRoot`. */
    ackToken?: string;
  }>;
}

/**
 * Drop-path resolution bridge (#1458). Exposed as its own preload world. Resolves
 * dropped `File` objects to filesystem paths via `webUtils.getPathForFile` — the
 * ONLY context that can, since a `File` cannot cross IPC. The returned paths are
 * renderer-NAMED candidates that grant no capability; the main-process
 * `workspace.dropPrepare` gate makes the read-scope decision.
 */
export interface LvisDropApi {
  resolveDroppedPaths: (files: FileList | readonly File[]) => string[];
}

export interface LvisUiApi {
  showAssistantContextMenu: (
    payload: AssistantContextMenuPayload,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onAssistantContextAction: (
    cb: (action: AssistantContextMenuAction) => void,
  ) => () => void;
}

declare global {
  interface Window {
    lvisApi: LvisApi;
    lvisHost: LvisHostApi;
    lvisDrop: LvisDropApi;
    lvis: {
      permission: LvisPermissionApi;
      approval: LvisApprovalApi;
      userApproval: LvisUserApprovalApi;
      policy: LvisPolicyApi;
      mcp: LvisMcpApi;
      plugins: LvisPluginsApi;
      pluginConfig: LvisPluginConfigApi;
      ui: LvisUiApi;
      attach: LvisAttachApi;
      preview: LvisPreviewApi;
      workspace: LvisWorkspaceApi;
      env: {
        isDev: boolean;
        isE2E: boolean;
        enableDevConsole: boolean;
        debugStream: boolean;
      };
    };
  }
}
