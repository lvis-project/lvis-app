/**
 * Provider Error Classifier — LLM 오류를 사용자 친화적 메시지로 변환
 */

export type ErrorCategory =
  | "api-key"
  | "rate-limit"
  | "context-length"
  | "model"
  | "network"
  | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  userMessage: string;
  rawError: string;
}

export function classifyProviderError(raw: string): ClassifiedError {
  const lower = raw.toLowerCase();

  if (/api_key|authentication|401|403|unauthorized/.test(lower)) {
    return {
      category: "api-key",
      userMessage: "API 키가 유효하지 않거나 만료되었습니다. 설정에서 확인해주세요.",
      rawError: raw,
    };
  }

  // Order matters: rate-limit FIRST. OpenAI 의 "Request too large for ...
  // Limit 200,000, Requested 271,630" (TPM 초과) 메시지가 context-length
  // 패턴의 "too many tokens" 에 잘못 매치되면 원인 분리가 흐려진다.
  // reactive auto-compact 여부는 provider error diagnostics 의
  // rate_limit_exceeded + tokens-per-minute code path 에서 결정한다.
  if (/rate_limit|429|too many requests|requests per minute|tokens per minute|tpm|rpm|request too large|too large for/.test(lower)) {
    return {
      category: "rate-limit",
      userMessage: "분당 처리 한도 초과 — 잠시 후 재시도하세요. 세부 한도와 재시도 시점은 provider diagnostics 를 확인하세요.",
      rawError: raw,
    };
  }

  if (/context_length|too many tokens|413|context window/.test(lower)) {
    return {
      category: "context-length",
      userMessage: "대화 컨텍스트가 모델의 최대 입력 한도를 넘었습니다 — 자동 압축 또는 새 대화가 필요합니다.",
      rawError: raw,
    };
  }

  if (/model_not_found|404|invalid_model/.test(lower)) {
    return {
      category: "model",
      userMessage: "선택한 모델을 찾을 수 없습니다. 설정에서 모델을 확인해주세요.",
      rawError: raw,
    };
  }

  if (/fetch|econnrefused|enotfound|timeout/.test(lower)) {
    return {
      category: "network",
      userMessage: "네트워크 연결 문제입니다.",
      rawError: raw,
    };
  }

  return {
    category: "unknown",
    userMessage: `오류가 발생했습니다: ${raw}`,
    rawError: raw,
  };
}
