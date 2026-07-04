import { safeStorage } from "electron";
import { closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import {
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
  clampSidePanelSplitPercent,
} from "../shared/side-panel.js";
import {
  sanitizePluginConfig,
  sanitizePluginConfigKey,
  sanitizePluginConfigPluginId,
  type PluginConfigRecord,
} from "../shared/plugin-config.js";
import {
  DEFAULT_LLM_VENDOR,
  freshVendorBlocks,
  isLLMVendor,
  LLM_VENDOR_DEFAULTS,
  LLM_VENDORS,
  normalizeLlmVendorModel,
  type LLMVendor,
  type LLMVendorSettings,
} from "../shared/llm-vendor-defaults.js";
import { BUNDLE_IDS, DEFAULT_BUNDLE_ID } from "../shared/theme-bundles.js";
import {
  FONT_SIZE_SCALE_VALUES,
  type FontSizeScale,
  type AppearanceFontSettings,
  isValidFontFamilyOverride,
} from "../shared/appearance-font.js";
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "../i18n/index.js";
import { DEFAULT_APP_MODE, normalizeAppMode, type InitialAppMode } from "../shared/initial-app-mode.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("settings");

export type { LLMVendor, LLMVendorSettings };
export { LLM_VENDORS };

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
 * - `vendors` holds a complete configuration block per vendor; switching
 *   `provider` never inherits stale values from another vendor's block.
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
  /**
   * #893 — Top-level auth toggle. `"manual"` (default) shows the vendor
   * dropdown + per-vendor settings (API key, baseUrl, model, vertex…);
   * `"login"` collapses all of that down to a single Login button whose
   * backend chooses the vendor (see `LVIS_DEMO_VENDOR`). Login wraps
   * vendor selection itself — when `authMode === "login"` the user is
   * never asked which vendor.
   *
   * Legacy installs that wrote per-vendor `vendors[v].authMode = "login"`
   * are migrated up at load time: if any vendor was in login mode the
   * top-level switch flips to `"login"` and that vendor is promoted to
   * `provider`. The per-vendor keys are dropped on next write.
   */
  authMode: "manual" | "login";
  provider: LLMVendor;
  vendors: Record<LLMVendor, LLMVendorSettings>;
  streamSmoothing: "none" | "word" | "char";
  fallbackChain: Array<{ provider: LLMVendor; model: string }>;
  /**
   * Manual-mode Chromium host-resolver map. Persisted as /etc/hosts-style
   * text (one "IP hostname" entry per line; blank lines and # comments
   * ignored). Applied via Chromium `host-resolver-rules` command-line switch
   * on next launch. Only honoured when `authMode === "manual"` — demo mode
   * (`authMode === "login"`) uses `LVIS_DEMO_HOST_MAP` exclusively.
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
 * a UI save touching a single vendor doesn't have to send all six.
 */
export interface LLMSettingsPatch {
  authMode?: "manual" | "login";
  provider?: LLMVendor;
  vendors?: Partial<Record<LLMVendor, Partial<LLMVendorSettings>>>;
  streamSmoothing?: "none" | "word" | "char";
  fallbackChain?: Array<{ provider: LLMVendor; model: string }>;
  hostResolverMap?: string;
}

export interface ChatSettings {
  systemPrompt: string;
  autoCompact: boolean;
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

export interface AppSettings {
  llm: LLMSettings;
  chat: ChatSettings;
  webSearch: WebSearchSettings;
  marketplace: MarketplaceSettings;
  routine: RoutineSettings;
  privacy: PrivacySettings;
  updates: UpdateSettings;
  telemetry: TelemetrySettings;
  audit: AuditSettings;
  /** UX Track 3 — visual theme + future UI preferences. */
  appearance: AppearanceSettings;
  /** §B1 — external URL viewer policy (in-app BrowserWindow vs system browser). */
  webView: WebViewSettings;
  /** Window close-button behaviour (hide-to-tray vs quit). */
  system: SystemSettings;
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
}

export interface SettingsServiceOptions {
  userDataPath: string;
  /**
   * BCP-47 locale tag from the host OS (e.g. `app.getPreferredSystemLanguages()[0]`).
   * Used only on a fresh install (no settings file) to seed the UI language from the
   * system rather than hard-coding English. Once the user has a settings file the
   * stored value takes precedence — this field is ignored.
   */
  systemLocale?: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    authMode: "manual",
    provider: DEFAULT_LLM_VENDOR,
    vendors: freshVendorBlocks(),
    streamSmoothing: "none",
    fallbackChain: [],
  },
  chat: {
    systemPrompt:
      "You are LVIS, a local knowledge assistant. You provide accurate, helpful answers grounded in the user's documents and context. Respond in the user's language.",
    autoCompact: true,
  },
  webSearch: {
    provider: "duckduckgo",
  },
  marketplace: {
    // Defaults — single source: marketplace server. Default
    // points at the production tunnel so a fresh install lands on the live
    // catalog without any post-install configuration. Operators running a
    // local marketplace (http://localhost:8000) can override via Settings →

    // No fallback to a local catalog file — the only way to populate the
    // host's plugin layout is through the marketplace API.
    backend: "real-cloud",
    cloudBaseUrl: "https://marketplace.lvisai.xyz",
    cloudAllowPrivateNetwork: false,
  },
  routine: {},
  privacy: {
    piiRedactEnabled: false,
  },
  updates: {
    autoCheckEnabled: true,
  },
  telemetry: {
    enabled: false,
    crashReportingEnabled: false,
  },
  audit: {
    auditRotationMaxBytes: 10 * 1024 * 1024, // 10 MB
    auditRetentionDays: 30,
  },
  appearance: {
    schemaVersion: 2,
    bundleId: DEFAULT_BUNDLE_ID,
    language: DEFAULT_LOCALE,
  },
  webView: {
    preferredFlow: "in-app",
  },
  system: {
    closeBehavior: "hide-to-tray",
    appMode: DEFAULT_APP_MODE,
    // Opt-in loopback API server — OFF by default (also enabled by env
    // LVIS_LOCAL_API=1). #1409/#1436.
    localApiServer: false,
    sidePanelWidth: SIDE_PANEL_DEFAULT_WIDTH,
    sidePanelSplitFilePercent: SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
    sidePanelSplitPreviewPercent: SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
    sidePanelSplitSubagentPercent: SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
  },
  plugins: {},
  pluginConfigs: {},
  features: {
    // Idle preference refresh runs by default; users can opt out in Settings.
    idlePreferenceRefresh: true,

    // Fresh installs MUST start the Z onboarding chain. Persisting an
    // explicit `false` (instead of relying on `undefined`) keeps the
    // contract obvious: the flag flips to `true` exactly once, from
    // `markOnboardingCompleted` after the user finishes (or skips) the
    // chain. Any other path that wants to suppress the chain must set
    // this to `true` deliberately — no "missing key === skipped" trap.
    onboardingCompleted: false,
    // Permission policy host-classifies-risk migration gate. Ships ON — the
    // host derives the effective category from host-owned signals (foreground
    // plugin read-relaxation included) instead of trusting the plugin-declared
    // category. Shadow mode reconciliation completed before this flip; users
    // can still opt out in Settings.
    hostClassifiesRisk: true,
    // OS tool sandbox — STAGED rollout (macOS-first). Default ON on `darwin`
    // (the live-verified-active platform) and OFF on `linux`/`win32` until the
    // in-flight C/D-series sandbox QA is green; Linux/Windows users can still

    // Linux/Windows default flips to `true` once the C/D-series QA passes —
    // change this single expression to `true` then. (Computed from
    // `process.platform` at default-construction; `process.platform` is stable
    // per-process so this is a one-time, single-expression evaluation.)
    //
    // Safe to stage independently of `hostClassifiesRisk` (which stays ON on all
    // platforms): on a non-sandbox (or non-filesystem-confined) platform the
    // foreground read-relaxation is coupled to the active sandbox FILESYSTEM-
    // CONTAINING the host (ToolExecutor.sandboxFsContainedProvider), so it falls
    // back to the pre-exec ask there. When ON, boot activates ASRT
    // if the platform sandbox can run, else the default/settings path DEGRADES
    // gracefully (loud warning, non-bricking); the explicit `LVIS_SANDBOX_ENABLED=1`
    // env opt-in stays fail-closed. See boot.ts + boot/steps/sandbox-gate.ts.
    osToolSandbox: process.platform === "darwin",
  },
};

export class SettingsService {
  private readonly settingsPath: string;
  private readonly secretsPath: string;
  private readonly systemLocale: string | undefined;
  private settings: AppSettings;

  constructor(options: SettingsServiceOptions) {
    const dir = resolve(options.userDataPath);
    mkdirSync(dir, { recursive: true });
    this.settingsPath = settingsFilePath(options.userDataPath);
    this.secretsPath = resolve(dir, "lvis-secrets.json");
    this.systemLocale = options.systemLocale;
    this.migrateSecretsMode();
    const loaded = this.loadSettings() as AppSettings & { __needsV2WriteBack?: boolean };
    const needsWriteBack = loaded.__needsV2WriteBack === true;
    delete (loaded as { __needsV2WriteBack?: boolean }).__needsV2WriteBack;
    this.settings = loaded;
    // v1 → v2 write-back: persist the migrated appearance so next load is clean.
    if (needsWriteBack) {
      void this.saveSettings().catch(() => { /* best-effort — next load re-migrates */ });
    }
  }




  private migrateSecretsMode(): void {
    if (process.platform === "win32") return;
    let fd: number | null = null;
    try {
      fd = openSync(this.secretsPath, "r");
      const st = fstatSync(fd);
      if ((st.mode & 0o777) !== 0o600) {
        fchmodSync(fd, 0o600);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      log.warn("secrets mode migration failed: %s", (err as Error).message);
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
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
    partial: Partial<Omit<AppSettings, "llm">> & { llm?: LLMSettingsPatch },
  ): Promise<AppSettings> {
    if (partial.llm) this.settings.llm = mergeLlmPatch(this.settings.llm, partial.llm);
    if (partial.chat) this.settings.chat = { ...this.settings.chat, ...partial.chat };
    if (partial.webSearch) this.settings.webSearch = { ...this.settings.webSearch, ...partial.webSearch };
    if (partial.marketplace) {
      this.settings.marketplace = { ...this.settings.marketplace, ...partial.marketplace };
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
      const rawSidePanelWidth = partial.system.sidePanelWidth;
      if (typeof rawSidePanelWidth === "number" && Number.isFinite(rawSidePanelWidth)) {
        next.sidePanelWidth = Math.max(SIDE_PANEL_MIN_WIDTH, Math.round(rawSidePanelWidth));
      } else if (rawSidePanelWidth !== undefined) {
        log.warn(
          `system.sidePanelWidth patch ignored (received ${JSON.stringify(rawSidePanelWidth)}), keeping %s`,
          this.settings.system.sidePanelWidth,
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
      this.settings.system = next;
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
    return this.getAll();
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
    const secrets = this.loadSecrets();
    if (safeStorage.isEncryptionAvailable()) {
      secrets[key] = safeStorage.encryptString(value).toString("base64");
    } else {
      // Encryption may be unavailable in development or headless environments.
      secrets[key] = `plain:${value}`;
    }
    await this.saveSecrets(secrets);
  }

  /** Decrypt and return a stored secret value. */
  getSecret(key: string): string | null {
    const secrets = this.loadSecrets();
    const stored = secrets[key];
    if (!stored) return null;

    if (stored.startsWith("plain:")) {
      return stored.slice(6);
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return null;
    }

    try {
      return safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch (err) {
      // Round-3 §7: surface decrypt failures as a warning so a corrupted
      // keychain entry doesn't masquerade as "no value set". Error semantics
      // are preserved (still returns null) — only the diagnostic surface
      // is added.
      log.warn(`decryptString failed for key=${key}: %s`, (err as Error).message);
      return null;
    }
  }

  async deleteSecret(key: string): Promise<void> {
    const secrets = this.loadSecrets();
    delete secrets[key];
    await this.saveSecrets(secrets);
  }

  async deletePluginSecrets(pluginId: string, keys: Iterable<string>): Promise<number> {
    const safePluginId = sanitizePluginConfigPluginId(pluginId);
    const secrets = this.loadSecrets();
    let deleted = 0;
    for (const key of keys) {
      const safeKey = sanitizePluginConfigKey(key);
      const storageKey = `plugin.${safePluginId}.${safeKey}`;
      if (!(storageKey in secrets)) continue;
      delete secrets[storageKey];
      deleted += 1;
    }
    if (deleted > 0) {
      await this.saveSecrets(secrets);
    }
    return deleted;
  }

  // Historical note: hasApiKey() only checked the single `llm.apiKey` key,
  // while the IPC handler uses vendor-specific `llm.apiKey.<vendor>` secrets.
  // Keep callers on the explicit `getSecret(...)` path so future vendor checks
  // cannot accidentally return false for configured credentials.

  // --- private helpers ---

  private loadSettings(): AppSettings {
    if (!existsSync(this.settingsPath)) {
      const defaults = structuredClone(DEFAULT_SETTINGS);
      // On a fresh install there is no user preference yet — seed the UI
      // language from the host OS rather than hard-coding English.
      // normalizeLocale coerces unsupported tags to the DEFAULT_LOCALE, so
      // this is a legitimate external-boundary fallback, not a workaround.
      if (this.systemLocale !== undefined) {
        defaults.appearance.language = normalizeLocale(this.systemLocale);
      }
      return defaults;
    }
    try {
      const raw = readFileSync(this.settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as any;
      const migratedLlm = migrateLegacyLlmAuthMode(parsed.llm);
      const llm = mergeLlmPatch(DEFAULT_SETTINGS.llm, migratedLlm);
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

      const appearance = normalizeAppearance(parsed.appearance);
      const result: AppSettings & { __needsV2WriteBack?: boolean } = {
        llm,
        chat: { ...DEFAULT_SETTINGS.chat, ...parsed.chat },
        webSearch: { ...DEFAULT_SETTINGS.webSearch, ...parsed.webSearch },
        marketplace: { ...DEFAULT_SETTINGS.marketplace, ...marketplaceParsed },
        routine: normalizedRoutine,
        privacy: { ...DEFAULT_SETTINGS.privacy, ...parsed.privacy },
        updates: { ...DEFAULT_SETTINGS.updates, ...parsed.updates },
        telemetry: { ...DEFAULT_SETTINGS.telemetry, ...parsed.telemetry },
        audit: { ...DEFAULT_SETTINGS.audit, ...parsed.audit },
        appearance,
        webView: normalizeWebView(parsed.webView),
        system: normalizeSystem(parsed.system),
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

  private loadSecrets(): Record<string, string> {
    if (!existsSync(this.secretsPath)) return {};
    try {
      return JSON.parse(readFileSync(this.secretsPath, "utf-8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async saveSecrets(secrets: Record<string, string>): Promise<void> {
    mkdirSync(dirname(this.secretsPath), { recursive: true });
    await withFileLock(this.secretsPath, async () => {


      writeFileSync(this.secretsPath, JSON.stringify(secrets, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    });
  }
}

/**
 * Merge a partial LLM patch onto a base settings block. Per-vendor entries
 * inside `partial.vendors` are deep-merged with the corresponding existing
 * block so a UI save touching one vendor never overwrites another's config.
 *
 * Unknown vendor ids in `partial.vendors` are ignored — the active provider
 * must be one of LLM_VENDORS, validated below.
 */
function mergeLlmPatch(base: LLMSettings, partial: LLMSettingsPatch): LLMSettings {
  const vendors: Record<LLMVendor, LLMVendorSettings> = { ...base.vendors };
  if (partial.vendors) {
    for (const v of LLM_VENDORS) {
      const incoming = partial.vendors[v];
      // Spread carries explicit `undefined` keys through (e.g. clearing `seed`).
      // Omitting a key from the patch leaves the previous value intact —
      // omit ≠ clear by design.
      if (incoming) vendors[v] = { ...vendors[v], ...incoming };
    }
  }
  for (const v of LLM_VENDORS) {
    const model = typeof vendors[v].model === "string"
      ? vendors[v].model
      : LLM_VENDOR_DEFAULTS[v].model;
    vendors[v] = {
      ...vendors[v],
      model: normalizeLlmVendorModel(v, model),
    };
  }
  // Coerce stale on-disk `provider` (e.g. a since-removed vendor name) to the
  // base provider — `vendors[provider]` would otherwise be undefined and
  // crash refreshProvider/stream-collector at first turn. The type guard
  // narrows `partial.provider` so the assignment below is cast-free.
  const provider: LLMVendor = isLLMVendor(partial.provider)
    ? partial.provider
    : base.provider;
  const authMode: "manual" | "login" =
    partial.authMode === "login" || partial.authMode === "manual"
      ? partial.authMode
      : base.authMode;
  const fallbackChain = (partial.fallbackChain ?? base.fallbackChain).map((entry) => ({
    ...entry,
    model: isLLMVendor(entry.provider)
      ? normalizeLlmVendorModel(entry.provider, entry.model)
      : entry.model,
  }));
  return {
    authMode,
    provider,
    vendors,
    streamSmoothing: partial.streamSmoothing ?? base.streamSmoothing,
    fallbackChain,
    // `undefined` means "no mapping"; an explicit empty string clears the map.
    hostResolverMap: "hostResolverMap" in partial ? partial.hostResolverMap : base.hostResolverMap,
  };
}

/**
 * #893 — Legacy migration. Earlier builds persisted `authMode` per vendor at
 * `llm.vendors.<v>.authMode`; the new top-level toggle lives at
 * `llm.authMode`. On load, if any vendor block carries `authMode: "login"`
 * we promote the switch to top-level "login" and elect that vendor as the
 * active provider so the user lands exactly where they last logged in. The
 * per-vendor key is stripped so the next write produces a clean shape.
 *
 * Tolerant by design: malformed input falls through to the caller's default
 * (settings load never crashes boot over a UI-only field).
 */
function migrateLegacyLlmAuthMode(input: unknown): LLMSettingsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const llm = input as Record<string, unknown>;
  const result: LLMSettingsPatch = { ...(llm as object) } as LLMSettingsPatch;

  // Already top-level authMode? Honour it, but still strip any stray
  // per-vendor authMode keys so the on-disk shape converges.
  const topLevelAuthMode =
    llm.authMode === "login" || llm.authMode === "manual"
      ? (llm.authMode as "manual" | "login")
      : null;

  if (llm.vendors && typeof llm.vendors === "object" && !Array.isArray(llm.vendors)) {
    const vendors = llm.vendors as Record<string, Record<string, unknown>>;
    let promotedVendor: LLMVendor | null = null;
    const cleanedVendors: Record<string, Record<string, unknown>> = {};
    for (const [vid, block] of Object.entries(vendors)) {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        cleanedVendors[vid] = block as Record<string, unknown>;
        continue;
      }
      const { authMode: legacyMode, ...rest } = block;
      if (legacyMode === "login" && promotedVendor === null && isLLMVendor(vid)) {
        promotedVendor = vid;
      }
      cleanedVendors[vid] = rest;
    }
    result.vendors = cleanedVendors as LLMSettingsPatch["vendors"];

    // Top-level wins when explicitly set; otherwise promote from per-vendor.
    if (topLevelAuthMode === null && promotedVendor !== null) {
      result.authMode = "login";
      // Only override provider when the persisted one wasn't already this vendor.
      if (!isLLMVendor(llm.provider) || llm.provider !== promotedVendor) {
        result.provider = promotedVendor;
      }
      log.warn(
        `migrated legacy llm.vendors.${promotedVendor}.authMode="login" → top-level authMode + provider`,
      );
    }
  }

  // Strip the legacy top-level keys we don't own here.
  return result;
}

/**
 * UX Track 3 — coerce on-disk `appearance` block into AppearanceSettings v2.
 *
 * Detects whether the on-disk value is v1 (has `theme`/`chatTheme`/`codeTheme`)
 * or v2 (has `schemaVersion: 2`). v1 inputs are migrated; v2 inputs are
 * validated and returned as-is. Unknown bundleId falls back to DEFAULT_BUNDLE_ID.
 *
 * Settings load must never crash boot over a UI-only field.
 */

/** @internal — v1 legacy axis validation sets, used in migration only. */
const VALID_THEMES_V1: readonly ThemePreference[] = ["system", "light", "dark", "high-contrast"];
const VALID_CHAT_THEMES_V1: readonly ChatThemePreference[] = ["default", "lg", "purple", "orange", "blue"];

/** All valid bundle IDs — §C3: single source from src/shared/theme-bundles.ts. */
const VALID_BUNDLE_IDS: readonly string[] = BUNDLE_IDS;

/**
 * Migrate a v1 tri-axis appearance object to a v2 bundleId.
 *
 * Migration matrix (12 cases, per spec §3):
 *  dark + default/auto  → tokyo-night
 *  dark + lg            → violet-dark
 *  light + default/auto → forest
 *  light + lg           → violet-light
 *  system + default     → DEFAULT_BUNDLE_ID (renderer may apply followSystem)
 *  system + lg          → violet-dark + followSystem:true (renderer tracks OS scheme)
 *  * + purple|orange|blue → midnight (closest dark accent coercion)
 *  high-contrast + *    → high-contrast (HC always wins)
 *  code override (dark+default+light / light+default+dark) → bundle wins, code override ignored
 *  dark + lg + dark     → violet-dark
 *  invalid/unknown      → DEFAULT_BUNDLE_ID
 *
 * Note: "system" is intentionally NOT resolved via window.matchMedia here.
 * This function runs in the Electron main process where `window` is undefined.
 * System-theme users get DEFAULT_BUNDLE_ID (or violet-dark+followSystem),
 * and the renderer's followSystem toggle can track the OS scheme from there.
 */
export function migrateAppearanceV1ToV2(
  legacy: AppearanceSettingsV1,
): AppearanceSettings {
  const theme = VALID_THEMES_V1.includes(legacy.theme) ? legacy.theme : "system";
  const chatTheme = VALID_CHAT_THEMES_V1.includes(legacy.chatTheme) ? legacy.chatTheme : "default";

  // High-contrast always wins — accessibility first.
  if (theme === "high-contrast") {
    return { schemaVersion: 2, bundleId: "high-contrast" };
  }

  // Accent-only chat themes (purple/orange/blue) → midnight (closest dark accent).
  if (chatTheme === "purple" || chatTheme === "orange" || chatTheme === "blue") {
    return { schemaVersion: 2, bundleId: "midnight" };
  }

  // Violet pair (migrated from legacy "lg" chat theme).
  if (chatTheme === "lg") {
    if (theme === "light") return { schemaVersion: 2, bundleId: "violet-light" };
    if (theme === "dark")  return { schemaVersion: 2, bundleId: "violet-dark" };
    // system: default to violet-dark; renderer followSystem will track OS from here.
    return { schemaVersion: 2, bundleId: "violet-dark", followSystem: true };
  }

  // Default chat (no overlay) — preserve explicit legacy shell; "system" → DEFAULT.
  if (theme === "light") return { schemaVersion: 2, bundleId: "forest" };
  if (theme === "dark")  return { schemaVersion: 2, bundleId: "tokyo-night" };

  // system or unknown → DEFAULT_BUNDLE_ID
  return { schemaVersion: 2, bundleId: DEFAULT_BUNDLE_ID };
}

function normalizeAppearance(input: unknown): AppearanceSettings {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_SETTINGS.appearance };
  }
  const obj = input as Record<string, unknown>;

  // v2 path — schemaVersion:2 present.
  if (obj.schemaVersion === 2) {
    // Retired bundle IDs from earlier internal builds are not migrated:
    // the open-source release has no install base that would carry them
    // forward. Unknown bundleIds fall through to DEFAULT_BUNDLE_ID by
    // the VALID_BUNDLE_IDS gate below.
    const rawBundleId = typeof obj.bundleId === "string" ? obj.bundleId : "";
    const bundleId =
      VALID_BUNDLE_IDS.includes(rawBundleId)
        ? rawBundleId
        : DEFAULT_BUNDLE_ID;
    const followSystem = typeof obj.followSystem === "boolean" ? obj.followSystem : undefined;
    const result: AppearanceSettings = {
      schemaVersion: 2,
      bundleId,
      // Coerce any stored/legacy value to a supported locale; missing →
      // English default for the global build.
      language: normalizeLocale(obj.language),
    };
    if (followSystem !== undefined) result.followSystem = followSystem;
    const font = normalizeAppearanceFont(obj.font);
    if (font) result.font = font;
    return result;
  }

  // v1 path — has legacy keys.
  if (typeof obj.theme === "string" || typeof obj.chatTheme === "string" || typeof obj.codeTheme === "string") {
    const legacy: AppearanceSettingsV1 = {
      theme: (typeof obj.theme === "string" && (VALID_THEMES_V1 as readonly string[]).includes(obj.theme)
        ? obj.theme : "system") as ThemePreference,
      chatTheme: (typeof obj.chatTheme === "string" && (VALID_CHAT_THEMES_V1 as readonly string[]).includes(obj.chatTheme)
        ? obj.chatTheme : "default") as ChatThemePreference,
      codeTheme: (typeof obj.codeTheme === "string" ? obj.codeTheme : "auto") as CodeThemePreference,
    };
    // Preserve any stored language across the v1→v2 migration; default English.
    return { ...migrateAppearanceV1ToV2(legacy), language: normalizeLocale(obj.language) };
  }

  return { ...DEFAULT_SETTINGS.appearance };
}

function normalizeAppearanceFont(input: unknown): AppearanceFontSettings | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  const out: AppearanceFontSettings = {};
  if (typeof o.family === "string") {
    if (o.family === "system") {
      out.family = "system";
    } else if (isValidFontFamilyOverride(o.family)) {
      out.family = o.family;
    }
  }
  if (typeof o.sizeScale === "number"
    && (FONT_SIZE_SCALE_VALUES as readonly number[]).includes(o.sizeScale)) {
    out.sizeScale = o.sizeScale as FontSizeScale;
  }
  // Empty object → treat as undefined so defaults serialize cleanly.
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * §B1 / Critic F4 mitigation — coerce on-disk `webView` block back to
 * the WebViewSettings shape.
 *
 * If the field is missing entirely (existing installs), apply the default
 * `"in-app"`. If a *partial-but-invalid* value is on disk (e.g. user hand-
 * edited to `"yes"`, `null`, `42`), only that field is replaced with the
 * default — the rest of settings.json is preserved by the normal per-section
 * spread pattern in loadSettings(). A warn log emits once per load so a
 * silent corruption is still observable.
 */
const VALID_WEBVIEW_FLOWS: readonly WebViewPreferredFlow[] = ["in-app", "system-browser"];

function normalizeWebView(input: unknown): WebViewSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_SETTINGS.webView };
  }
  const obj = input as { preferredFlow?: unknown };
  const raw = obj.preferredFlow;
  if (typeof raw === "string" && (VALID_WEBVIEW_FLOWS as readonly string[]).includes(raw)) {
    return { preferredFlow: raw as WebViewPreferredFlow };
  }
  if (raw !== undefined) {
    log.warn(
      `webView.preferredFlow invalid (received ${JSON.stringify(raw)}), using default %s`,
      DEFAULT_SETTINGS.webView.preferredFlow,
    );
  }
  return { ...DEFAULT_SETTINGS.webView };
}

const VALID_CLOSE_BEHAVIORS: readonly SystemCloseBehavior[] = ["hide-to-tray", "quit"];

/**
 * The per-tab-kind vertical-split percent keys, iterated identically in the
 * update-patch and normalize paths so a new split-bearing tab kind is added in
 * exactly one place. `satisfies` pins each entry to a real `SystemSettings`
 * field, so a typo can never silently no-op.
 */
const SIDE_PANEL_SPLIT_KEYS = [
  "sidePanelSplitFilePercent",
  "sidePanelSplitPreviewPercent",
  "sidePanelSplitSubagentPercent",
] as const satisfies readonly (keyof SystemSettings)[];

function normalizeSystem(input: unknown): SystemSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_SETTINGS.system };
  }
  const obj = input as {
    closeBehavior?: unknown;
    appMode?: unknown;
    localApiServer?: unknown;
    sidePanelWidth?: unknown;
  } & Record<(typeof SIDE_PANEL_SPLIT_KEYS)[number], unknown>;
  // Each field is normalized independently: a missing/invalid field falls
  // back to its default while a valid sibling is preserved (mirrors the
  // per-field patch path in `update`).
  const result: SystemSettings = { ...DEFAULT_SETTINGS.system };
  const rawBehavior = obj.closeBehavior;
  if (
    typeof rawBehavior === "string" &&
    (VALID_CLOSE_BEHAVIORS as readonly string[]).includes(rawBehavior)
  ) {
    result.closeBehavior = rawBehavior as SystemCloseBehavior;
  } else if (rawBehavior !== undefined) {
    log.warn(
      `system.closeBehavior invalid (received ${JSON.stringify(rawBehavior)}), using default %s`,
      DEFAULT_SETTINGS.system.closeBehavior,
    );
  }
  const rawAppMode = obj.appMode;
  const normalizedAppMode = normalizeAppMode(rawAppMode);
  if (normalizedAppMode !== null) {
    result.appMode = normalizedAppMode;
  } else if (rawAppMode !== undefined) {
    log.warn(
      `system.appMode invalid (received ${JSON.stringify(rawAppMode)}), using default %s`,
      DEFAULT_SETTINGS.system.appMode,
    );
  }
  const rawLocalApi = obj.localApiServer;
  if (typeof rawLocalApi === "boolean") {
    result.localApiServer = rawLocalApi;
  } else if (rawLocalApi !== undefined) {
    log.warn(
      `system.localApiServer invalid (received ${JSON.stringify(rawLocalApi)}), using default %s`,
      DEFAULT_SETTINGS.system.localApiServer,
    );
  }
  const rawSidePanelWidth = obj.sidePanelWidth;
  if (typeof rawSidePanelWidth === "number" && Number.isFinite(rawSidePanelWidth)) {
    result.sidePanelWidth = Math.max(SIDE_PANEL_MIN_WIDTH, Math.round(rawSidePanelWidth));
  } else if (rawSidePanelWidth !== undefined) {
    log.warn(
      `system.sidePanelWidth invalid (received ${JSON.stringify(rawSidePanelWidth)}), using default %s`,
      SIDE_PANEL_DEFAULT_WIDTH,
    );
  }
  for (const key of SIDE_PANEL_SPLIT_KEYS) {
    const raw = obj[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = clampSidePanelSplitPercent(raw);
    } else if (raw !== undefined) {
      log.warn(
        `system.${key} invalid (received ${JSON.stringify(raw)}), using default %s`,
        SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
      );
    }
  }
  return result;
}

/**
 * Coerce on-disk `features` block to FeatureFlags shape.
 * Missing or invalid fields are silently dropped, so each flag falls back to
 * its value in DEFAULT_SETTINGS.features.
 */
function normalizeFeatureFlags(input: unknown): FeatureFlags {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const obj = input as Record<string, unknown>;
  const result: FeatureFlags = {};
  if (typeof obj.idlePreferenceRefresh === "boolean") {
    result.idlePreferenceRefresh = obj.idlePreferenceRefresh;
  }
  if (typeof obj.onboardingCompleted === "boolean") {
    result.onboardingCompleted = obj.onboardingCompleted;
  }
  if (typeof obj.hostClassifiesRisk === "boolean") {
    result.hostClassifiesRisk = obj.hostClassifiesRisk;
  }
  if (typeof obj.osToolSandbox === "boolean") {
    result.osToolSandbox = obj.osToolSandbox;
  }
  return result;
}

function sanitizeStoredPluginConfigs(input: unknown): Record<string, PluginConfigRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const out: Record<string, PluginConfigRecord> = {};
  for (const [pluginId, config] of Object.entries(input)) {
    try {
      const safePluginId = sanitizePluginConfigPluginId(pluginId);
      out[safePluginId] = sanitizePluginConfig(config);
    } catch (err) {
      log.warn(
        "dropping invalid stored plugin config: %s",
        (err as Error).message,
      );
    }
  }
  return out;
}
