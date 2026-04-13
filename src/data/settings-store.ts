import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type LLMVendor = "claude" | "openai" | "gemini" | "copilot" | "lgenie";

export interface LLMSettings {
  provider: LLMVendor;
  model: string;
}

export interface ChatSettings {
  systemPrompt: string;
}

export interface AppSettings {
  llm: LLMSettings;
  chat: ChatSettings;
  webSearch: WebSearchSettings;
}

export interface WebSearchSettings {
  provider: "duckduckgo" | "tavily" | "serper" | "google";
}

export interface SettingsServiceOptions {
  userDataPath: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    provider: "claude",
    model: "claude-sonnet-4-20250514",
  },
  chat: {
    systemPrompt:
      "당신은 LVIS 로컬 지식 어시스턴트입니다. 사용자의 문서와 컨텍스트를 기반으로 정확하고 유용한 답변을 제공합니다. 한국어로 답변합니다.",
  },
  webSearch: {
    provider: "duckduckgo",
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
    this.settings = this.loadSettings();
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

  hasApiKey(): boolean {
    return this.getSecret("llm.apiKey") !== null;
  }

  // --- private helpers ---

  private loadSettings(): AppSettings {
    if (!existsSync(this.settingsPath)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const raw = readFileSync(this.settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as any;
      return {
        llm: { ...DEFAULT_SETTINGS.llm, ...parsed.llm },
        chat: { ...DEFAULT_SETTINGS.chat, ...parsed.chat },
        webSearch: { ...DEFAULT_SETTINGS.webSearch, ...parsed.webSearch },
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
