/**
 * MsGraph Auth Config — 환경별 Azure AD app registration
 *
 * LVIS 는 2개 환경을 지원한다. 사용자가 Settings 에서 택1:
 *   - `external` : Microsoft 공용 엔드포인트. 개인 MS 계정 + multi-tenant.
 *     개발·해외망·비-LG 사용자를 위한 default.
 *   - `corporate`: LG Electronics 사내 테넌트. 사내 관리자가 등록한 전용 app.
 *     사내망 사용자가 SSO / Conditional Access 정책 하에 로그인.
 *
 * 두 환경은 **완전히 분리된 MSAL PublicClientApplication** 인스턴스를 쓰며
 * 토큰 파일도 별개 (`ms-graph-token-external.json` vs `-corporate.json`).
 * 환경 전환은 MsGraphService.switchEnvironment() 로 수행하며, 전환 직전 환경의
 * 토큰은 그대로 남지만 실제로 HostApi 가 노출하는 건 현재 active env 토큰 하나뿐.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔧 FILL-IN POINT — 사내 IT 운영자로부터 app 등록 정보를 받으면 아래
 * `corporate.clientId` 와 `corporate.authority` 를 실제 값으로 교체하세요.
 * `__FILL_IN__` placeholder 가 남아있는 한 `isEnvironmentConfigured("corporate")`
 * 가 false 를 리턴하고, UI 에서 해당 환경 선택을 disable + 안내 메시지 노출.
 * ──────────────────────────────────────────────────────────────────────────
 */

export type MsGraphEnvironment = "external" | "corporate";

export const MS_GRAPH_ENVIRONMENTS: readonly MsGraphEnvironment[] = [
  "external",
  "corporate",
] as const;

export const DEFAULT_MS_GRAPH_ENVIRONMENT: MsGraphEnvironment = "external";

export interface MsGraphEnvironmentConfig {
  /** Azure AD Application (client) ID */
  clientId: string;
  /**
   * MSAL authority URL.
   *   - external: `https://login.microsoftonline.com/common` (multi-tenant + personal)
   *   - corporate: `https://login.microsoftonline.com/{tenantId}` (LG tenant)
   */
  authority: string;
  /** OAuth scopes to request. Shared between environments by default. */
  scopes: string[];
  /** UI 에 보여줄 표시명 */
  label: string;
  /** UI 설명 */
  description: string;
}

/**
 * 모든 MS Graph 사용처가 공유하는 스코프.
 *
 * 이 PR 은 "dual-environment 스위처" 의 scope 만 담당하므로 scope 목록은
 * 기존 `MS_GRAPH_SCOPES` 와 동일하게 유지한다. 추가 권한 (Mail.ReadWrite,
 * Contacts.ReadWrite, Calendars.ReadWrite.Shared, Tasks.ReadWrite,
 * OnlineMeetings.ReadWrite, Presence.Read 등) 은 해당 플러그인 활성화 시점에
 * incremental consent 로 별도 요청하거나 separate PR 에서 확장.
 */
export const DEFAULT_MS_GRAPH_SCOPES: string[] = [
  "Mail.Read",
  "Mail.Send",
  "User.Read",
  "Calendars.ReadWrite",
  "offline_access",
];

// Corporate (LG Electronics) — LVIS Desktop Assistant app registration.
// AppName:     LVIS Desktop Assistant
// Client ID:   6c03089a-96c8-4515-bc01-4fd7a0936cea
// Directory:   5096cde4-642a-45c0-8094-d0c2dec10be3 (LG Electronics tenant)
// 수령일:      2026-04-23, IT 담당자 제공.
const CORP_CLIENT_ID = "6c03089a-96c8-4515-bc01-4fd7a0936cea";
const CORP_TENANT_ID = "5096cde4-642a-45c0-8094-d0c2dec10be3";

export const MS_GRAPH_ENVIRONMENT_CONFIGS: Record<
  MsGraphEnvironment,
  MsGraphEnvironmentConfig
> = {
  external: {
    clientId: "1d74a3f8-4c0f-473f-8d8d-e64efea32355",
    authority: "https://login.microsoftonline.com/common",
    scopes: DEFAULT_MS_GRAPH_SCOPES,
    label: "External",
    description:
      "Microsoft 공용 엔드포인트. 개인 Microsoft 계정 또는 타 조직 계정 로그인.",
  },
  corporate: {
    clientId: CORP_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${CORP_TENANT_ID}`,
    scopes: DEFAULT_MS_GRAPH_SCOPES,
    label: "Corporate (LG 사내망)",
    description:
      "LG Electronics 사내 테넌트 — LVIS Desktop Assistant (LG-SSO / CA 정책 적용).",
  },
};

export function getEnvironmentConfig(
  env: MsGraphEnvironment,
): MsGraphEnvironmentConfig {
  const cfg = MS_GRAPH_ENVIRONMENT_CONFIGS[env];
  if (!cfg) {
    throw new Error(`Unknown MsGraph environment: ${env}`);
  }
  return cfg;
}

/**
 * 해당 환경에 사용할 수 있는 실제 app 등록 정보가 채워져 있는지 판정.
 * Placeholder (`__FILL_IN_*__`) 가 남아있으면 false.
 */
export function isEnvironmentConfigured(env: MsGraphEnvironment): boolean {
  const cfg = MS_GRAPH_ENVIRONMENT_CONFIGS[env];
  if (!cfg) return false;
  if (!cfg.clientId || cfg.clientId.includes("__FILL_IN")) return false;
  if (!cfg.authority || cfg.authority.includes("__FILL_IN")) return false;
  return true;
}

/** Validator helper — env 문자열을 받아 안전하게 정규화. */
export function normalizeEnvironment(
  value: unknown,
): MsGraphEnvironment {
  if (value === "corporate" || value === "external") return value;
  return DEFAULT_MS_GRAPH_ENVIRONMENT;
}
