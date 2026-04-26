import { safeStorage } from "electron";
import { closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import {
  sanitizePluginConfig,
  sanitizePluginConfigPluginId,
  type PluginConfigRecord,
} from "../shared/plugin-config.js";
import {
  clampRoutinePrompt,
  createDefaultScheduleEntry,
  DEFAULT_SHUTDOWN_PROMPT,
  DEFAULT_WAKEUP_ROUTINE_PROMPT,
  normalizeScheduleEntries,
  type ScheduleRoutineEntry,
} from "../routines/schedule.js";

export type LLMVendor =
  | "claude"
  | "openai"
  | "gemini"
  | "copilot"
  | "azure-foundry"
  | "vertex-ai";

export interface LLMSettings {
  provider: LLMVendor;
  model: string;
  /**
   * Per-vendor baseUrl overrides (keyed by vendor). Required for:
   *   - azure-foundry: `https://{resource}.openai.azure.com/openai/deployments/{deployment}/`
   * Optional for:
   *   - openai / copilot: proxy endpoints
   * Not used by:
   *   - vertex-ai: uses project + location instead (see vertexProject / vertexLocation)
   */
  baseUrls?: Partial<Record<LLMVendor, string>>;
  /**
   * Vertex AI — GCP project ID (required for vendor="vertex-ai").
   * Auth flows via service account: either GOOGLE_APPLICATION_CREDENTIALS env
   * pointing at a credentials JSON, or Application Default Credentials (ADC).
   */
  vertexProject?: string;
  /** Vertex AI — GCP region (e.g. "us-central1"). Defaults to "us-central1". */
  vertexLocation?: string;
  /** Enable extended thinking / reasoning (Claude Sonnet 4.5+, Opus 4+). */
  enableThinking?: boolean;
  /** Token budget for Claude extended thinking (1024–32000). Only used when enableThinking is true. */
  thinkingBudgetTokens?: number;
  /** Sprint A — advanced generation settings. All optional; defaults applied in conversation-loop. */
  temperature?: number;
  /** Sprint A — max output tokens (renames maxTokens for clarity). */
  maxOutputTokens?: number;
  /** Sprint A — deterministic sampling seed. Undefined = random. */
  seed?: number;
  /** Sprint A — response format. "text" (default) or "json" (vendor-mapped). */
  responseFormat?: "text" | "json";
  /** Sprint A — stop sequences forwarded to the provider. */
  stopSequences?: string[];
  /** Sprint A — client-side stream smoothing. */
  streamSmoothing?: "none" | "word" | "char";
  /**
   * D1a — ordered fallback chain tried in sequence when the primary vendor
   * returns a transient error (5xx / 429 / network). Empty = no fallback.
   */
  fallbackChain?: Array<{ provider: LLMVendor; model: string }>;
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
  msGraph: MsGraphSettings;
  /** Phase 1 §Step 2 — plugin trust-boundary settings. */
  plugins: PluginSettings;
  /** 플러그인별 설정값 — pluginId → key/value 맵 */
  pluginConfigs: Record<string, PluginConfigRecord>;
}

/**
 * Phase 1 §Step 2 — plugin trust-boundary opt-ins.
 *
 * `allowUnsignedUserPlugins`:
 *   When false (default), an unsigned user plugin is fail-closed at boot —
 *   the host SKIPS loading it and emits `plugin_unsigned_user_rejected`.
 *   When true, the legacy "warn-and-load" behaviour returns and the host
 *   emits `plugin_unsigned_user_loaded_with_optin`.
 *
 *   This is opt-in because user-installed plugins live in user-writable
 *   HOME storage; loading unsigned code from there is persistent code-
 *   execution-from-HOME after the path migration shipped in Phase 0.
 */
export interface PluginSettings {
  allowUnsignedUserPlugins: boolean;
}

/**
 * MsGraph 환경 선택 — LVIS 는 2개 app registration (external / corporate) 을
 * 지원하며 사용자가 로그인 시점에 어느 환경을 쓸지 택1한다.
 *
 * 기본값 `external` — 대부분 개발자/외부 사용자 경로 유지.
 * 사내망 배포 시 `corporate` 로 기본값을 덮어쓰는 installer 정책 고려 가능.
 */
export interface MsGraphSettings {
  /** "external" | "corporate" — ms-graph-auth-config.ts 참조 */
  environment: "external" | "corporate";
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
 * §7 Routine Engine settings.
 *
 * - `enableWakeupRoutine`   — wakeup 루틴 마스터 스위치 (long_idle / schedule 트리거)
 * - `lastWakeupRoutineAt`   — ISO date (YYYY-MM-DD KST) of most recent wakeup routine run
 * - `lastDismissedAt`       — ISO timestamp of last user dismissal
 */
export interface RoutineSettings {
  enableWakeupRoutine: boolean;
  lastWakeupRoutineAt?: string;
  lastDismissedAt?: string;
  scheduleTimeKst?: string;
  wakeupRoutinePrompt?: string;
  enableShutdownRoutine?: boolean;
  shutdownPrompt?: string;
  enableScheduleRoutine?: boolean;
  scheduleEntries?: ScheduleRoutineEntry[];
  /**
   * Long-idle threshold (ms) used by RoutineIdleSignaler to filter out short
   * lock/unlock cycles. Default 10 min. Distinct from indexer's short 60s
   * idle threshold (IdleSchedulerService.idleThresholdSec).
   */
  routineIdleThresholdMs?: number;
}

export interface WebSearchSettings {
  provider: "duckduckgo" | "tavily" | "serper" | "google";
}

/**
 * §9.5 M4: plugin marketplace backend selection.
 *
 * - `"mock"`         — default; reads the local `plugins/marketplace.json`.
 * - `"real-cloud"`   — talks to lvis-marketplace REST server at
 *                      `realCloudBaseUrl`. Bearer auth via
 *                      `settings.marketplace.apiKey` secret.
 */
export interface MarketplaceSettings {
  backend: "mock" | "real-cloud";
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

const LEGACY_INSECURE_MARKETPLACE_DEFAULT = {
  backend: "real-cloud" as const,
  realCloudBaseUrl: "http://localhost:8000",
  realCloudAllowPrivateNetwork: true,
};

const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    provider: "claude",
    model: "claude-sonnet-4-6",
    enableThinking: true,
    thinkingBudgetTokens: 10_000,
    temperature: 0.7,
    maxOutputTokens: 4096,
    responseFormat: "text",
    streamSmoothing: "none",
  },
  chat: {
    systemPrompt:
      "당신은 LVIS 로컬 지식 어시스턴트입니다. 사용자의 문서와 컨텍스트를 기반으로 정확하고 유용한 답변을 제공합니다. 한국어로 답변합니다.",
    autoCompact: true,
  },
  webSearch: {
    provider: "duckduckgo",
  },
  marketplace: {
    backend: "mock",
    realCloudAllowPrivateNetwork: false,
  },
  routine: {
    enableWakeupRoutine: false,
    scheduleTimeKst: "08:30",
    wakeupRoutinePrompt: DEFAULT_WAKEUP_ROUTINE_PROMPT,
    enableShutdownRoutine: true,
    shutdownPrompt: DEFAULT_SHUTDOWN_PROMPT,
    enableScheduleRoutine: true,
    scheduleEntries: [createDefaultScheduleEntry(0)],
    routineIdleThresholdMs: 10 * 60_000,
  },
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
  msGraph: {
    environment: "external",
  },
  plugins: {
    allowUnsignedUserPlugins: false,
  },
  pluginConfigs: {},
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
    this.settings = this.loadSettings();
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
      console.warn("[settings] secrets mode migration failed:", (err as Error).message);
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

  async patch(partial: Partial<AppSettings>): Promise<AppSettings> {
    if (partial.llm) this.settings.llm = { ...this.settings.llm, ...partial.llm };
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
    if (partial.updates) {
      this.settings.updates = { ...this.settings.updates, ...partial.updates };
    }
    if (partial.telemetry) {
      this.settings.telemetry = { ...this.settings.telemetry, ...partial.telemetry };
    }
    if (partial.audit) {
      this.settings.audit = { ...this.settings.audit, ...partial.audit };
    }
    if (partial.msGraph) {
      this.settings.msGraph = { ...this.settings.msGraph, ...partial.msGraph };
    }
    if (partial.pluginConfigs) {
      const sanitized: Record<string, PluginConfigRecord> = {};
      for (const [pluginId, config] of Object.entries(partial.pluginConfigs)) {
        const safePluginId = sanitizePluginConfigPluginId(pluginId);
        sanitized[safePluginId] = sanitizePluginConfig(config);
      }
      this.settings.pluginConfigs = { ...this.settings.pluginConfigs, ...sanitized };
    }
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
    } catch {
      return null;
    }
  }

  async deleteSecret(key: string): Promise<void> {
    const secrets = this.loadSecrets();
    delete secrets[key];
    await this.saveSecrets(secrets);
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
      const llm = { ...DEFAULT_SETTINGS.llm, ...parsed.llm };
      // MEDIUM-2: enableThinking은 Claude 전용 기능.
      // 파일에 명시되지 않은 경우, Claude면 true(기본값 유지), 그 외엔 false로 강제.
      if (parsed.llm?.enableThinking === undefined && llm.provider !== "claude") {
        llm.enableThinking = false;
      }
      // Migrate pre-thinking Claude models so enableThinking doesn't fail on load.
      if (llm.provider === "claude" && /^claude-sonnet-4-2025/i.test(llm.model)) {
        llm.model = DEFAULT_SETTINGS.llm.model;
      }
      // Migrate removed/unsupported vendors (e.g. pre-strip "lgenie") onto the
      // current default so provider-factory doesn't throw at turn time.
      const SUPPORTED_VENDORS = [
        "claude",
        "openai",
        "gemini",
        "copilot",
        "azure-foundry",
        "vertex-ai",
      ] as const;
      if (!(SUPPORTED_VENDORS as readonly string[]).includes(llm.provider)) {
        llm.provider = DEFAULT_SETTINGS.llm.provider;
        llm.model = DEFAULT_SETTINGS.llm.model;
      }
      const marketplaceParsed: Record<string, unknown> = { ...(parsed.marketplace ?? {}) };
      // Security hardening: an earlier default/migration auto-enabled a
      // loopback marketplace (`http://localhost:8000`) with the private-network
      // SSRF bypass set to true. Treat that exact tuple as an accidental legacy
      // default, not an explicit user choice, and fall back to the safe mock
      // backend instead. Real cloud deployments must now be configured
      // intentionally.
      if (
        marketplaceParsed.backend === LEGACY_INSECURE_MARKETPLACE_DEFAULT.backend &&
        marketplaceParsed.realCloudBaseUrl === LEGACY_INSECURE_MARKETPLACE_DEFAULT.realCloudBaseUrl &&
        marketplaceParsed.realCloudAllowPrivateNetwork ===
          LEGACY_INSECURE_MARKETPLACE_DEFAULT.realCloudAllowPrivateNetwork
      ) {
        marketplaceParsed.backend = DEFAULT_SETTINGS.marketplace.backend;
        delete marketplaceParsed.realCloudBaseUrl;
        marketplaceParsed.realCloudAllowPrivateNetwork =
          DEFAULT_SETTINGS.marketplace.realCloudAllowPrivateNetwork;
      } else if (
        marketplaceParsed.backend === "real-cloud" &&
        marketplaceParsed.realCloudAllowPrivateNetwork === undefined
      ) {
        marketplaceParsed.realCloudAllowPrivateNetwork = false;
      }
      const pluginConfigs = sanitizeStoredPluginConfigs(parsed.pluginConfigs);
      const routine = parsed.routine;
      const ROUTINE_IDLE_THRESHOLD_MIN_MS = 60_000;        // 1 min floor (debug/test)
      const ROUTINE_IDLE_THRESHOLD_MAX_MS = 60 * 60_000;   // 1 hour ceiling
      const ROUTINE_IDLE_THRESHOLD_DEFAULT_MS = 10 * 60_000;
      const rawIdleThreshold = routine?.routineIdleThresholdMs;
      const idleThresholdMs = typeof rawIdleThreshold === "number" && Number.isFinite(rawIdleThreshold)
        ? Math.max(ROUTINE_IDLE_THRESHOLD_MIN_MS, Math.min(rawIdleThreshold, ROUTINE_IDLE_THRESHOLD_MAX_MS))
        : ROUTINE_IDLE_THRESHOLD_DEFAULT_MS;
      const normalizedRoutine: RoutineSettings = {
        ...DEFAULT_SETTINGS.routine,
        ...routine,
        wakeupRoutinePrompt: typeof routine?.wakeupRoutinePrompt === "string" && routine.wakeupRoutinePrompt.trim().length > 0
          ? clampRoutinePrompt(routine.wakeupRoutinePrompt.trim())
          : DEFAULT_WAKEUP_ROUTINE_PROMPT,
        scheduleEntries: normalizeScheduleEntries(routine?.scheduleEntries),
        shutdownPrompt: typeof routine?.shutdownPrompt === "string" && routine.shutdownPrompt.trim().length > 0
          ? clampRoutinePrompt(routine.shutdownPrompt.trim())
          : DEFAULT_SHUTDOWN_PROMPT,
        enableWakeupRoutine: routine?.enableWakeupRoutine ?? false,
        lastWakeupRoutineAt: routine?.lastWakeupRoutineAt,
        enableShutdownRoutine: routine?.enableShutdownRoutine ?? true,
        enableScheduleRoutine: routine?.enableScheduleRoutine ?? true,
        routineIdleThresholdMs: idleThresholdMs,
      };

      // Phase 1 §Step 2 — sanitize plugins block. Default false; accept only
      // booleans (unknown shapes silently fall back). Same pattern as the
      // other normalization blocks above.
      const rawPlugins = parsed.plugins;
      const normalizedPlugins: PluginSettings = {
        allowUnsignedUserPlugins:
          typeof rawPlugins?.allowUnsignedUserPlugins === "boolean"
            ? rawPlugins.allowUnsignedUserPlugins
            : DEFAULT_SETTINGS.plugins.allowUnsignedUserPlugins,
      };

      return {
        llm,
        chat: { ...DEFAULT_SETTINGS.chat, ...parsed.chat },
        webSearch: { ...DEFAULT_SETTINGS.webSearch, ...parsed.webSearch },
        marketplace: { ...DEFAULT_SETTINGS.marketplace, ...marketplaceParsed },
        routine: normalizedRoutine,
        privacy: { ...DEFAULT_SETTINGS.privacy, ...parsed.privacy },
        updates: { ...DEFAULT_SETTINGS.updates, ...parsed.updates },
        telemetry: { ...DEFAULT_SETTINGS.telemetry, ...parsed.telemetry },
        audit: { ...DEFAULT_SETTINGS.audit, ...parsed.audit },
        msGraph: { ...DEFAULT_SETTINGS.msGraph, ...parsed.msGraph },
        plugins: normalizedPlugins,
        pluginConfigs: { ...DEFAULT_SETTINGS.pluginConfigs, ...pluginConfigs },
      };
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
      console.warn(
        "[settings] dropping invalid stored plugin config:",
        (err as Error).message,
      );
    }
  }
  return out;
}
