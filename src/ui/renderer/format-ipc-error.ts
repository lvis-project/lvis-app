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
  // ── Trust / intent gate (PR #826 cross-cutting code group) ──
  "user-keyboard-required": "이 권한 변경은 활성 사용자 입력에서만 실행할 수 있습니다.",
  "unauthorized": "권한이 없습니다.",
  // "unauthorized-frame" lives below in the frame-trust gate section with a
  // more actionable Korean message ("창을 새로고침하거나..."). Single key.
  "missing-input-origin": "요청의 출처 정보가 누락되었습니다.",
  "cross-plugin-call-denied": "다른 플러그인을 직접 호출할 수 없습니다.",
  "missing-plugin-envelope": "플러그인 envelope 정보가 누락되었습니다.",
  "assistant-context-origin-restricted": "이 어시스턴트 컨텍스트는 현재 출처에서 사용할 수 없습니다.",
  "role-prompt-origin-restricted": "역할 프롬프트는 사용자 입력 출처에서만 변경할 수 있습니다.",
  "persona-prompt-origin-restricted": "Persona 프롬프트는 사용자 입력 출처에서만 변경할 수 있습니다.",

  // ── Permission manager / audit state ──
  "no-permission-manager": "권한 매니저가 아직 초기화되지 않았습니다. 잠시 후 다시 시도해주세요.",
  "permission-audit-not-ready": "감사 로그가 준비되지 않았습니다.",
  "permission-audit-write-failed": "감사 로그 기록에 실패했습니다.",
  "audit-chain-not-initialized": "감사 체인이 초기화되지 않았습니다.",
  "no-deferred-queue": "지연 승인 큐가 활성화되지 않았습니다.",
  "managed": "관리자 정책에 의해 변경이 차단되었거나 저장 중 오류가 발생했습니다.",
  "durable-mode-denied": "현재 모드에서는 영구 변경이 허용되지 않습니다.",
  "missing-durable-confirm": "영구 모드 변경에는 사용자 확인이 필요합니다.",

  // ── Payload / validation ──
  "invalid-payload": "잘못된 요청 형식입니다.",
  "invalid-params": "잘못된 요청 파라미터입니다.",
  "invalid-input": "잘못된 입력입니다.",
  "invalid-value": "잘못된 값입니다.",
  "invalid-format": "요청 형식이 올바르지 않습니다.",
  "invalid-method": "허용되지 않은 메서드입니다.",
  "invalid-event-type": "허용되지 않은 이벤트 타입입니다.",
  "invalid-index": "잘못된 인덱스 값입니다.",
  "index-out-of-range": "인덱스가 범위를 벗어났습니다.",
  "invalid-text": "잘못된 텍스트 입력입니다.",
  "empty-text": "텍스트가 비어 있습니다.",
  "empty": "값이 비어 있습니다.",
  "content-too-large": "요청한 내용이 허용 크기를 초과했습니다.",
  "invalid-content": "내용 형식이 올바르지 않습니다.",
  "missing-tokens": "토큰 정보가 누락되었습니다.",

  // ── Args / canonicalization ──
  "args-not-object": "도구 인자는 객체여야 합니다.",
  "args-not-json": "도구 인자가 올바른 JSON 형식이 아닙니다.",
  "invalid-args": "잘못된 도구 인자입니다.",

  // ── Permission rule / approval validation ──
  "invalid-pattern": "패턴이 올바르지 않습니다.",
  "invalid-action": "허용되지 않은 동작입니다.",
  "invalid-mode": "허용되지 않은 모드 값입니다.",
  "invalid-patch": "허용되지 않은 변경 요청입니다.",
  "invalid-key": "유효하지 않은 키입니다.",
  "invalid-shell": "허용되지 않은 셸 입력입니다.",
  "invalid-slug": "허용되지 않은 식별자입니다.",
  "parse-error": "명령을 해석할 수 없습니다.",
  "high-requires-session-scope": "HIGH 수준 승인은 세션 범위에서만 사용 가능합니다.",
  "high-requires-justification": "HIGH 수준 승인은 사유 입력이 필요합니다.",
  "add-failed": "규칙 추가에 실패했습니다.",
  "remove-failed": "규칙 삭제에 실패했습니다.",

  // ── Deferred queue lifecycle ──
  "not-found": "요청한 항목을 찾을 수 없습니다.",
  "no-such-request": "처리할 승인 요청을 찾을 수 없습니다.",
  "not-registered": "등록되지 않은 항목입니다.",
  "already-resolved": "이미 처리된 항목입니다.",
  "already-resolving": "이미 처리 중인 항목입니다.",

  // ── Assistant context / role / memory / routine ──
  "invalid-assistant-context": "잘못된 어시스턴트 컨텍스트입니다.",
  "invalid-assistant-context-menu": "잘못된 어시스턴트 컨텍스트 메뉴 요청입니다.",
  "invalid-assistant-agent": "잘못된 어시스턴트 에이전트입니다.",
  "invalid-assistant-skill": "잘못된 어시스턴트 스킬입니다.",
  "invalid-assistant-skills": "잘못된 어시스턴트 스킬 목록입니다.",
  "invalid-role-prompt": "잘못된 역할 프롬프트입니다.",
  "invalid-persona-prompt": "잘못된 Persona 프롬프트입니다.",
  "invalid-persona-prompt-id": "잘못된 Persona 프롬프트 ID입니다.",
  "persona-prompt-not-found": "선택한 Persona 프롬프트를 찾을 수 없습니다.",
  "invalid-memory-sections": "잘못된 메모리 섹션 정보입니다.",
  "routine-not-found": "루틴을 찾을 수 없습니다.",
  "no-user-message": "사용자 메시지를 찾을 수 없습니다.",
  "last-message-not-user": "마지막 메시지가 사용자 질문이 아니어서 이어서 생성할 수 없습니다.",
  "no-scheduler": "스케줄러가 활성화되지 않았습니다.",

  // ── Plugin / marketplace / bundle ──
  "plugin-not-loaded": "플러그인이 로드되지 않았습니다.",
  "unknown-plugin-id": "알 수 없는 플러그인 ID입니다.",
  "invalid-bundle-id": "잘못된 번들 ID입니다.",
  "invalid-entry-url": "잘못된 entry URL입니다.",
  "entry-url-outside-install-root": "entry URL이 설치 경로를 벗어났습니다.",
  "install-failed": "플러그인 설치에 실패했습니다.",
  "uninstall-failed": "플러그인 제거에 실패했습니다.",
  "marketplace-disabled": "마켓플레이스 기능이 비활성화되었습니다.",
  // Frame-trust gate (used by chat.ts + plugins.ts pluginConfigError helper).
  // The plain "unauthorized" entry above already maps to "권한이 없습니다." but
  // "unauthorized-frame" carries a distinct semantic (the *frame/window* failed
  // the trust check, not the user's role) that the user can act on differently:
  // refresh the window or restart the app. Keep both keys with distinct
  // wording so the surfaced Korean message preserves that signal.
  "unauthorized-frame": "인증되지 않은 프레임에서의 요청입니다. 창을 새로고침하거나 앱을 다시 시작해 주세요.",
  // ── Legacy snake_case codes (src/ipc/domains/attach.ts) ──
  // These predate the kebab-case convention. New code MUST use kebab-case
  // (#803 IPC convention). The snake_case shape is grandfathered until the
  // attach.ts handlers are rewritten (tracked in follow-up).
  "path_not_authorized": "허용되지 않은 경로입니다.",
  "not_image": "이미지 파일이 아닙니다.",
  "invalid_payload": "잘못된 요청 형식입니다.",
  "denied_extension": "허용되지 않은 파일 확장자입니다.",
  "no-store": "저장소를 사용할 수 없습니다.",
  "no-starred-store": "즐겨찾기 저장소를 사용할 수 없습니다.",
  "no-session-todo-store": "세션 TO-DO 저장소를 사용할 수 없습니다.",
  // ── #893 Auth mockup login ──
  "invalid-credentials": "아이디 또는 비밀번호가 올바르지 않습니다.",
  "invalid-vendor": "지원하지 않는 벤더입니다.",
  "no-demo-key": "이 벤더의 데모 API 키가 환경 변수에 설정되어 있지 않습니다.",
  "reviewer-rewire-failed": "권한 검토 모델을 새 설정으로 연결하지 못했습니다. 설정이 이전 상태로 되돌려졌습니다.",
  // v0.2.1 hotfix — Step 2 (llm-key-issuing) try/catch surfaces this
  // when setSecret / patch fails (disk full, Keychain locked, etc.).
  // The "sandbox 준비 중" transcript fail in the user-reported repro
  // was previously bubbling through as the generic "로그인 처리 중
  // 오류" toast because the IPC promise rejected unhandled.
  "llm-key-issuing-failed": "LLM 키 저장 중 오류가 발생했어요. 디스크 권한 또는 Keychain 상태를 확인해주세요.",
  // ── Demo activation (lvis:demo:activate — 2026-05-19) ──
  // The LoginModal carries its own activationErrorMessage() that prefers
  // a longer "활성 코드..." string with paste instructions. These default
  // mappings exist for callers that surface IPC errors generically via
  // formatIpcError() (e.g. inline error toasts).
  "invalid-code": "활성 코드가 올바르지 않습니다.",
  "no-vendor": "활성 코드에 vendor 정보가 누락되었습니다.",
  "missing-foundry-endpoint": "활성 코드에 Azure Foundry 엔드포인트 정보가 누락되었습니다.",
  "persist-failed": "활성 코드를 저장하지 못했습니다.",
  "not-armed": "재시작 준비 상태가 아닙니다. 활성 코드를 다시 제출해 주세요.",
  // 2026-05-20 — Settings 로그아웃 path (`lvis:demo:clear`) 의 디스크 삭제 실패.
  "clear-failed": "데모 자격증명 삭제에 실패했습니다. 다시 시도해 주세요.",
  // ── Tutorial-C — tour:{start,mark-complete,dismiss} validation ──
  "invalid-scenario-id": "선택한 가이드 투어 항목이 올바르지 않습니다.",
  "write-failed": "설정을 저장하지 못했습니다.",
  // ── Audit demo throttle (pre-existing in audit.ts) ──
  "rate-limited": "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.",

  // ── Misc IO / system ──
  "no-window": "현재 창을 찾을 수 없습니다. 앱을 다시 시작해 주세요.",
  "invalid-request-id": "잘못된 요청 ID입니다.",
  "invalid-webcontents-id": "잘못된 webContents ID입니다.",
  "invalid-foundry-endpoint": "잘못된 Foundry 엔드포인트입니다.",
  "open-failed": "열기에 실패했습니다.",
  "checkpoint-not-found": "체크포인트를 찾을 수 없습니다.",
  "session-mismatch": "세션이 일치하지 않습니다.",
  "no-host-file-scan-protocol": "호스트 파일 스캔 프로토콜이 활성화되지 않았습니다.",
  "preference-refresh-service-unavailable": "설정 새로고침 서비스를 사용할 수 없습니다.",
  "production-disabled": "프로덕션 환경에서는 사용할 수 없습니다.",
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
