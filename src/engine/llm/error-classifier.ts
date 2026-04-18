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

  if (/context_length|too many tokens|413/.test(lower)) {
    return {
      category: "context-length",
      userMessage: "대화가 너무 길어 압축이 필요합니다.",
      rawError: raw,
    };
  }

  if (/rate_limit|429|too many/.test(lower)) {
    return {
      category: "rate-limit",
      userMessage: "잠시 후 다시 시도해주세요 (모델 요청 한도).",
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
