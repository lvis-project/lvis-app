/**
 * MsGraphService — Microsoft Graph OAuth 토큰 중앙 관리 서비스
 *
 * 이메일·캘린더 등 MS Graph를 쓰는 모든 플러그인이 하나의 토큰을 공유.
 * MSAL PublicClientApplication을 싱글톤으로 유지하고
 * <userData>/ms-graph-token.json 에 토큰을 영속화(Electron safeStorage 암호화).
 * userData 경로는 생성자에서 주입 (boot.ts: app.getPath("userData")).
 */

import { safeStorage } from "electron";
import { PublicClientApplication } from "@azure/msal-node";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const CLIENT_ID = "1d74a3f8-4c0f-473f-8d8d-e64efea32355";
const AUTHORITY = "https://login.microsoftonline.com/common";

/** 앱 전체에서 공유하는 MS Graph 스코프 */
export const MS_GRAPH_SCOPES = [
  "Mail.Read",
  "Mail.Send",
  "User.Read",
  "Calendars.ReadWrite",
  "offline_access",
];

interface SavedToken {
  accessToken: string;
  expiry: string;
  account: string;
}

type AuthChangeHandler = () => void;

export class MsGraphService {
  private readonly tokenPath: string;
  private readonly pca: PublicClientApplication;

  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private accountName: string | null = null;
  private authInProgress: Promise<void> | null = null;
  private pendingSilentRefresh: Promise<string | null> | null = null;
  private changeHandlers: AuthChangeHandler[] = [];
  private authExpiredHandlers: AuthChangeHandler[] = [];

  constructor(lvisRoot: string) {
    this.tokenPath = resolve(lvisRoot, "ms-graph-token.json");
    this.pca = new PublicClientApplication({
      auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    });
  }

  /** 앱 시작 시 저장된 토큰 로드 */
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
        accessToken = safeStorage.decryptString(Buffer.from(saved.accessToken, "base64"));
      } else {
        // Encrypted but safeStorage unavailable (e.g. different keychain) — skip
        return;
      }

      this.accessToken = accessToken;
      this.tokenExpiry = expiry;
      this.accountName = saved.account;
      console.log(`[ms-graph] 저장된 토큰 로드 — ${this.accountName}`);
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
   *
   * Sprint 4-D T1: 캐시된 토큰이 만료되었거나 없으면 MSAL 의 내부 캐시에 저장된
   * refresh token 을 이용해 `acquireTokenSilent` 로 조용히 갱신한다.
   * - 갱신 성공: 새 토큰 캐시 + 반환
   * - `InteractionRequired` 류 실패 (refresh token 만료 등): `ms-graph.auth.expired`
   *   핸들러 통지 + null 반환 (호출측이 `startMsGraphAuth` 유도)
   * - 일시적 네트워크 오류: null 반환 (expired 통지 X — 다음 호출에서 재시도)
   *
   * 동시 호출은 단일 in-flight promise 로 코얼레스 (thundering herd 방지).
   */
  async getAccessToken(): Promise<string | null> {
    if (this.isAuthenticated()) return this.accessToken;

    // 이미 진행 중인 silent refresh 가 있으면 합류
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
      // 저장된 계정 없음 → 인터랙티브 로그인 필요
      return null;
    }

    try {
      const result = await this.pca.acquireTokenSilent({
        scopes: MS_GRAPH_SCOPES,
        account,
      });
      if (!result || !result.accessToken || !result.expiresOn) {
        return null;
      }
      const accountId =
        result.account?.username ?? result.account?.name ?? this.accountName ?? "Unknown";
      await this.persistToken(result.accessToken, result.expiresOn, accountId);
      console.log(`[ms-graph] silent refresh 성공 — ${accountId}`);
      this.notifyChange();
      return result.accessToken;
    } catch (err) {
      // MSAL 은 refresh token 만료 / 사용자 재동의 필요 등은 InteractionRequiredAuthError
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

  /** 브라우저 기반 인터랙티브 인증 시작 */
  async startInteractiveAuth(openBrowser: (url: string) => Promise<void>): Promise<void> {
    if (this.authInProgress) return this.authInProgress;

    this.authInProgress = this.pca
      .acquireTokenInteractive({
        scopes: MS_GRAPH_SCOPES,
        openBrowser,
        successTemplate: `
          <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0b1222;color:#e2e8f0">
            <h2 style="color:#60a5fa">인증 완료!</h2>
            <p>이 창을 닫고 앱으로 돌아가세요.</p>
          </body></html>`,
        errorTemplate: `
          <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0b1222;color:#e2e8f0">
            <h2 style="color:#f87171">인증 실패</h2>
            <p>다시 시도해주세요.</p>
          </body></html>`,
      })
      .then(async (result: { accessToken: string; expiresOn: Date | null; account?: { username?: string; name?: string } | null } | null) => {
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

  /** 인증 상태 변경 구독 */
  onAuthChange(handler: AuthChangeHandler): void {
    this.changeHandlers.push(handler);
  }

  /**
   * Sprint 4-D T1: silent refresh 가 `InteractionRequired` 로 실패했을 때
   * (refresh token 만료 → 사용자 재로그인 필요) 호출되는 핸들러 등록.
   * 렌더러 측 `ms-graph.auth.expired` 배너 트리거 지점.
   */
  onAuthExpired(handler: AuthChangeHandler): void {
    this.authExpiredHandlers.push(handler);
  }

  private async persistToken(token: string, expiry: Date, account: string): Promise<void> {
    this.accessToken = token;
    this.tokenExpiry = expiry;
    this.accountName = account;

    let tokenToStore: string;
    if (safeStorage.isEncryptionAvailable()) {
      tokenToStore = safeStorage.encryptString(token).toString("base64");
    } else {
      // 암호화 불가 환경 — 평문 저장 (개발 환경 등)
      tokenToStore = `plain:${token}`;
    }

    await mkdir(dirname(this.tokenPath), { recursive: true });
    await writeFile(
      this.tokenPath,
      JSON.stringify({ accessToken: tokenToStore, expiry: expiry.toISOString(), account }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
    console.log(`[ms-graph] 토큰 저장 완료 — ${account}`);
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
