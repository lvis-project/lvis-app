import { safeStorage } from "electron";
import { closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type LLMVendor = "claude" | "openai" | "gemini" | "copilot";

export interface LLMSettings {
  provider: LLMVendor;
  model: string;
  /** Enable extended thinking / reasoning (Claude Sonnet 4.5+, Opus 4+). */
  enableThinking?: boolean;
  /** Token budget for Claude extended thinking (1024–32000). Only used when enableThinking is true. */
  thinkingBudgetTokens?: number;
}

export interface ChatSettings {
  systemPrompt: string;
  autoCompact: boolean;
}

export interface AppSettings {
  llm: LLMSettings;
  chat: ChatSettings;
  webSearch: WebSearchSettings;
  marketplace: MarketplaceSettings;
}

export interface WebSearchSettings {
  provider: "duckduckgo" | "tavily" | "serper" | "google";
}

/**
 * §9.5 M4: plugin marketplace backend selection.
 *
 * - `"mock"`         — default; reads the bundled `plugins/marketplace.json`.
 * - `"real-cloud"`   — talks to lvis-marketplace REST server at
 *                      `realCloudBaseUrl`. Bearer auth via
 *                      `settings.marketplace.apiKey` secret.
 */
export interface MarketplaceSettings {
  backend: "mock" | "real-cloud";
  realCloudBaseUrl?: string;
  /** Local dev/test only: bypass SSRF guard for loopback servers. */
  realCloudAllowPrivateNetwork?: boolean;
}

export interface SettingsServiceOptions {
  userDataPath: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    provider: "claude",
    model: "claude-sonnet-4-6",
    enableThinking: true,
    thinkingBudgetTokens: 10_000,
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

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.settings[key] = value;
    this.saveSettings();
  }

  patch(partial: Partial<AppSettings>): AppSettings {
    if (partial.llm) this.settings.llm = { ...this.settings.llm, ...partial.llm };
    if (partial.chat) this.settings.chat = { ...this.settings.chat, ...partial.chat };
    if (partial.webSearch) this.settings.webSearch = { ...this.settings.webSearch, ...partial.webSearch };
    if (partial.marketplace) {
      this.settings.marketplace = { ...this.settings.marketplace, ...partial.marketplace };
    }
    this.saveSettings();
    return this.getAll();
  }

  /** 비밀 값(API 키 등)을 암호화하여 저장 */
  setSecret(key: string, value: string): void {
    const secrets = this.loadSecrets();
    if (safeStorage.isEncryptionAvailable()) {
      secrets[key] = safeStorage.encryptString(value).toString("base64");
    } else {
      // 암호화 불가 환경 — 평문 저장 (개발 환경 등)
      secrets[key] = `plain:${value}`;
    }
    this.saveSecrets(secrets);
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

  deleteSecret(key: string): void {
    const secrets = this.loadSecrets();
    delete secrets[key];
    this.saveSecrets(secrets);
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
      // Migrate pre-thinking Claude models so enableThinking doesn't fail on load.
      if (llm.provider === "claude" && /^claude-sonnet-4-2025/i.test(llm.model)) {
        llm.model = DEFAULT_SETTINGS.llm.model;
      }
      // Migrate removed/unsupported vendors (e.g. pre-strip "lgenie") onto the
      // current default so provider-factory doesn't throw at turn time.
      const SUPPORTED_VENDORS = ["claude", "openai", "gemini", "copilot"] as const;
      if (!(SUPPORTED_VENDORS as readonly string[]).includes(llm.provider)) {
        llm.provider = DEFAULT_SETTINGS.llm.provider;
        llm.model = DEFAULT_SETTINGS.llm.model;
      }
      return {
        llm,
        chat: { ...DEFAULT_SETTINGS.chat, ...parsed.chat },
        webSearch: { ...DEFAULT_SETTINGS.webSearch, ...parsed.webSearch },
        marketplace: { ...DEFAULT_SETTINGS.marketplace, ...parsed.marketplace },
      };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private saveSettings(): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
  }

  private loadSecrets(): Record<string, string> {
    if (!existsSync(this.secretsPath)) return {};
    try {
      return JSON.parse(readFileSync(this.secretsPath, "utf-8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private saveSecrets(secrets: Record<string, string>): void {
    mkdirSync(dirname(this.secretsPath), { recursive: true });
    // Security A4 fix: 0o600 mode (owner only) — Linux 공용 PC에서 safeStorage unavailable 시
    // 'plain:' prefix 평문 API 키가 other/group에 노출되는 것을 차단
    writeFileSync(this.secretsPath, JSON.stringify(secrets, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}
