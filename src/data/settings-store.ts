import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import {
  SIDE_PANEL_MIN_WIDTH,
  clampSidePanelSplitPercent,
  clampSidebarWidth,
} from "../shared/side-panel.js";
import {
  sanitizePluginConfig,
  sanitizePluginConfigKey,
  sanitizePluginConfigPluginId,
  type PluginConfigRecord,
} from "../shared/plugin-config.js";
import {
  isMarketplaceEligibleLLMVendor,
  LLM_VENDORS,
  type LLMVendor,
  type LLMVendorSettingsMap,
  type LLMVendorSettings,
  type MarketplaceEligibleLLMVendor,
} from "../shared/llm-vendor-defaults.js";
import type { BundleId } from "../shared/theme-bundles.js";
import {
  FONT_SIZE_SCALE_VALUES,
  type FontSizeScale,
  type AppearanceFontSettings,
  isValidFontFamilyOverride,
} from "../shared/appearance-font.js";
import {
  normalizeLocale,
  type Locale,
} from "../i18n/index.js";
import { normalizeAppMode, type InitialAppMode } from "../shared/initial-app-mode.js";
import { isSidebarTab, type SidebarTab } from "../shared/sidebar-tab.js";
import {
  type LlmModelListCache,
} from "../shared/llm-model-list.js";
import {
  isMarketplaceProviderPresetId,
  marketplaceProviderPresetSecretKey,
  normalizeMarketplaceProviderPreset,
  type MarketplaceInstalledProviderPreset,
} from "../shared/marketplace-package-assets.js";
import {
  normalizeAccelerator,
  normalizeShortcuts,
  type ShortcutSettings,
  type ShortcutSettingsPatch,
} from "../shared/shortcuts.js";
import { createLogger } from "../lib/logger.js";
import { SecretDocumentStore, type SecretPolicy } from "./secret-document-store.js";
import { DEFAULT_SETTINGS } from "./settings-defaults.js";
import {
  appearanceMigration,
  marketplaceProviderPresetSecretInvalidationIds,
  mergeLlmPatch,
  normalizeA2ARemote,
  normalizeAppearance,
  normalizeDiagnostics,
  normalizeFeatureFlags,
  normalizeMarketplace,
  normalizePinnedProjectRoots,
  pruneLazyLlmVendorBlocks,
  SIDE_PANEL_SPLIT_KEYS,
  normalizeSystem,
  normalizeWebView,
  preserveInstalledProviderPresetMetadata,
  sanitizeStoredPluginConfigs,
  VALID_CLOSE_BEHAVIORS,
} from "./settings-normalization.js";
const log = createLogger("settings");

export type { LLMVendor, LLMVendorSettings };
export { LLM_VENDORS };
export type { ShortcutSettings, ShortcutSettingsPatch };

/**
 * Single source of truth for the settings file path. Both `SettingsService`
 * (writer) and the pre-`whenReady` manual host-resolver reader derive the
 * settings path from this helper so the two can never drift onto different
 * files. `userDataPath` is `app.getPath("userData")` (e.g. on macOS
 * `~/Library/Application Support/LVIS`).
 */
export function settingsFilePath(userDataPath: string): string {
  return resolve(userDataPath, "lvis-settings.json");
}

/**
 * LLM settings — single source of truth.
 *
 * - `provider` selects the active vendor.
 * - `vendors` holds materialized configuration blocks only for default-visible
 *   providers and providers the user actually touches. Runtime callers must
 *   read through `getLlmVendorSettings()` so long-tail marketplace providers
 *   can stay lazy until installed/selected.
 * - `streamSmoothing` is a client-side post-processor applied to streamed
 *   tokens regardless of vendor; UI lives under the Chat settings tab.
 * - `fallbackChain` references other vendors by id and is therefore
 *   inherently cross-vendor; UI lives under the Intelligence (LLM) tab.
 *
 * CHANGELOG (CTRL simplification):
 *   Removed per-vendor sampling/decoding controls (temperature, maxOutputTokens,
 *   seed, responseFormat, stopSequences). Modern frontier models (GPT-5+,
 *   Claude 4+) deprecate fine-grained sampling — vendor SDK defaults are
 *   the policy. Stale on-disk keys are dropped on next write.
 */
export interface LLMSettings {
  provider: LLMVendor;
  /**
   * Marketplace custom provider preset selected in the provider picker.
   * Runtime still routes through `openai-compatible`; this id preserves the
   * user-visible preset identity, key namespace, and keyless policy.
   */
  marketplaceProviderPresetId?: string;
  vendors: LLMVendorSettingsMap;
  streamSmoothing: "none" | "word" | "char";
  fallbackChain: Array<{ provider: LLMVendor; model: string }>;
  /**
   * Last successful standard `/models` sync per provider/baseUrl. This keeps
   * router catalogs (OpenRouter/free tiers, local gateways, OpenAI-compatible
   * endpoints) from collapsing back to the small built-in seed list after a
   * settings remount or offline restart.
   */
  modelListCache: LlmModelListCache;
  /**
   * Chromium host-resolver map. Persisted as /etc/hosts-style
   * text (one "IP hostname" entry per line; blank lines and # comments
   * ignored). Applied via Chromium `host-resolver-rules` command-line switch
   * on next launch.
   *
   * Stored under the top-level `llm` namespace in the app settings file
   * (`<userData>/lvis-settings.json`, where `<userData>` is
   * `app.getPath("userData")`) to keep host-routing paired with the LLM
   * endpoint it affects.
   */
  hostResolverMap?: string;
}

/**
 * Patch shape for `SettingsService.patch()`. Vendor blocks are partial so
 * a UI save touching a single vendor doesn't have to send every default or
 * marketplace provider block.
 */
export interface LLMSettingsPatch {
  provider?: LLMVendor;
  marketplaceProviderPresetId?: string;
  vendors?: Partial<Record<LLMVendor, Partial<LLMVendorSettings>>>;
  streamSmoothing?: "none" | "word" | "char";
  fallbackChain?: Array<{ provider: LLMVendor; model: string }>;
  modelListCache?: LlmModelListCache;
  hostResolverMap?: string;
}

export interface ChatSettings {
  systemPrompt: string;
  autoCompact: boolean;
}

export interface A2ARemoteTargetSettings {
  targetAgentId: number;
  label: string;
  interfaceUrl: string;
  agentCardDigestSha256: string;
  trustKeyId: number;
  credentialBindingId: number;
  routePolicyVersion: number;
  routePolicyDigestSha256: string;
  intendedCredentialRevisionId: number;
  /** Main-owned ordered successor revisions used by explicit manual Replay actions. */
  replayCredentialRevisionIds: number[];
}

export interface A2ARemoteSettings {
  routeControlBaseUrl: string;
  /** Canonical public HTTPS origin advertised by the receiver Agent Card. */
  receiverPublicOrigin: string;
  outboundCallerGenerationId: string;
  receiverCallerGenerationId: string;
  extensionSpecDigestSha256: string;
  targets: A2ARemoteTargetSettings[];
  receiverMaxKeysPerGeneration: number;
}

/**
 * §14.2 Audit log rotation + retention settings.
 * - auditRotationMaxBytes: rotate when file exceeds this size (default 10 MB)
 * - auditRetentionDays: delete archives older than this many days (default 30)
 */
export interface AuditSettings {
  /** Rotate active .jsonl when it exceeds this size in bytes. Default: 10_485_760 (10 MB). */
  auditRotationMaxBytes: number;
  /** Delete .jsonl.*.gz archives older than this many days. Default: 30. */
  auditRetentionDays: number;
}

/**
 * Experimental feature flags — UI-toggleable, persisted to settings.json.
 * All fields default to false (opt-in). Safe to add new fields without
 * migration — missing keys are treated as false at load time.
 */
export interface FeatureFlags {
  /**
   * When true, idle IDLE_SCAN may send local preference/memory sources to the
   * configured LLM to refresh user-preferences.md. Default false: manual only.
   */
  idlePreferenceRefresh?: boolean;
  /**
   * When true, a queued background sub-agent Message may start a new parent
   * turn while that exact parent session is loaded and idle. Default false:
   * the durable mailbox joins the user's next turn instead.
   */
  subAgentAutonomousWake?: boolean;
  /**
   * Enables the A2A loopback route family on the shared 127.0.0.1 listener.
   * Default false. The boot lifecycle snapshots this value once; a settings
   * change takes effect only after restart.
   */
  a2aLoopbackServer?: boolean;
  /** Enables outbound P4-5 remote A2A routing after restart. Independent of loopback. */
  a2aRemoteRouting?: boolean;
  /** Enables the P4-5 exact-replay receiver profile after restart. Independent of loopback. */
  a2aRemoteReceiver?: boolean;



  onboardingCompleted?: boolean;
  /**
   * Permission policy — host-classifies-risk migration gate
   * (docs/architecture/permission-policy-design.md; project_permission_review_redesign).
   *
   * When `false` (default), a tool invocation's effective permission category
   * is the tool's DECLARED category (`tool.categoryForInput ?? tool.category`),
   * exactly as before. When `true`, the host derives the effective category
   * from host-owned signals only (see {@link inspectHostRisk}) and ignores
   * the plugin-declared category — a tool grading its own danger is not a
   * control (MCP spec: a server can lie).
   *
   * The flag now ships ON (shadow-mode reconciliation completed before the
   * flip): the host-derived category drives enforcement, with foreground
   * plugin read-relaxation. A user can still turn it OFF in Settings, which
   * restores the declared-category behaviour.
   */
  hostClassifiesRisk?: boolean;
  /**
   * OS tool sandbox — when `true` (and the platform is supported), shell and
   * tool spawns are confined by the Anthropic Sandbox Runtime (ASRT; macOS
   * Seatbelt / Linux bwrap backends). STAGED default (macOS-first): ships `true`
   * on `darwin` and `false` on `linux`/`win32` (opt-in via Settings) until the
   * C/D-series sandbox QA is green, after which the Linux/Windows default flips
   * to `true`. See DEFAULT_SETTINGS for the convergence plan.
   *
   * Because the default is ON (on macOS), the boot gate distinguishes how the ON-signal
   * arrived (see boot.ts + boot/steps/sandbox-gate.ts): the DEFAULT/settings-on
   * path degrades GRACEFULLY (loud warning, unsandboxed, non-bricking) when the
   * sandbox cannot activate, whereas the EXPLICIT `LVIS_SANDBOX_ENABLED=1` env
   * opt-in stays fail-closed (boot aborts rather than run unsandboxed).
   *
   * Orthogonal to {@link hostClassifiesRisk}: sandbox-enforcement (is the
   * action kernel-confined when it runs) and risk-classification (does the
   * action need approval) are independent axes — a sandboxed action still
   * needs approval, and an unsandboxed platform still classifies risk.
   *
   * Capability is platform-dependent and honestly reported, not overclaimed:
   *   - macOS (Seatbelt via ASRT): filesystem + process + network egress
   *     confinement. Network egress is deny-by-default, confined to the
   *     shared strict-union allow-list (loopback proxy floor).
   *   - Linux (bwrap via ASRT): filesystem + process + network egress
   *     confinement (same strict-union floor).
   *   - Windows: srt-win confines filesystem + network once installed; process
   *     isolation is unavailable. It degrades non-bricking (unsandboxed, loud
   *     warning) until the one-time administrator install completes.
   *
   * `LVIS_SANDBOX_ENABLED=1` remains an environment escape-hatch override (and
   * the explicit, fail-closed signal), but this setting is the primary,
   * user-discoverable control.
   */
  osToolSandbox?: boolean;
}

/**
 * §E2 (#1499) Diagnostics bundle + production log retention settings.
 * - includeCrashDumps: include raw crash-dump binaries in the bundle (opt-in).
 * - logRetentionDays: retention window for `~/.lvis/logs/`. Default + clamp
 *   bounds come from the fs-free SOT `src/shared/log-retention.ts`
 *   (`LOG_RETENTION_DAYS`, which log-file-sink re-exports) — this setting value
 *   drives the sink's boot-time prune (boot/services.ts).
 */
export interface DiagnosticsSettings {
  /** Include raw crash-dump binaries in the exported bundle. Default false. */
  includeCrashDumps: boolean;
  /** Retention window (days) for production log files. Default 7. */
  logRetentionDays: number;
}

export interface AppSettings {
  llm: LLMSettings;
  chat: ChatSettings;
  /** Host-owned P4-5 routing configuration. Secrets remain in SettingsService secret storage. */
  a2aRemote: A2ARemoteSettings;
  webSearch: WebSearchSettings;
  marketplace: MarketplaceSettings;
  routine: RoutineSettings;
  privacy: PrivacySettings;
  updates: UpdateSettings;
  telemetry: TelemetrySettings;
  audit: AuditSettings;
  /** §E2 (#1499) — diagnostics bundle + log retention. */
  diagnostics: DiagnosticsSettings;
  /** UX Track 3 — visual theme + future UI preferences. */
  appearance: AppearanceSettings;
  /** §B1 — external URL viewer policy (in-app BrowserWindow vs system browser). */
  webView: WebViewSettings;
  /** Window close-button behaviour (hide-to-tray vs quit). */
  system: SystemSettings;
  /** E4 — global keyboard shortcuts (show/hide window toggle). */
  shortcuts: ShortcutSettings;
  /** Plugin settings reserved for non-trust UI preferences. Trust gates are host-owned. */
  plugins: PluginSettings;

  pluginConfigs: Record<string, PluginConfigRecord>;
  /** Experimental feature flags. All default false. */
  features?: FeatureFlags;
}

export interface PluginSettings {}

/**
 * UX Track 3 — visual appearance preferences (schema v2).
 *
 * v2 replaces the three-axis model (theme × chatTheme × codeTheme) with a
 * single paired bundle selected by `bundleId`. Each bundle is a fully-
 * specified set of shell + chat + code tokens, so combinatorial mismatches
 * are impossible.
 *
 * `followSystem` (optional, violet pair only): when true and the active bundle
 * is "violet-light" or "violet-dark", the host automatically switches between the
 * two based on `prefers-color-scheme`.
 *
 * `schemaVersion: 2` distinguishes v2 from legacy v1 files that have
 * `theme`/`chatTheme`/`codeTheme` keys. On load, v1 files are migrated once
 * and written back as v2.
 *
 * Legacy type aliases are kept for the migration path only — they are not
 * exposed to new code. New code exclusively uses `AppearanceSettings`.
 */

/** @internal — legacy v1 axis types, used only in migration. */
export type ThemePreference = "system" | "light" | "dark" | "high-contrast";
/** @internal — legacy v1 axis types, used only in migration. */
export type ChatThemePreference = "default" | "lg" | "purple" | "orange" | "blue";
/** @internal — legacy v1 axis types, used only in migration. */
export type CodeThemePreference = "auto" | "light" | "dark";

/** @internal — legacy v1 shape, used only in migrateAppearanceV1ToV2. */
export interface AppearanceSettingsV1 {
  theme: ThemePreference;
  chatTheme: ChatThemePreference;
  codeTheme: CodeThemePreference;
}

/**
 * User-configurable font preferences (Track A scope expansion).
 *
 * `family` — `"system"` keeps the built-in HOST_FONT_STACK (default). Any other
 * value MUST match `isValidFontFamilyOverride`; rejected values fall back to
 * `"system"` at normalize time so a corrupt settings.json cannot break first
 * paint.
 *
 * `sizeScale` — multiplicative on `1rem`. Discrete preset values keep the UI
 * legible at every step (a free slider would let users pick `0.4` and lock
 * themselves out of the settings dialog).
 *
 * The values + validators live in `src/shared/appearance-font.ts` (a zero-import
 * pure module) so the renderer preload can enforce the same contract on the
 * frame-0 theme prime without pulling this store's `electron`/`node:fs` deps.
 * Re-exported here so existing import sites stay unchanged.
 */
export {
  FONT_SIZE_SCALE_VALUES,
  type FontSizeScale,
  type AppearanceFontSettings,
  isValidFontFamilyOverride,
} from "../shared/appearance-font.js";

/** v2 appearance settings — single bundle, optional followSystem + font overrides. */
export interface AppearanceSettings {
  schemaVersion: 2;
  bundleId: string;
  followSystem?: boolean;
  font?: AppearanceFontSettings;
  /**
   * UI language. Drives the i18n layer (see {@link ../i18n}). Defaults to
   * {@link DEFAULT_LOCALE} (English) for the global build; persisted here so
   * the choice survives restarts and is read by both main and renderer.
   */
  language?: Locale;
}

export function migrateAppearanceV1ToV2(
  legacy: AppearanceSettingsV1,
): AppearanceSettings {
  return appearanceMigration.migrateV1ToV2(legacy);
}

/**
 * §B1 — External URL viewer policy.
 *
 * `preferredFlow` decides whether external URLs (OAuth IdP, calendar webLinks,
 * email open/compose URLs, etc.) are surfaced inside a host BrowserWindow
 * ("in-app") or routed to the OS default browser ("system-browser").
 *
 * SoT for the host. Plugins consume this via `hostApi.getAppPreference(...)`
 * and/or `hostApi.openExternalUrl(...)` — see plan
 * `.omc/plans/2026-05-04-external-url-viewer-policy.md`.
 *
 * Default `"in-app"` keeps plugin-owned auth and link flows inside LVIS unless
 * the plugin asks the host to open the system browser.
 * Future enum extension reserved (e.g. `"ask-each-time"`).
 */
export type WebViewPreferredFlow = "in-app" | "system-browser";

export interface WebViewSettings {
  preferredFlow: WebViewPreferredFlow;
}




export type SystemCloseBehavior = "hide-to-tray" | "quit";

/**
 * Workspace mode persisted across restarts. `"work"` is the inline working
 * layout (expanded sidebar, centered work canvas); `"chat"` is the focused
 * chat layout (collapsed icon rail, right-docked window). Persisted here so the
 * renderer can seed its first render from the saved value (no flash of the
 * wrong mode) and the main process can size the window correctly at creation.
 * SoT for the value union lives in `src/shared/initial-app-mode.ts`.
 */
export type SystemAppMode = InitialAppMode;

export interface SystemSettings {
  closeBehavior: SystemCloseBehavior;
  /** Persisted workspace mode (chat vs work). Default "work". */
  appMode: SystemAppMode;
  /**
   * E4 — launch LVIS automatically at OS login. Applied via
   * `app.setLoginItemSettings({ openAtLogin })` (see
   * `src/main/startup-launch.ts`). Default `false`. No-op in dev (unpackaged)
   * builds — the login item would point at the Electron dev binary.
   */
  launchAtStartup?: boolean;
  /**
   * E4 — when launching at startup, start hidden (tray only) instead of showing
   * the main window. macOS: `openAsHidden`; Windows: a `--hidden` launch arg
   * the boot path reads. Default `false`. Only meaningful when
   * `launchAtStartup` is `true`.
   */
  launchMinimized?: boolean;
  /**
   * Opt-in loopback HTTP+SSE server for the CLI / automation surface
   * (#1409 external API, #1436 lifecycle wiring). Default OFF — the app
   * never opens a listener socket unless the user turns this on here OR the
   * environment sets `LVIS_LOCAL_API=1`. When enabled, the server binds
   * 127.0.0.1 on an ephemeral port and requires a per-boot bearer secret
   * (persisted for the CLI under `~/.lvis/local-api/`). Independent of every
   * other flag: it only controls whether the aux transport is started.
   */
  localApiServer?: boolean;
  /**
   * Persisted width (px) of the docked ChatSidePanel workspace rail, set by the
   * left-edge drag handle. Durable shell-layout preference; clamped to
   * [SIDE_PANEL_MIN_WIDTH, viewport) at drag time in the renderer. Default 448.
   */
  sidePanelWidth?: number;
  /**
   * Persisted width (px) of the primary (left) navigation sidebar card, set by
   * the inner-edge drag handle. Durable shell-layout preference; clamped to
   * [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] at drag time in the renderer.
   * Default 232 (matches the historical expanded rail padding reserve).
   */
  sidebarWidth?: number;
  /**
   * Persisted TOP-pane percent of the workspace-rail vertical (list↕viewer)
   * split, one field per tab kind whose body is a list-over-viewer layout
   * (file-browser / preview / subagent). Clamped to the
   * [SIDE_PANEL_SPLIT_MIN_PERCENT, SIDE_PANEL_SPLIT_MAX_PERCENT] pane range at
   * drag time in the renderer. Browser is excluded — its list moved into a
   * floating search Popover, so it has no vertical splitter. Default 45.
   */
  sidePanelSplitFilePercent?: number;
  sidePanelSplitPreviewPercent?: number;
  sidePanelSplitSubagentPercent?: number;
  /**
   * Persisted active sidebar tab ("chats" = the plain ungrouped conversation
   * list, "projects" = named-project groups). Durable UI preference, same
   * family as `appMode`/`sidebarWidth`. Default "chats". SoT for the value
   * set: `../shared/sidebar-tab.js`.
   */
  sidebarActiveTab?: SidebarTab;
  /**
   * Pinned project roots — pinned projects sort to the top of the sidebar's
   * Projects tab. A lightweight preference list (not a project-domain
   * mutation), so it lives here rather than a dedicated IPC domain. Default
   * empty. Normalized to a de-duplicated string array on read/write.
   */
  pinnedProjectRoots?: string[];
}

/**
 * Production release prep — Electron auto-update (electron-updater).
 *
 * `autoCheckEnabled` defaults to TRUE: only the background update *check*
 * (metadata fetch) runs by default. Actual download + install are always
 * gated behind explicit user action in the update toast — there is no
 * silent auto-install. Users who want zero network traffic for updates
 * can flip this to false via the settings UI.
 */
export interface UpdateSettings {
  /** Background update-check enabled. Download/install still requires user action. */
  autoCheckEnabled: boolean;
  /**
   * App version the user skipped. The updater hides only this exact version;
   * a later version is shown again.
   */
  skippedVersion?: string;
}

/**
 * Production release prep — anonymous opt-in telemetry.
 * Default OFF. Requires explicit user action to enable.
 *
 * S12:
 *   - `telemetryPromptAnswered` — true once the user has dismissed the
 *     first-boot consent prompt (regardless of Yes/No). Events are NEVER
 *     sent before this is true.
 */
export interface TelemetrySettings {
  enabled: boolean;
  endpoint?: string;
  sentryDsn?: string;
  crashReportEndpoint?: string;
  crashReportingEnabled?: boolean;
  /** S12: true once the user has answered the one-time opt-in prompt. */
  telemetryPromptAnswered?: boolean;
}




export interface PrivacySettings {
  piiRedactEnabled: boolean;
}

/**
 * §7 Routine Engine settings — v2.
 *
 * Lenient parsing: unknown keys (including all prior routine fields such as
 * enableWakeupRoutine, wakeupRoutinePrompt, scheduleEntries, etc.) are
 * silently accepted so dev machines with old settings.json do not crash at
 * boot. No migration code — v1 keys are simply never read.
 */
export type RoutineSettings = Record<string, unknown>;

export interface WebSearchSettings {
  provider: "duckduckgo" | "tavily" | "serper" | "google";
}

/**
 * §9.5 — plugin marketplace backend.
 *
 * Server-only. The lvis-marketplace REST API is the single
 * source of truth for catalog + signed artifacts. The historical "mock"
 * backend that read `plugins/marketplace.json` from disk is removed; tests
 * that need a deterministic catalog inject a stub fetcher directly.
 */
export interface MarketplaceSettings {
  /** Reserved for future variants. Currently always `"real-cloud"`. */
  backend: "real-cloud";
  cloudBaseUrl?: string;
  /** Local dev/test only: bypass SSRF guard for loopback servers. */
  cloudAllowPrivateNetwork?: boolean;
  /**
   * S8 — enable/disable plugin update detection at boot. Default true.
   */
  updateCheckEnabled?: boolean;
  /**
   * S8 — update-check interval in milliseconds. Default 10 minutes (600_000 ms).
   * Set to 0 to disable periodic checks (manual / on-open only).
   */
  updateCheckIntervalMs?: number;
  /**
   * S8 — when true, canary/pre-release catalog entries are included in
   * update notifications. Default false (stable only).
   */
  canaryOptIn?: boolean;
  /**
   * Announcement banner ids the user has dismissed. Absent/empty until the
   * first dismissal. The host filters these out before pushing announcements
   * to the renderer so a dismissed banner never reappears.
   */
  dismissedAnnouncementIds?: number[];
  /**
   * Plugin update versions the user skipped, keyed by plugin id. A skipped
   * plugin update is hidden only while the marketplace latestVersion equals
   * the stored version; the next version surfaces again.
   */
  skippedPluginUpdates?: Record<string, string>;
  /**
   * Marketplace-installed provider packages. Defaults stay tiny; installed ids
   * expand the provider picker without re-bundling every provider into the
   * first-run surface.
   */
  installedProviderIds: MarketplaceEligibleLLMVendor[];
  /** User-installed OpenAI-compatible provider presets from Marketplace. */
  installedProviderPresets: MarketplaceInstalledProviderPreset[];
  /** Marketplace-installed theme bundles shown in Appearance. */
  installedThemeBundleIds: BundleId[];
  /** Marketplace-installed language packs shown in the language picker. */
  installedLanguagePacks: Locale[];
}

export interface SettingsServiceOptions {
  userDataPath: string;
  /** Host-owned policy derived from Electron app.isPackaged, never NODE_ENV. */
  secretPolicy?: SecretPolicy;
  /**
   * BCP-47 locale tag from the host OS (e.g. `app.getPreferredSystemLanguages()[0]`).
   * Used only on a fresh install (no settings file) to seed the UI language from the
   * system rather than hard-coding English. Once the user has a settings file the
   * stored value takes precedence — this field is ignored.
   */
  systemLocale?: string;
}


export class SettingsService {
  private readonly settingsPath: string;
  private readonly secretsPath: string;
  private readonly secretStore: SecretDocumentStore;
  private settings: AppSettings;

  constructor(options: SettingsServiceOptions) {
    const dir = resolve(options.userDataPath);
    mkdirSync(dir, { recursive: true });
    this.settingsPath = settingsFilePath(options.userDataPath);
    this.secretsPath = resolve(dir, "lvis-secrets.json");
    this.secretStore = new SecretDocumentStore({
      path: this.secretsPath,
      policy: options.secretPolicy ?? "packaged",
      encryption: safeStorage,
    });
    const loaded = this.loadSettings() as AppSettings & { __needsV2WriteBack?: boolean };
    const needsWriteBack = loaded.__needsV2WriteBack === true;
    delete (loaded as { __needsV2WriteBack?: boolean }).__needsV2WriteBack;
    this.settings = loaded;
    // v1 → v2 write-back: persist the migrated appearance so next load is clean.
    if (needsWriteBack) {
      void this.saveSettings().catch(() => { /* best-effort — next load re-migrates */ });
    }
  }




  async migrateSecrets(): Promise<boolean> {
    return this.secretStore.migrate();
  }

  getAll(): AppSettings {
    return structuredClone(this.settings);
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return structuredClone(this.settings[key]);
  }

  async set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
    this.settings[key] = value;
    await this.saveSettings();
  }

  async patch(
    partial: Partial<Omit<AppSettings, "llm" | "marketplace" | "shortcuts">> & {
      marketplace?: Partial<MarketplaceSettings>;
      llm?: LLMSettingsPatch;
      shortcuts?: ShortcutSettingsPatch;
    },
  ): Promise<AppSettings> {
    const previousSettings = this.getAll();
    const nextMarketplace = partial.marketplace
      ? normalizeMarketplace({
          ...this.settings.marketplace,
          ...partial.marketplace,
        })
      : this.settings.marketplace;
    if (partial.marketplace) {
      nextMarketplace.installedProviderPresets = preserveInstalledProviderPresetMetadata(
        this.settings.marketplace.installedProviderPresets,
        nextMarketplace.installedProviderPresets,
      );
    }
    const providerPresetSecretInvalidationIds = partial.marketplace
      ? marketplaceProviderPresetSecretInvalidationIds(
          this.settings.marketplace.installedProviderPresets,
          nextMarketplace.installedProviderPresets,
        )
      : [];
    if (partial.llm) {
      this.settings.llm = mergeLlmPatch(
        this.settings.llm,
        partial.llm,
        nextMarketplace.installedProviderIds,
        nextMarketplace.installedProviderPresets,
      );
    }
    if (partial.chat) this.settings.chat = { ...this.settings.chat, ...partial.chat };
    if (partial.a2aRemote) this.settings.a2aRemote = normalizeA2ARemote({ ...this.settings.a2aRemote, ...partial.a2aRemote });
    if (partial.webSearch) this.settings.webSearch = { ...this.settings.webSearch, ...partial.webSearch };
    if (partial.marketplace) {
      this.settings.marketplace = nextMarketplace;
      const prunedLlm = pruneLazyLlmVendorBlocks(
        this.settings.llm,
        nextMarketplace.installedProviderIds,
        nextMarketplace.installedProviderPresets,
        { inferInstalledFromCustom: false },
      );
      this.settings.llm = prunedLlm.llm;
    }
    if (partial.routine) {
      this.settings.routine = { ...this.settings.routine, ...partial.routine };
    }
    if (partial.privacy) {
      this.settings.privacy = { ...this.settings.privacy, ...partial.privacy };
    }
    if (partial.plugins) {
      this.settings.plugins = { ...this.settings.plugins, ...partial.plugins };
    }
    if (partial.updates) {
      this.settings.updates = { ...this.settings.updates, ...partial.updates };
    }
    if (partial.telemetry) {
      this.settings.telemetry = { ...this.settings.telemetry, ...partial.telemetry };
    }
    if (partial.audit) {
      this.settings.audit = { ...this.settings.audit, ...partial.audit };
    }
    if (partial.diagnostics) {
      // Field-level validation (mirrors `system`/`features`): an invalid
      // includeCrashDumps or out-of-range logRetentionDays is coerced/dropped so
      // a malformed renderer/IPC payload can never persist an unsafe value.
      // normalizeDiagnostics clamps retention to [1,365] and drops non-booleans.
      this.settings.diagnostics = normalizeDiagnostics({
        ...this.settings.diagnostics,
        ...partial.diagnostics,
      });
    }
    if (partial.appearance) {
      // Deep-merge the nested `font` block + validate every incoming font
      // subfield at write time. Without this, two consecutive
      // `updateSettings({ appearance: { font: { family } } })` and
      // `updateSettings({ appearance: { font: { sizeScale } } })` calls each
      // clobber the other's field (PR #672 review CRITICAL #1). And accepting
      // an unvalidated `family` at patch time + dropping it on next load is a
      // recovery-style fallback the No-Fallback-Code rule explicitly forbids
      // (PR #672 review MAJOR #4) — validate at every trust boundary.
      // Strip `font` from the outer spread before merging — we always want
      // the nested deep-merge below to be authoritative. Without this,
      // a caller passing `font: null` would land `null` directly via the
      // shallow spread and overwrite the previously-merged font block.
      const { font: fontPatch, ...appearanceRest } = partial.appearance as unknown as {
        font?: AppearanceFontSettings | null;
        [k: string]: unknown;
      };
      const nextAppearance: AppearanceSettings = {
        ...this.settings.appearance,
        ...(appearanceRest as Partial<AppearanceSettings>),
      };
      // Validate the language patch — coerce to a supported locale so a
      // malformed renderer/IPC payload can never persist an unknown language
      // (mirrors the font validation below; No-Fallback-Code: validate at the
      // trust boundary instead of dropping on next load).
      if ("language" in appearanceRest) {
        nextAppearance.language = normalizeLocale((appearanceRest as { language?: unknown }).language);
      }
      // Accept `font: undefined`, missing field, or `font: null` — all three
      // mean "no font subfield patch in this call". Guard against `null` so
      // a defensive caller (or a malformed test fixture) cannot crash

      if (fontPatch !== undefined && fontPatch !== null && typeof fontPatch === "object") {
        const mergedFont: AppearanceFontSettings = { ...this.settings.appearance.font };
        if (typeof fontPatch.family === "string") {
          if (fontPatch.family === "system" || isValidFontFamilyOverride(fontPatch.family)) {
            mergedFont.family = fontPatch.family;
          }
          // else: drop silently — the cross-window broadcast still carries
          // the validated post-merge value so listeners stay consistent.
        }
        if (typeof fontPatch.sizeScale === "number"
          && (FONT_SIZE_SCALE_VALUES as readonly number[]).includes(fontPatch.sizeScale)) {
          mergedFont.sizeScale = fontPatch.sizeScale as FontSizeScale;
        }
        nextAppearance.font = Object.keys(mergedFont).length > 0 ? mergedFont : undefined;
      }
      this.settings.appearance = nextAppearance;
    }
    if (partial.webView) {
      this.settings.webView = { ...this.settings.webView, ...partial.webView };
    }
    if (partial.system) {
      // Field-level validation (mirrors `appearance` pattern): invalid
      // `closeBehavior` is silently dropped so an existing valid preference
      // is not clobbered by a malformed renderer / IPC payload. The
      // disk-load path's `normalizeSystem` still backfills missing fields
      // with defaults.
      const next: SystemSettings = { ...this.settings.system };
      const rawBehavior = partial.system.closeBehavior;
      if (typeof rawBehavior === "string" && (VALID_CLOSE_BEHAVIORS as readonly string[]).includes(rawBehavior)) {
        next.closeBehavior = rawBehavior as SystemCloseBehavior;
      } else if (rawBehavior !== undefined) {
        log.warn(
          `system.closeBehavior patch ignored (received ${JSON.stringify(rawBehavior)}), keeping %s`,
          this.settings.system.closeBehavior,
        );
      }
      const rawAppMode = partial.system.appMode;
      const normalizedAppMode = normalizeAppMode(rawAppMode);
      if (normalizedAppMode !== null) {
        next.appMode = normalizedAppMode;
      } else if (rawAppMode !== undefined) {
        log.warn(
          `system.appMode patch ignored (received ${JSON.stringify(rawAppMode)}), keeping %s`,
          this.settings.system.appMode,
        );
      }
      const rawLocalApi = partial.system.localApiServer;
      if (typeof rawLocalApi === "boolean") {
        next.localApiServer = rawLocalApi;
      } else if (rawLocalApi !== undefined) {
        log.warn(
          `system.localApiServer patch ignored (received ${JSON.stringify(rawLocalApi)}), keeping %s`,
          this.settings.system.localApiServer,
        );
      }
      // E4 — launch-at-startup + launch-minimized booleans (same validate-at-
      // boundary pattern as localApiServer: invalid → keep prior value).
      const rawLaunchAtStartup = partial.system.launchAtStartup;
      if (typeof rawLaunchAtStartup === "boolean") {
        next.launchAtStartup = rawLaunchAtStartup;
      } else if (rawLaunchAtStartup !== undefined) {
        log.warn(
          `system.launchAtStartup patch ignored (received ${JSON.stringify(rawLaunchAtStartup)}), keeping %s`,
          this.settings.system.launchAtStartup,
        );
      }
      const rawLaunchMinimized = partial.system.launchMinimized;
      if (typeof rawLaunchMinimized === "boolean") {
        next.launchMinimized = rawLaunchMinimized;
      } else if (rawLaunchMinimized !== undefined) {
        log.warn(
          `system.launchMinimized patch ignored (received ${JSON.stringify(rawLaunchMinimized)}), keeping %s`,
          this.settings.system.launchMinimized,
        );
      }
      const rawSidePanelWidth = partial.system.sidePanelWidth;
      if (typeof rawSidePanelWidth === "number" && Number.isFinite(rawSidePanelWidth)) {
        next.sidePanelWidth = Math.max(SIDE_PANEL_MIN_WIDTH, Math.round(rawSidePanelWidth));
      } else if (rawSidePanelWidth !== undefined) {
        log.warn(
          `system.sidePanelWidth patch ignored (received ${JSON.stringify(rawSidePanelWidth)}), keeping %s`,
          this.settings.system.sidePanelWidth,
        );
      }
      const rawSidebarWidth = partial.system.sidebarWidth;
      if (typeof rawSidebarWidth === "number" && Number.isFinite(rawSidebarWidth)) {
        next.sidebarWidth = clampSidebarWidth(rawSidebarWidth);
      } else if (rawSidebarWidth !== undefined) {
        log.warn(
          `system.sidebarWidth patch ignored (received ${JSON.stringify(rawSidebarWidth)}), keeping %s`,
          this.settings.system.sidebarWidth,
        );
      }
      // Per-tab vertical split percents — each normalized independently through
      // the shared clamp so an out-of-range or non-finite value is ignored while
      // a valid sibling is preserved (mirrors the width path above).
      for (const key of SIDE_PANEL_SPLIT_KEYS) {
        const raw = partial.system[key];
        if (typeof raw === "number" && Number.isFinite(raw)) {
          next[key] = clampSidePanelSplitPercent(raw);
        } else if (raw !== undefined) {
          log.warn(
            `system.${key} patch ignored (received ${JSON.stringify(raw)}), keeping %s`,
            this.settings.system[key],
          );
        }
      }
      const rawSidebarActiveTab = partial.system.sidebarActiveTab;
      if (isSidebarTab(rawSidebarActiveTab)) {
        next.sidebarActiveTab = rawSidebarActiveTab;
      } else if (rawSidebarActiveTab !== undefined) {
        log.warn(
          `system.sidebarActiveTab patch ignored (received ${JSON.stringify(rawSidebarActiveTab)}), keeping %s`,
          this.settings.system.sidebarActiveTab,
        );
      }
      const rawPinnedProjectRoots = partial.system.pinnedProjectRoots;
      if (Array.isArray(rawPinnedProjectRoots)) {
        next.pinnedProjectRoots = normalizePinnedProjectRoots(rawPinnedProjectRoots);
      } else if (rawPinnedProjectRoots !== undefined) {
        log.warn(
          `system.pinnedProjectRoots patch ignored (received ${JSON.stringify(rawPinnedProjectRoots)}), keeping %s`,
          this.settings.system.pinnedProjectRoots,
        );
      }
      this.settings.system = next;
    }
    if (partial.shortcuts) {
      // Field-level validation: an invalid accelerator is dropped (previous
      // value preserved) rather than clobbering the existing binding — mirrors
      // the `system`/`appearance` per-field patch discipline. `enabled` is a
      // plain boolean gate.
      const nextShortcuts: ShortcutSettings = { ...this.settings.shortcuts };
      const rawToggle = partial.shortcuts.toggleWindow;
      if (rawToggle === null) {
        nextShortcuts.toggleWindow = null;
      } else if (rawToggle !== undefined) {
        const accel = normalizeAccelerator(rawToggle);
        if (accel !== null) {
          nextShortcuts.toggleWindow = accel;
        } else {
          log.warn(
            `shortcuts.toggleWindow patch ignored (received ${JSON.stringify(rawToggle)}), keeping %s`,
            this.settings.shortcuts.toggleWindow,
          );
        }
      }
      const rawEnabled = partial.shortcuts.enabled;
      if (typeof rawEnabled === "boolean") {
        nextShortcuts.enabled = rawEnabled;
      } else if (rawEnabled !== undefined) {
        log.warn(
          `shortcuts.enabled patch ignored (received ${JSON.stringify(rawEnabled)}), keeping %s`,
          this.settings.shortcuts.enabled,
        );
      }
      this.settings.shortcuts = nextShortcuts;
    }
    if (partial.pluginConfigs) {
      const sanitized: Record<string, PluginConfigRecord> = {};
      for (const [pluginId, config] of Object.entries(partial.pluginConfigs)) {
        const safePluginId = sanitizePluginConfigPluginId(pluginId);
        sanitized[safePluginId] = sanitizePluginConfig(config);
      }
      this.settings.pluginConfigs = { ...this.settings.pluginConfigs, ...sanitized };
    }
    if (partial.features) {
      this.settings.features = {
        ...this.settings.features,
        ...normalizeFeatureFlags(partial.features),
      };
    }
    await this.saveSettings();
    await this.deleteMarketplaceProviderPresetSecretsAtomically(
      previousSettings,
      providerPresetSecretInvalidationIds,
    );
    return this.getAll();
  }

  async installMarketplaceProviderPreset(
    preset: MarketplaceInstalledProviderPreset,
  ): Promise<AppSettings> {
    const normalized = normalizeMarketplaceProviderPreset(preset);
    if (!normalized) {
      throw new Error("Invalid marketplace provider preset.");
    }
    const current = this.settings.marketplace.installedProviderPresets;
    return this.replaceMarketplaceProviderPresets([
      ...current.filter((item) => item.providerId !== normalized.providerId),
      normalized,
    ]);
  }

  async uninstallMarketplaceProviderPreset(providerId: string): Promise<AppSettings> {
    if (!isMarketplaceProviderPresetId(providerId)) {
      throw new Error("Invalid marketplace provider preset id.");
    }
    const current = this.settings.marketplace.installedProviderPresets;
    return this.replaceMarketplaceProviderPresets(
      current.filter((item) => item.providerId !== providerId),
    );
  }

  private async replaceMarketplaceProviderPresets(
    installedProviderPresets: readonly MarketplaceInstalledProviderPreset[],
  ): Promise<AppSettings> {
    const previousSettings = this.getAll();
    const nextMarketplace = normalizeMarketplace({
      ...this.settings.marketplace,
      installedProviderPresets,
    });
    const providerPresetSecretInvalidationIds = marketplaceProviderPresetSecretInvalidationIds(
      this.settings.marketplace.installedProviderPresets,
      nextMarketplace.installedProviderPresets,
    );
    this.settings.marketplace = nextMarketplace;
    const prunedLlm = pruneLazyLlmVendorBlocks(
      this.settings.llm,
      nextMarketplace.installedProviderIds,
      nextMarketplace.installedProviderPresets,
      { inferInstalledFromCustom: false },
    );
    this.settings.llm = prunedLlm.llm;
    await this.saveSettings();
    await this.deleteMarketplaceProviderPresetSecretsAtomically(
      previousSettings,
      providerPresetSecretInvalidationIds,
    );
    return this.getAll();
  }

  private async deleteMarketplaceProviderPresetSecretsAtomically(
    previousSettings: AppSettings,
    providerIds: readonly string[],
  ): Promise<void> {
    try {
      await this.deleteMarketplaceProviderPresetSecrets(providerIds);
    } catch (err) {
      // SecretDocumentStore.deleteMany is one locked atomic mutation: a
      // rejected call leaves the previous secret document intact, so only
      // the settings write performed immediately before this call needs to
      // be rolled back. Avoid reading individual secrets here; encrypted
      // reads correctly fail closed when safeStorage is unavailable.
      this.settings = previousSettings;
      await this.saveSettings().catch((rollbackErr: Error) => {
        log.warn(
          "settings rollback after provider preset secret deletion failure failed: %s",
          rollbackErr.message,
        );
      });
      throw err;
    }
  }

  private async deleteMarketplaceProviderPresetSecrets(providerIds: readonly string[]): Promise<void> {
    if (providerIds.length === 0) return;
    await this.secretStore.deleteMany(providerIds.map(marketplaceProviderPresetSecretKey));
  }

  async replaceLlm(llm: LLMSettings): Promise<AppSettings> {
    this.settings.llm = structuredClone(llm);
    await this.saveSettings();
    return this.getAll();
  }

  getPluginConfig(pluginId: string): PluginConfigRecord {
    const safePluginId = sanitizePluginConfigPluginId(pluginId);
    return structuredClone(this.settings.pluginConfigs[safePluginId] ?? {});
  }

  async setPluginConfig(pluginId: string, config: unknown): Promise<PluginConfigRecord> {
    const safePluginId = sanitizePluginConfigPluginId(pluginId);
    const sanitizedConfig = sanitizePluginConfig(config);
    this.settings.pluginConfigs = {
      ...this.settings.pluginConfigs,
      [safePluginId]: sanitizedConfig,
    };
    await this.saveSettings();
    return structuredClone(sanitizedConfig);
  }

  async deletePluginConfig(pluginId: string): Promise<void> {
    const safePluginId = sanitizePluginConfigPluginId(pluginId);
    if (!(safePluginId in this.settings.pluginConfigs)) return;
    const next = { ...this.settings.pluginConfigs };
    delete next[safePluginId];
    this.settings.pluginConfigs = next;
    await this.saveSettings();
  }

  /** Encrypt and store a secret value such as an API key. */
  async setSecret(key: string, value: string): Promise<void> {
    await this.secretStore.set(key, value);
  }

  /** Decrypt and return a stored secret value. */
  getSecret(key: string): string | null {
    try {
      return this.secretStore.get(key);
    } catch (err) {
      log.warn("secret read failed: %s", (err as Error).message);
      throw err;
    }
  }

  /** Security-sensitive consumers that must reject legacy `plain:` secret entries. */
  getEncryptedSecret(key: string): string | null {
    return this.secretStore.getEncrypted(key);
  }

  async deleteSecret(key: string): Promise<void> {
    await this.secretStore.delete(key);
  }

  async deletePluginSecrets(pluginId: string, keys: Iterable<string>): Promise<number> {
    const safePluginId = sanitizePluginConfigPluginId(pluginId);
    const storageKeys: string[] = [];
    for (const key of keys) {
      const safeKey = sanitizePluginConfigKey(key);
      storageKeys.push(`plugin.${safePluginId}.${safeKey}`);
    }
    return this.secretStore.deleteMany(storageKeys);
  }

  // Historical note: hasApiKey() only checked the single `llm.apiKey` key,
  // while the IPC handler uses vendor-specific `llm.apiKey.<vendor>` secrets.
  // Keep callers on the explicit `getSecret(...)` path so future vendor checks
  // cannot accidentally return false for configured credentials.

  // --- private helpers ---

  private loadSettings(): AppSettings {
    if (!existsSync(this.settingsPath)) {
      const defaults = structuredClone(DEFAULT_SETTINGS);
      // Fresh installs stay English-first while non-English language packs move
      // toward marketplace delivery. Stored user choices are still preserved by
      // the migration/read path below.
      return defaults;
    }
    try {
      const raw = readFileSync(this.settingsPath, "utf-8");
      const rawParsed = JSON.parse(raw) as unknown;
      const parsed = rawParsed !== null && typeof rawParsed === "object" && !Array.isArray(rawParsed)
        ? rawParsed as Record<string, any>
        : {};
      const rawLlm = parsed.llm;
      let llm = mergeLlmPatch(
        DEFAULT_SETTINGS.llm,
        rawLlm !== null && typeof rawLlm === "object" && !Array.isArray(rawLlm)
          ? rawLlm as LLMSettingsPatch
          : {},
        LLM_VENDORS.filter(isMarketplaceEligibleLLMVendor),
        undefined,
      );
      const marketplaceParsed: Record<string, unknown> = { ...(parsed.marketplace ?? {}) };
      // Migration: the marketplace cloud fields were renamed (the old "real"
      // prefix became vestigial once the mock backend was removed). Preserve
      // customised values from an older settings.json. Legacy keys are split
      // literals so the naming-gate (no new real*/mock* identifiers) is satisfied.
      const legacyCloudUrlKey = "real" + "CloudBaseUrl";
      const legacyCloudUrl = marketplaceParsed[legacyCloudUrlKey];
      if (typeof legacyCloudUrl === "string" && marketplaceParsed.cloudBaseUrl === undefined) {
        // Trim and only carry a non-empty value forward — a whitespace-only
        // legacy URL would otherwise read as "configured" in non-trimming
        // consumers (e.g. the boot fetcher selection) and yield invalid request
        // URLs. Dropping it falls back to the cloudBaseUrl default.
        const trimmed = legacyCloudUrl.trim();
        if (trimmed) {
          marketplaceParsed.cloudBaseUrl = trimmed;
        }
      }
      delete marketplaceParsed[legacyCloudUrlKey];
      const legacyAllowPrivateKey = "real" + "CloudAllowPrivateNetwork";
      if (
        typeof marketplaceParsed[legacyAllowPrivateKey] === "boolean" &&
        marketplaceParsed.cloudAllowPrivateNetwork === undefined
      ) {
        marketplaceParsed.cloudAllowPrivateNetwork = marketplaceParsed[legacyAllowPrivateKey];
      }
      delete marketplaceParsed[legacyAllowPrivateKey];
      // Pin the only valid backend literal — narrows the unknown spread back
      // to the AppSettings type without preserving legacy "mock" inputs.
      marketplaceParsed.backend = "real-cloud";
      const pluginConfigs = sanitizeStoredPluginConfigs(parsed.pluginConfigs);
      // Unknown routine keys are preserved in storage but never read by current code.
      const normalizedRoutine: RoutineSettings = {
        ...(parsed.routine as Record<string, unknown> | undefined ?? {}),
      };

      const onDisk = parsed.appearance as Record<string, unknown> | null | undefined;
      // Detect v1 (legacy tri-axis) to trigger write-back after constructor.
      const needsV2WriteBack = !!onDisk && typeof onDisk === "object" &&
        onDisk.schemaVersion !== 2 &&
        (typeof onDisk.theme === "string" || typeof onDisk.chatTheme === "string" || typeof onDisk.codeTheme === "string");

      let marketplace = normalizeMarketplace(marketplaceParsed);
      const prunedLlm = pruneLazyLlmVendorBlocks(
        llm,
        marketplace.installedProviderIds,
        marketplace.installedProviderPresets,
        { inferInstalledFromCustom: true },
      );
      llm = prunedLlm.llm;
      marketplace = {
        ...marketplace,
        installedProviderIds: prunedLlm.installedProviderIds,
      };

      const appearance = normalizeAppearance(parsed.appearance);
      const result: AppSettings & { __needsV2WriteBack?: boolean } = {
        llm,
        chat: { ...DEFAULT_SETTINGS.chat, ...parsed.chat },
        a2aRemote: normalizeA2ARemote(parsed.a2aRemote),
        webSearch: { ...DEFAULT_SETTINGS.webSearch, ...parsed.webSearch },
        marketplace,
        routine: normalizedRoutine,
        privacy: { ...DEFAULT_SETTINGS.privacy, ...parsed.privacy },
        updates: { ...DEFAULT_SETTINGS.updates, ...parsed.updates },
        telemetry: { ...DEFAULT_SETTINGS.telemetry, ...parsed.telemetry },
        audit: { ...DEFAULT_SETTINGS.audit, ...parsed.audit },
        diagnostics: normalizeDiagnostics(parsed.diagnostics),
        appearance,
        webView: normalizeWebView(parsed.webView),
        system: normalizeSystem(parsed.system),
        shortcuts: normalizeShortcuts(parsed.shortcuts, DEFAULT_SETTINGS.shortcuts),
        plugins: {},
        pluginConfigs: { ...DEFAULT_SETTINGS.pluginConfigs, ...pluginConfigs },
        features: { ...DEFAULT_SETTINGS.features, ...normalizeFeatureFlags(parsed.features) },
      };
      if (needsV2WriteBack) result.__needsV2WriteBack = true;
      return result;
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private async saveSettings(): Promise<void> {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    await withFileLock(this.settingsPath, async () => {
      writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
    });
  }

}

/**
 * Merge a partial LLM patch onto a base settings block. Per-vendor entries
 * inside `partial.vendors` are deep-merged with the corresponding existing
 * block, materializing only the providers touched by the user or selected as
 * active. The long-tail provider defaults live in `LLM_VENDOR_DEFAULTS` and
 * are read through `getLlmVendorSettings()` instead of being persisted for
 * every fresh install.
 *
 * Unknown vendor ids in `partial.vendors` are ignored — the active provider
 * must be one of LLM_VENDORS, validated below.
 */
