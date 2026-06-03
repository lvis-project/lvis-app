// AUTO-GENERATED — i18n migration. Source: src/engine/llm/error-classifier.ts. Do not edit by hand.
export const en = {
  "be_errorClassifier.invalidApiKey":
    "API key is invalid or expired. Please check your settings.",
  "be_errorClassifier.rateLimitExceeded":
    "Per-minute rate limit exceeded — please retry shortly. Check provider diagnostics for specific limits and retry timing.",
  "be_errorClassifier.contextLengthExceeded":
    "Conversation context exceeds the model's maximum input limit — auto-compaction or a new conversation is required.",
  "be_errorClassifier.modelNotFound":
    "The selected model could not be found. Please check the model in your settings.",
  "be_errorClassifier.networkError":
    "Network connection error.",
  "be_errorClassifier.unknownError":
    "An error occurred: {raw}",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_errorClassifier.invalidApiKey":
    "API 키가 유효하지 않거나 만료되었습니다. 설정에서 확인해주세요.",
  "be_errorClassifier.rateLimitExceeded":
    "분당 처리 한도 초과 — 잠시 후 재시도하세요. 세부 한도와 재시도 시점은 provider diagnostics 를 확인하세요.",
  "be_errorClassifier.contextLengthExceeded":
    "대화 컨텍스트가 모델의 최대 입력 한도를 넘었습니다 — 자동 압축 또는 새 대화가 필요합니다.",
  "be_errorClassifier.modelNotFound":
    "선택한 모델을 찾을 수 없습니다. 설정에서 모델을 확인해주세요.",
  "be_errorClassifier.networkError":
    "네트워크 연결 문제입니다.",
  "be_errorClassifier.unknownError":
    "오류가 발생했습니다: {raw}",
};
