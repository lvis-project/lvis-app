/**
 * MsGraphService — Microsoft Graph OAuth 토큰 중앙 관리 서비스
 *
 * 이메일·캘린더 등 MS Graph를 쓰는 모든 플러그인이 하나의 토큰을 공유.
 * MSAL PublicClientApplication을 싱글톤으로 유지하고
 * <userData>/ms-graph-token-{env}.json 에 환경별로 토큰을 영속화 (Electron safeStorage 암호화).
 *
 * 환경 (external / corporate) 별로 **별도 app registration + 별도 token cache** 를 쓴다.
 * Active 환경이 HostApi 에 노출되며, `switchEnvironment()` 로 런타임 전환 가능.
 * 전환 시 이전 환경 토큰 파일은 그대로 남으므로 되돌릴 때 재로그인 없이 복구.
 *
 * 환경 설정은 `ms-graph-auth-config.ts` 에서 관리 — 사내 IT 로부터 받은 corp
 * client/tenant ID 를 거기서 교체.
 */

import { safeStorage } from "electron";
import { PublicClientApplication } from "@azure/msal-node";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  DEFAULT_MS_GRAPH_ENVIRONMENT,
  DEFAULT_MS_GRAPH_SCOPES,
  MS_GRAPH_ENVIRONMENT_CONFIGS,
  getEnvironmentConfig,
  isEnvironmentConfigured,
  normalizeEnvironment,
  type MsGraphEnvironment,
  type MsGraphEnvironmentConfig,
} from "./ms-graph-auth-config.js";

/**
 * 기본 스코프 상수.
 *
 * @deprecated 환경별 스코프는 `getEnvironmentConfig(env).scopes` 에서 읽을 것.
 * 기존 호출부 호환을 위해 re-export 유지.
 */
export const MS_GRAPH_SCOPES = DEFAULT_MS_GRAPH_SCOPES;

export type { MsGraphEnvironment } from "./ms-graph-auth-config.js";

interface SavedToken {
  accessToken: string;
  expiry: string;
  account: string;
}

type AuthChangeHandler = () => void;

export interface MsGraphServiceState {
  environment: MsGraphEnvironment;
  isAuthenticated: boolean;
  account: string | null;
  configured: boolean;
  label: string;
}

export class MsGraphService {
  private readonly lvisRoot: string;

  private environment: MsGraphEnvironment;
  private config: MsGraphEnvironmentConfig;
  private tokenPath: string;
  private pca: PublicClientApplication;

  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private accountName: string | null = null;
  private authInProgress: Promise<void> | null = null;
  private pendingSilentRefresh: Promise<string | null> | null = null;
  private changeHandlers: AuthChangeHandler[] = [];
  private authExpiredHandlers: AuthChangeHandler[] = [];

  constructor(
    lvisRoot: string,
    environment: MsGraphEnvironment = DEFAULT_MS_GRAPH_ENVIRONMENT,
  ) {
    this.lvisRoot = lvisRoot;
    this.environment = normalizeEnvironment(environment);
    this.config = getEnvironmentConfig(this.environment);
    this.tokenPath = tokenPathFor(lvisRoot, this.environment);
    this.pca = createPca(this.config);
  }

  /** 현재 active 환경 */
  getEnvironment(): MsGraphEnvironment {
    return this.environment;
  }

  /** 현재 active 환경의 설정 정보 (UI 표시용) */
  getState(): MsGraphServiceState {
    return {
      environment: this.environment,
      isAuthenticated: this.isAuthenticated(),
      account: this.accountName,
      configured: isEnvironmentConfigured(this.environment),
      label: this.config.label,
    };
  }

  /**
   * 환경 전환. 이전 환경의 in-memory 토큰은 비우고, 새 환경의 저장된 토큰을
   * 로드한다. 전환 후에도 이전 환경 파일은 그대로 남아 되돌림 시 재로그인 불필요.
   *
   * 동일 환경 전환은 no-op. 미구성 환경(`__FILL_IN__` placeholder)으로 전환은
   * 허용하되 sign-in 시도 시점에 에러.
   */
  async switchEnvironment(next: MsGraphEnvironment): Promise<void> {
    const target = normalizeEnvironment(next);
    if (target === this.environment) return;
    console.log(
      `[ms-graph] environment switch: ${this.environment} → ${target}`,
    );

    // 진행 중 silent refresh / interactive auth 가 있어도 state 만 교체 —
    // 이전 PCA 의 in-flight promise 는 자연 소멸 (참조 끊어짐).
    this.environment = target;
    this.config = getEnvironmentConfig(target);
    this.tokenPath = tokenPathFor(this.lvisRoot, target);
    this.pca = createPca(this.config);
    this.accessToken = null;
    this.tokenExpiry = null;
    this.accountName = null;
    this.authInProgress = null;
    this.pendingSilentRefresh = null;

    await this.loadSavedToken();
    this.notifyChange();
  }

  /** 앱 시작 시 저장된 토큰 로드 (현재 active 환경에 한함) */
  async loadSavedToken(): Promise<void> {
    try {
      const raw = await readFile(this.tokenPath, "utf-8");
      const saved = JSON.parse(raw) as SavedToken;
      const expiry = new Date(saved.expiry);
      if (!saved.accessToken || expiry <= new Date()) return;

      let accessToken: string;
      if (saved.accessToken.startsWith("plain:")) {
        accessToken = saved.accessToken.slice(6);
      } else if (safeStorage.isEncryptionAvailable()) {
        accessToken = safeStorage.decryptString(
          Buffer.from(saved.accessToken, "base64"),
        );
      } else {
        return;
      }

      this.accessToken = accessToken;
      this.tokenExpiry = expiry;
      this.accountName = saved.account;
      console.log(
        `[ms-graph] 저장된 토큰 로드 [${this.environment}] — ${this.accountName}`,
      );
    } catch {
      // 없으면 무시
    }
  }

  isAuthenticated(): boolean {
    return !!this.accessToken && !!this.tokenExpiry && this.tokenExpiry > new Date();
  }

  getAccountName(): string | null {
    return this.accountName;
  }

  /**
   * 현재 유효한 액세스 토큰 반환.
   * 자세한 흐름은 `silentRefresh()` 주석 참조.
   */
  async getAccessToken(): Promise<string | null> {
    if (this.isAuthenticated()) return this.accessToken;
    if (this.pendingSilentRefresh) return this.pendingSilentRefresh;
    this.pendingSilentRefresh = this.silentRefresh().finally(() => {
      this.pendingSilentRefresh = null;
    });
    return this.pendingSilentRefresh;
  }

  /** MSAL refresh token 으로 조용히 갱신 시도 */
  private async silentRefresh(): Promise<string | null> {
    const cache = this.pca.getTokenCache();
    let account;
    try {
      const all = await cache.getAllAccounts();
      if (this.accountName) {
        account = all.find((a) => a.username === this.accountName);
      }
      if (!account) account = all[0];
    } catch (err) {
      console.warn("[ms-graph] silent refresh: account lookup failed —", err);
      return null;
    }
    if (!account) {
      return null;
    }

    try {
      const result = await this.pca.acquireTokenSilent({
        scopes: this.config.scopes,
        account,
      });
      if (!result || !result.accessToken || !result.expiresOn) {
        return null;
      }
      const accountId =
        result.account?.username ?? result.account?.name ?? this.accountName ?? "Unknown";
      await this.persistToken(result.accessToken, result.expiresOn, accountId);
      console.log(
        `[ms-graph] silent refresh 성공 [${this.environment}] — ${accountId}`,
      );
      this.notifyChange();
      return result.accessToken;
    } catch (err) {
      const name =
        (err as { name?: string } | null)?.name ??
        (err as { errorCode?: string } | null)?.errorCode ??
        "";
      const msg = (err as Error | null)?.message ?? "";
      const isInteractionRequired =
        name === "InteractionRequiredAuthError" ||
        /interaction_required|invalid_grant|no_tokens_found|no_account_found/i.test(
          `${name} ${msg}`,
        );
      if (isInteractionRequired) {
        console.warn("[ms-graph] silent refresh: 재인증 필요 —", msg || name);
        this.accessToken = null;
        this.tokenExpiry = null;
        this.notifyAuthExpired();
      } else {
        console.warn("[ms-graph] silent refresh: 일시적 실패 —", msg || name);
      }
      return null;
    }
  }

  /**
   * 브라우저 기반 인터랙티브 인증 시작.
   *
   * 현재 active 환경의 client/authority 로 로그인. 미구성 환경에선
   * 즉시 에러 throw — 사용자에게 "corp app 정보 먼저 등록하세요" 안내 의도.
   */
  async startInteractiveAuth(
    openBrowser: (url: string) => Promise<void>,
  ): Promise<void> {
    if (!isEnvironmentConfigured(this.environment)) {
      throw new Error(
        `MsGraph 환경 "${this.environment}" 이 아직 설정되지 않았습니다. ` +
          `src/main/ms-graph-auth-config.ts 에 app 등록 정보를 입력해주세요.`,
      );
    }
    if (this.authInProgress) return this.authInProgress;

    this.authInProgress = this.pca
      .acquireTokenInteractive({
        scopes: this.config.scopes,
        openBrowser,
        successTemplate: `
          <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0b1222;color:#e2e8f0">
            <h2 style="color:#60a5fa">인증 완료! (${this.config.label})</h2>
            <p>이 창을 닫고 앱으로 돌아가세요.</p>
          </body></html>`,
        errorTemplate: `
          <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0b1222;color:#e2e8f0">
            <h2 style="color:#f87171">인증 실패</h2>
            <p>다시 시도해주세요.</p>
          </body></html>`,
      })
      .then(async (result) => {
        if (!result) return;
        if (!result.expiresOn) {
          throw new Error("Interactive authentication did not return a token expiry.");
        }
        const account = result.account?.username ?? result.account?.name ?? "Unknown";
        await this.persistToken(result.accessToken, result.expiresOn, account);
        this.notifyChange();
      })
      .finally(() => {
        this.authInProgress = null;
      })
      .then(() => {});

    return this.authInProgress!;
  }

  /**
   * 현재 active 환경에서 로그아웃. MSAL token cache + 로컬 token 파일 모두 제거.
   * 다른 환경의 토큰/캐시는 건드리지 않음.
   */
  async signOut(): Promise<void> {
    try {
      const cache = this.pca.getTokenCache();
      const accounts = await cache.getAllAccounts();
      for (const acc of accounts) {
        await cache.removeAccount(acc);
      }
    } catch (err) {
      console.warn("[ms-graph] signOut: MSAL 캐시 제거 실패 —", err);
    }
    this.accessToken = null;
    this.tokenExpiry = null;
    this.accountName = null;
    try {
      await writeFile(this.tokenPath, "", { encoding: "utf-8", mode: 0o600 });
    } catch {
      // 파일 없으면 무시
    }
    console.log(`[ms-graph] 로그아웃 완료 [${this.environment}]`);
    this.notifyChange();
  }

  /** 인증 상태 변경 구독 */
  onAuthChange(handler: AuthChangeHandler): void {
    this.changeHandlers.push(handler);
  }

  onAuthExpired(handler: AuthChangeHandler): void {
    this.authExpiredHandlers.push(handler);
  }

  private async persistToken(
    token: string,
    expiry: Date,
    account: string,
  ): Promise<void> {
    this.accessToken = token;
    this.tokenExpiry = expiry;
    this.accountName = account;

    let tokenToStore: string;
    if (safeStorage.isEncryptionAvailable()) {
      tokenToStore = safeStorage.encryptString(token).toString("base64");
    } else {
      tokenToStore = `plain:${token}`;
    }

    await mkdir(dirname(this.tokenPath), { recursive: true });
    await writeFile(
      this.tokenPath,
      JSON.stringify(
        { accessToken: tokenToStore, expiry: expiry.toISOString(), account },
        null,
        2,
      ),
      { encoding: "utf-8", mode: 0o600 },
    );
    console.log(
      `[ms-graph] 토큰 저장 완료 [${this.environment}] — ${account}`,
    );
  }

  private notifyChange(): void {
    for (const h of this.changeHandlers) {
      try { h(); } catch { /* ignore */ }
    }
  }

  private notifyAuthExpired(): void {
    for (const h of this.authExpiredHandlers) {
      try { h(); } catch { /* ignore */ }
    }
  }
}

function tokenPathFor(lvisRoot: string, env: MsGraphEnvironment): string {
  return resolve(lvisRoot, `ms-graph-token-${env}.json`);
}

function createPca(cfg: MsGraphEnvironmentConfig): PublicClientApplication {
  return new PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: cfg.authority,
    },
  });
}

/** Test/boot helper — 기존 토큰 파일 (환경 분리 전) 의 migration 경로. */
export function legacyTokenPath(lvisRoot: string): string {
  return resolve(lvisRoot, "ms-graph-token.json");
}

// Re-export config utilities for callers that need environment metadata.
export {
  MS_GRAPH_ENVIRONMENT_CONFIGS,
  isEnvironmentConfigured,
  getEnvironmentConfig,
  normalizeEnvironment,
} from "./ms-graph-auth-config.js";
