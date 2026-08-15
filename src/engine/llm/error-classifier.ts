



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

/**
 * Provider answers that mean "this REQUEST is malformed for me", as opposed to
 * "I am busy or degraded right now".
 *
 * The distinction matters wherever the host offers a retry: a request the
 * provider validated and refused is refused identically on every retry of the
 * same inputs, so retry guidance becomes a loop instead of a recovery. The
 * grammar entries are the self-hosted class (llama.cpp / vLLM / SGLang), which
 * compiles the tool schemas into a decoding grammar and fails the whole request
 * when one schema will not translate; the schema entries are the hosted-vendor
 * equivalent (strict-mode function-schema rejection).
 */
const DETERMINISTIC_REQUEST_REJECTION_RE =
  /failed to parse grammar|failed to initialize samplers|grammar error|json schema conversion failed|invalid[_ ]function[_ ]parameters|invalid schema for (?:function|tool)/i;

/**
 * True when `raw` is a provider rejection of the request itself — deterministic
 * for identical inputs, so re-sending the same request cannot succeed.
 *
 * Deliberately narrow: an unrecognized error stays "possibly transient", which
 * keeps retry available for the failures retrying actually fixes.
 */
export function isDeterministicProviderRequestRejection(raw: string): boolean {
  return DETERMINISTIC_REQUEST_REJECTION_RE.test(raw);
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
