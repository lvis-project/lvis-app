



import { t } from "../../i18n/index.js";

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
      userMessage: t("be_errorClassifier.invalidApiKey"),
      rawError: raw,
    };
  }



  if (/rate_limit|429|too many requests|requests per minute|tokens per minute|tpm|rpm|request too large|too large for/.test(lower)) {
    return {
      category: "rate-limit",
      userMessage: t("be_errorClassifier.rateLimitExceeded"),
      rawError: raw,
    };
  }

  if (/context_length|too many tokens|413|context window/.test(lower)) {
    return {
      category: "context-length",
      userMessage: t("be_errorClassifier.contextLengthExceeded"),
      rawError: raw,
    };
  }

  if (/model_not_found|404|invalid_model/.test(lower)) {
    return {
      category: "model",
      userMessage: t("be_errorClassifier.modelNotFound"),
      rawError: raw,
    };
  }

  if (/fetch|econnrefused|enotfound|timeout/.test(lower)) {
    return {
      category: "network",
      userMessage: t("be_errorClassifier.networkError"),
      rawError: raw,
    };
  }

  return {
    category: "unknown",
    userMessage: t("be_errorClassifier.unknownError", { raw }),
    rawError: raw,
  };
}
