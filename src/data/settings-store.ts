import { safeStorage } from "electron";
import { closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
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
  LLM_VENDORS,
  type LLMVendor,
  type LLMVendorSettings,
} from "../shared/llm-vendor-defaults.js";
import { BUNDLE_IDS, DEFAULT_BUNDLE_ID } from "../shared/theme-bundles.js";
import { createLogger } from "../lib/logger.js";
import { cloneDefaultRolePresets, normalizeRolePresets, type RolePreset } from "./role-presets.js";
const log = createLogger("settings");

export type { LLMVendor, LLMVendorSettings };
export { LLM_VENDORS };

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
}

export interface ChatSettings {
  systemPrompt: string;
  autoCompact: boolean;
}

export interface RoleSettings {
  presets: RolePreset[];
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
   * #893 — Set to `true` after the user has dismissed the first-boot onboarding
   * dialog (either via "API 키 입력" or "로그인"). Defaults to undefined / false
   * so legacy installs see the dialog once on first launch after upgrade. The
   * value is persisted to `~/.lvis/settings.json` via the standard settings
   * patch flow — no separate disk file.
   */
  onboardingCompleted?: boolean;
  /**
   * O-X1 Live Auto-play (proposal: docs/architecture/proposals/live-autoplay.md).
   * Demo-only flag. When true *and* `process.env.LVIS_DEMO_VENDOR` is set,
   * ChatView mounts in demo-autoplay mode on first run. After the user takes
   * over (any keystroke or "키 잡기 →" click) the flag is flipped to false so
   * the demo never re-runs. In packaged production builds with `LVIS_DEMO_VENDOR`
   * unset this entire path is dead — the demo cannot silently activate.
   */
  demoAutoplayEnabled?: boolean;
  /**
   * Tutorial-X3 — index into the `DEMO_SCRIPTS` rotation. Each install
   * boot picks `DEMO_SCRIPTS[index % len]`, then bumps the index. The
   * value is best-effort: `undefined` falls back to 0, out-of-range
   * values are wrapped modulo the catalog length. A single int avoids a
   * dedicated namespace for one counter.
   */
  demoAutoplayRotationIndex?: number;
}

export interface AppSettings {
  llm: LLMSettings;
  chat: ChatSettings;
  roles: RoleSettings;
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
  /** 플러그인별 설정값 — pluginId → key/value 맵 */
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
 * value MUST match the validator below (`isValidFontFamilyOverride`); rejected
 * values fall back to `"system"` at normalize time so a corrupt settings.json
 * cannot break first paint.
 *
 * `sizeScale` — multiplicative on `1rem`. Discrete preset values keep the UI
 * legible at every step (a free slider would let users pick `0.4` and lock
 * themselves out of the settings dialog).
 */
export const FONT_SIZE_SCALE_VALUES = [0.875, 1, 1.125, 1.25] as const;
export type FontSizeScale = (typeof FONT_SIZE_SCALE_VALUES)[number];

export interface AppearanceFontSettings {
  /** `"system"` = HOST_FONT_STACK default; otherwise a validated raw CSS font-family stack. */
  family?: "system" | string;
  /** Multiplier on `1rem` base. Allowed: 0.875 / 1 / 1.125 / 1.25. */
  sizeScale?: FontSizeScale;
}

/** v2 appearance settings — single bundle, optional followSystem + font overrides. */
export interface AppearanceSettings {
  schemaVersion: 2;
  bundleId: string;
  followSystem?: boolean;
  font?: AppearanceFontSettings;
}

/**
 * Allow Unicode letters/digits (Hangul, CJK, Latin, …), single space, commas,
 * hyphens, single/double quotes, and underscores in a user-supplied font-family
 * stack. The Unicode class is required because JS `\w` is ASCII-only — without
 * `\p{L}` Korean users typing `맑은 고딕, sans-serif` would be silently rejected
 * (PR #672 critic CRITICAL #3). Explicitly excludes every CSS injection
 * metachar (`;`, `{`, `}`, `(`, `)`, `:`, `<`, `>`, `\`, `` ` ``, `/`, `*`, `=`)
 * and embedded newlines/tabs (whitespace is narrowed to ASCII space) so the
 * value cannot break out of the `font-family` declaration.
 *
 * 200-char cap prevents a malicious or oversized settings.json from bloating
 * every CSS var lookup.
 */
const _FONT_FAMILY_RE = /^[\p{L}\p{N} ,"'_-]+$/u;
const _FONT_FAMILY_MAX = 200;

export function isValidFontFamilyOverride(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= _FONT_FAMILY_MAX
    && _FONT_FAMILY_RE.test(value);
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

/**
 * Window close-button behaviour.
 *
 * `hide-to-tray` (default) — `win.on("close")` calls `preventDefault()` and
 * hides the window, leaving the main process alive so the tray icon, routine
 * scheduler, briefing engine, and any plugin background work keep running.
 * Quitting requires the tray context menu's 종료 item or `Cmd/Ctrl+Q`.
 *
 * `quit` — the close button terminates the app the same way a regular Windows
 * app does. Users who don't want LVIS running in the background can pick this.
 */
export type SystemCloseBehavior = "hide-to-tray" | "quit";

export interface SystemSettings {
  closeBehavior: SystemCloseBehavior;
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

/**
 * Sprint E §3 — Privacy tab. Default OFF.
 * piiRedactEnabled: 활성화 시 user draft 를 LLM 으로 보내기 전 DLPFilter 로
 *   이메일/전화/신용카드 등을 `[REDACTED:*]` 로 치환한다. 감사 로그에 건수 기록.
 */
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
 * Phase 2-final: server-only. The lvis-marketplace REST API is the single
 * source of truth for catalog + signed artifacts. The historical "mock"
 * backend that read `plugins/marketplace.json` from disk is removed; tests
 * that need a deterministic catalog inject a stub fetcher directly.
 */
export interface MarketplaceSettings {
  /** Reserved for future variants. Currently always `"real-cloud"`. */
  backend: "real-cloud";
  realCloudBaseUrl?: string;
  /** Local dev/test only: bypass SSRF guard for loopback servers. */
  realCloudAllowPrivateNetwork?: boolean;
  /**
   * S8 — enable/disable plugin update detection at boot. Default true.
   */
  updateCheckEnabled?: boolean;
  /**
   * S8 — update-check interval in milliseconds. Default 6 hours (21_600_000 ms).
   * Set to 0 to disable periodic checks (manual / on-open only).
   */
  updateCheckIntervalMs?: number;
  /**
   * S8 — when true, canary/pre-release catalog entries are included in
   * update notifications. Default false (stable only).
   */
  canaryOptIn?: boolean;
}

export interface SettingsServiceOptions {
  userDataPath: string;
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
      "당신은 LVIS 로컬 지식 어시스턴트입니다. 사용자의 문서와 컨텍스트를 기반으로 정확하고 유용한 답변을 제공합니다. 한국어로 답변합니다.",
    autoCompact: true,
  },
  roles: {
    presets: cloneDefaultRolePresets(),
  },
  webSearch: {
    provider: "duckduckgo",
  },
  marketplace: {
    // Phase 2-final defaults — single source: marketplace server. Default
    // points at the production tunnel so a fresh install lands on the live
    // catalog without any post-install configuration. Operators running a
    // local marketplace (http://localhost:8000) can override via Settings →
    // 마켓플레이스 tab and re-enable the private-network allowance there.
    // No fallback to a local catalog file — the only way to populate the
    // host's plugin layout is through the marketplace API.
    backend: "real-cloud",
    realCloudBaseUrl: "https://marketplace.lvisai.xyz",
    realCloudAllowPrivateNetwork: false,
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
  },
  webView: {
    preferredFlow: "in-app",
  },
  system: {
    closeBehavior: "hide-to-tray",
  },
  plugins: {},
  pluginConfigs: {},
  features: {
    idlePreferenceRefresh: false,
    // Fresh installs MUST start the Z onboarding chain. Persisting an
    // explicit `false` (instead of relying on `undefined`) keeps the
    // contract obvious: the flag flips to `true` exactly once, from
    // `markOnboardingCompleted` after the user finishes (or skips) the
    // chain. Any other path that wants to suppress the chain must set
    // this to `true` deliberately — no "missing key === skipped" trap.
    onboardingCompleted: false,
  },
};

export class SettingsService {
  private readonly settingsPath: string;
  private readonly secretsPath: string;
  private settings: AppSettings;

  constructor(options: SettingsServiceOptions) {
    const dir = resolve(options.userDataPath);
    mkdirSync(dir, { recursive: true });
    this.settingsPath = resolve(dir, "lvis-settings.json");
    this.secretsPath = resolve(dir, "lvis-secrets.json");
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

  /**
   * Phase 1.5 §7.x: Retroactive 0o600 enforcement.
   * Phase 1 C5 fix (A4)는 신규 write에만 mode를 적용했으므로, 기존 설치에
   * 남아있는 lvis-secrets.json (0o644 추정)을 owner-only로 내려준다.
   *
   * F-round §M2: fd-based fstat+fchmod로 TOCTOU 방지. path 기반 chmod는
   * 공격자가 stat→chmod window 사이에 파일을 symlink로 바꿔치기해 다른 파일의
   * 퍼미션을 내릴 수 있다 (chmod follows symlinks on Linux). fd를 열면 파일
   * 핸들이 해당 inode에 고정되므로 이 race를 차단.
   *
   * Windows에서는 POSIX mode가 무의미하므로 silent-skip.
   */
  private migrateSecretsMode(): void {
    if (process.platform === "win32") return;
    if (!existsSync(this.secretsPath)) return;
    let fd: number | null = null;
    try {
      fd = openSync(this.secretsPath, "r");
      const st = fstatSync(fd);
      if ((st.mode & 0o777) !== 0o600) {
        fchmodSync(fd, 0o600);
      }
    } catch (err) {
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
    if (partial.roles) this.settings.roles = normalizeRoleSettings(partial.roles, this.settings.roles);
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
      // Accept `font: undefined`, missing field, or `font: null` — all three
      // mean "no font subfield patch in this call". Guard against `null` so
      // a defensive caller (or a malformed test fixture) cannot crash
      // `fontPatch.family` access (PR #672 2차 critic minor N3).
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
      this.settings.system = normalizeSystem({ ...this.settings.system, ...partial.system });
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

  /** 비밀 값(API 키 등)을 암호화하여 저장 */
  async setSecret(key: string, value: string): Promise<void> {
    const secrets = this.loadSecrets();
    if (safeStorage.isEncryptionAvailable()) {
      secrets[key] = safeStorage.encryptString(value).toString("base64");
    } else {
      // 암호화 불가 환경 — 평문 저장 (개발 환경 등)
      secrets[key] = `plain:${value}`;
    }
    await this.saveSecrets(secrets);
  }

  /** 저장된 비밀 값을 복호화하여 반환 */
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

  // Copilot review fix: 기존 hasApiKey() 는 `llm.apiKey` 단일 키만 검사했으나
  // 실제 IPC handler (`lvis:settings:has-api-key`) 는 vendor 별 `llm.apiKey.<v>`
  // 형식으로 직접 getSecret 을 호출한다. 이 메서드는 어디서도 호출되지 않아
  // dead code 였고, 미래 caller 가 잘못 사용하면 항상 false 를 반환했을 것이다.
  // 통일된 API key 검사는 `getSecret(\`llm.apiKey.\${vendor}\`)` 로 직접 수행하라.

  // --- private helpers ---

  private loadSettings(): AppSettings {
    if (!existsSync(this.settingsPath)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const raw = readFileSync(this.settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as any;
      const migratedLlm = migrateLegacyLlmAuthMode(parsed.llm);
      const llm = mergeLlmPatch(DEFAULT_SETTINGS.llm, migratedLlm);
      const marketplaceParsed: Record<string, unknown> = { ...(parsed.marketplace ?? {}) };
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
        roles: normalizeRoleSettings(parsed.roles),
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
      // Security A4 fix: 0o600 mode (owner only) — Linux 공용 PC에서 safeStorage unavailable 시
      // 'plain:' prefix 평문 API 키가 other/group에 노출되는 것을 차단
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
  return {
    authMode,
    provider,
    vendors,
    streamSmoothing: partial.streamSmoothing ?? base.streamSmoothing,
    fallbackChain: partial.fallbackChain ?? base.fallbackChain,
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

function normalizeRoleSettings(input: unknown, base: RoleSettings = DEFAULT_SETTINGS.roles): RoleSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { presets: normalizeRolePresets(base.presets) };
  }
  const obj = input as { presets?: unknown };
  return {
    presets: normalizeRolePresets(obj.presets ?? base.presets),
  };
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
 *  system + default     → tokyo-night (DEFAULT_BUNDLE_ID; renderer may apply followSystem)
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

  // Default chat (no overlay) — pick by explicit shell; "system" → DEFAULT.
  if (theme === "light") return { schemaVersion: 2, bundleId: "forest" };
  if (theme === "dark")  return { schemaVersion: 2, bundleId: DEFAULT_BUNDLE_ID };

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
    const result: AppearanceSettings = { schemaVersion: 2, bundleId };
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
    return migrateAppearanceV1ToV2(legacy);
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

function normalizeSystem(input: unknown): SystemSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_SETTINGS.system };
  }
  const obj = input as { closeBehavior?: unknown };
  const raw = obj.closeBehavior;
  if (typeof raw === "string" && (VALID_CLOSE_BEHAVIORS as readonly string[]).includes(raw)) {
    return { closeBehavior: raw as SystemCloseBehavior };
  }
  if (raw !== undefined) {
    log.warn(
      `system.closeBehavior invalid (received ${JSON.stringify(raw)}), using default %s`,
      DEFAULT_SETTINGS.system.closeBehavior,
    );
  }
  return { ...DEFAULT_SETTINGS.system };
}

/**
 * Coerce on-disk `features` block to FeatureFlags shape.
 * Missing or invalid fields are silently dropped — all flags default to false.
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
  if (typeof obj.demoAutoplayEnabled === "boolean") {
    result.demoAutoplayEnabled = obj.demoAutoplayEnabled;
  }
  // Tutorial-X3 — accept the int rotation index; drop NaN / non-finite
  // values so a corrupted on-disk state never crashes the autoplay path.
  if (
    typeof obj.demoAutoplayRotationIndex === "number" &&
    Number.isFinite(obj.demoAutoplayRotationIndex)
  ) {
    result.demoAutoplayRotationIndex = obj.demoAutoplayRotationIndex;
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
