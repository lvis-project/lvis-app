/**
 * SOT IPC error → Korean i18n mapper (issue #830).
 *
 * Renderer-side counterpart to the "IPC layer = English, UI layer = Korean"
 * convention (CLAUDE.md "IPC Error Message Language Convention"). All
 * renderer callers that receive an IPC `{ok:false, error, message}`
 * envelope should pipe it through this helper instead of writing per-
 * callsite formatters that drift and miss new codes.
 *
 * Design:
 * - `COMMON_IPC_ERROR_MESSAGES` carries default Korean mappings for codes
 *   shared across multiple IPC domains (intent gate, payload validation,
 *   permission manager state).
 * - Per-context overrides ride on the `codeMap` option (e.g. revoke
 *   uses "유효하지 않은 승인 키" but generic `invalid-key` callers get
 *   "유효하지 않은 키").
 * - Dynamic code patterns (e.g. `reviewer-rewire-failed:<detail>`) are
 *   handled by the caller *before* invoking this helper.
 */

export const COMMON_IPC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "user-keyboard-required": "이 권한 변경은 활성 사용자 입력에서만 실행할 수 있습니다.",
  "no-permission-manager": "권한 매니저가 아직 초기화되지 않았습니다. 잠시 후 다시 시도해주세요.",
  "invalid-key": "유효하지 않은 키입니다.",
  "invalid-payload": "잘못된 요청 형식입니다.",
  "args-not-object": "도구 인자는 객체여야 합니다.",
  "args-not-json": "도구 인자가 올바른 JSON 형식이 아닙니다.",
  "invalid-pattern": "패턴이 올바르지 않습니다.",
  "invalid-action": "허용되지 않은 동작입니다.",
  "invalid-mode": "허용되지 않은 모드 값입니다.",
  "invalid-patch": "허용되지 않은 변경 요청입니다.",
  "parse-error": "명령을 해석할 수 없습니다.",
  "missing-durable-confirm": "영구 모드 변경에는 사용자 확인이 필요합니다.",
  "high-requires-session-scope": "HIGH 수준 승인은 세션 범위에서만 사용 가능합니다.",
  "high-requires-justification": "HIGH 수준 승인은 사유 입력이 필요합니다.",
};

export interface FormatIpcErrorOptions {
  /**
   * Per-context code overrides (merged on top of common defaults). Use when
   * the same error code carries a domain-specific nuance — e.g. revoke
   * mapping `invalid-key` → "유효하지 않은 승인 키입니다."
   */
  codeMap?: Record<string, string>;
  /**
   * Optional Korean prefix for unrecognized codes (e.g. "리뷰어 오류").
   * Applied only when neither codeMap nor common defaults resolved a
   * mapping; the prefix is joined with the backend message or raw code.
   */
  fallbackContext?: string;
}

export function formatIpcError(
  error: string | undefined,
  message: string | undefined,
  opts: FormatIpcErrorOptions = {},
): string {
  if (error) {
    const override = opts.codeMap?.[error];
    if (override) return override;
    const common = COMMON_IPC_ERROR_MESSAGES[error];
    if (common) return common;
  }
  if (message && message.trim().length > 0) {
    return opts.fallbackContext ? `${opts.fallbackContext}: ${message}` : message;
  }
  const raw = error ?? "알 수 없는 오류";
  return opts.fallbackContext ? `${opts.fallbackContext}: ${raw}` : `${raw}가 발생했습니다.`;
}
