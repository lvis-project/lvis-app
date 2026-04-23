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
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  /**
   * Sprint 4-E T2 race-guard: switchEnvironment() 이 호출될 때마다 +1.
   * silentRefresh / startInteractiveAuth 시작 시점에 스냅샷을 찍고, 결과
   * 콜백에서 epoch 가 바뀌어 있으면 persist 를 건너뛴다 — A env 에서 시작한
   * 토큰이 B env 파일에 기록되는 cross-env 오염을 막는다.
   */
  private envEpoch = 0;

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

    // Race guard — envEpoch 증가시키면 진행 중인 silentRefresh/auth 콜백이
    // 완료 시점에 `startEpoch !== this.envEpoch` 로 자기가 stale 임을 감지하고
    // persistToken 을 skip 한다 (아래 silentRefresh / startInteractiveAuth 참조).
    this.envEpoch += 1;
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

  /**
   * 앱 시작 시 저장된 토큰 로드 (현재 active 환경에 한함).
   *
   * Legacy migration: 환경 분리 이전 버전에서 `ms-graph-token.json` 이
   * 존재하고 external 환경이면서 새 파일(`ms-graph-token-external.json`)이
   * 아직 없다면, 기존 파일을 external 파일로 rename 해 재로그인 회귀를 막는다.
   */
  async loadSavedToken(): Promise<void> {
    if (
      this.environment === "external" &&
      !existsSync(this.tokenPath) &&
      existsSync(legacyTokenPath(this.lvisRoot))
    ) {
      try {
        await rename(legacyTokenPath(this.lvisRoot), this.tokenPath);
        console.log(
          `[ms-graph] legacy 토큰 파일 migration: ${legacyTokenPath(this.lvisRoot)} → ${this.tokenPath}`,
        );
      } catch (err) {
        console.warn(
          "[ms-graph] legacy 토큰 migration 실패 (non-fatal):",
          (err as Error).message,
        );
      }
    }

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
    // Sprint 4-E T2 race guard: PCA + scopes + epoch 를 같이 스냅샷 해서
    // account 조회 / acquireTokenSilent await 중 switchEnvironment 가 들어와도
    // 옛 env 의 config 로 끝까지 밀고간다. env 바뀌면 결과 폐기 (cross-env
    // scope mismatch 와 token 오염 둘 다 차단).
    const startEpoch = this.envEpoch;
    const startPca = this.pca;
    const startScopes = this.config.scopes;
    const cache = startPca.getTokenCache();
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
      const result = await startPca.acquireTokenSilent({
        scopes: startScopes,
        account,
      });
      if (!result || !result.accessToken || !result.expiresOn) {
        return null;
      }
      // Race guard — env 가 바뀌었으면 결과 폐기 (cross-env persist 방지).
      if (startEpoch !== this.envEpoch) {
        console.warn(
          "[ms-graph] silent refresh 결과 폐기: env 전환 감지 (stale token)",
        );
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

    // Same race-guard snapshot pattern as silentRefresh — PCA + scopes +
    // epoch + label 함께 고정. env 바뀌면 완료 콜백이 결과 폐기.
    const startEpoch = this.envEpoch;
    const startPca = this.pca;
    const startScopes = this.config.scopes;
    const startLabel = this.config.label;
    this.authInProgress = startPca
      .acquireTokenInteractive({
        scopes: startScopes,
        openBrowser,
        // MSAL 의 LoopbackClient 는 `res.end(template)` 만 호출하고 `Content-Type`
        // 헤더를 설정하지 않는다. 그 결과 브라우저가 HTML 인지 plain text 인지
        // 판단 못 해 `<meta charset="utf-8">` 선언을 무시 → Korean Windows 에서
        // UTF-8 한글이 cp949 로 해석되어 mojibake 발생.
        //
        // 두 가지 방어를 동시에 적용:
        //   1) ASCII-only 영문 + escape된 한글 numeric entity 로 작성해
        //      **소스 바이트를 전부 ASCII 로** 만든다 → 어떤 인코딩으로도 동일 렌더.
        //   2) `<meta charset>` 과 `<meta http-equiv="Content-Type">` 둘 다 둬
        //      브라우저 sniff 가 실패해도 회복 경로 확보.
        successTemplate: `<!doctype html>
          <html lang="ko"><head>
            <meta charset="utf-8" />
            <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
            <title>Login</title>
          </head>
          <body style="font-family:sans-serif;text-align:center;padding:60px;background:#0b1222;color:#e2e8f0">
            <h2 style="color:#60a5fa">Login Complete (${startLabel})</h2>
            <p>&#xC774; &#xCC3D;&#xC744; &#xB2EB;&#xACE0; &#xC571;&#xC73C;&#xB85C; &#xB3CC;&#xC544;&#xAC00;&#xC138;&#xC694;. (You may close this window.)</p>
          </body></html>`,
        errorTemplate: `<!doctype html>
          <html lang="ko"><head>
            <meta charset="utf-8" />
            <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
            <title>Login</title>
          </head>
          <body style="font-family:sans-serif;text-align:center;padding:60px;background:#0b1222;color:#e2e8f0">
            <h2 style="color:#f87171">Login Failed</h2>
            <p>&#xB2E4;&#xC2DC; &#xC2DC;&#xB3C4;&#xD574;&#xC8FC;&#xC138;&#xC694;. (Please try again.)</p>
          </body></html>`,
      })
      .then(async (result) => {
        if (!result) return;
        if (!result.expiresOn) {
          throw new Error("Interactive authentication did not return a token expiry.");
        }
        // Race guard — auth 진행 중 env 가 전환됐으면 결과 폐기.
        if (startEpoch !== this.envEpoch) {
          console.warn(
            "[ms-graph] interactive auth 결과 폐기: env 전환 감지 (stale token)",
          );
          return;
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
