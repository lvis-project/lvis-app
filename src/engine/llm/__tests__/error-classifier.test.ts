import { describe, it, expect } from "vitest";
import { classifyProviderError } from "../error-classifier.js";

describe("classifyProviderError", () => {
  it("classifies api_key error", () => {
    const result = classifyProviderError("401 Unauthorized: invalid api_key");
    expect(result.category).toBe("api-key");
    expect(result.userMessage).toContain("API 키");
  });

  it("classifies rate_limit error", () => {
    const result = classifyProviderError("429 Too Many Requests: rate_limit exceeded");
    expect(result.category).toBe("rate-limit");
    expect(result.userMessage).toContain("잠시 후");
  });

  it("classifies context_length error", () => {
    const result = classifyProviderError("context_length exceeded: too many tokens in input");
    expect(result.category).toBe("context-length");
    expect(result.userMessage).toContain("압축");
  });

  it("classifies model_not_found error", () => {
    const result = classifyProviderError("404 model_not_found: invalid_model specified");
    expect(result.category).toBe("model");
    expect(result.userMessage).toContain("모델");
  });

  it("classifies network error", () => {
    const result = classifyProviderError("fetch failed: ECONNREFUSED 127.0.0.1:443");
    expect(result.category).toBe("network");
    expect(result.userMessage).toContain("네트워크");
  });

  it("classifies unknown error", () => {
    const result = classifyProviderError("some unexpected internal error");
    expect(result.category).toBe("unknown");
    expect(result.userMessage).toContain("some unexpected internal error");
    expect(result.rawError).toBe("some unexpected internal error");
  });

  it("returns the raw error string unchanged", () => {
    const raw = "authentication failed with 403";
    const result = classifyProviderError(raw);
    expect(result.rawError).toBe(raw);
  });

  // Regression lock — issue #900. OpenAI 의 "Request too large for ...
  // Limit 200,000, Requested 271,630" (TPM 초과) 메시지가 *대화 길이*
  // 가 아닌 *분당 처리량* 한도라 자동 압축으로 해결 안 됨. 기존 분류
  // 가 context-length 의 "too many tokens" 패턴에 잘못 매치되던 회귀.
  describe("issue #900 — TPM rate-limit vs context-length distinction", () => {
    it("OpenAI 'Request too large' (TPM 형식) classifies as rate-limit, NOT context-length", () => {
      const raw = "Request too large for gpt-5.4-nano in organization org-xxx on tokens per minute (TPM): Limit 200000, Requested 271630.";
      const result = classifyProviderError(raw);
      expect(result.category).toBe("rate-limit");
      expect(result.userMessage).toContain("TPM");
      expect(result.userMessage).toContain("자동 압축으로 해결되지 않습니다");
    });

    it("'tokens per minute' phrase alone classifies as rate-limit", () => {
      expect(classifyProviderError("error: tokens per minute exceeded").category).toBe("rate-limit");
    });

    it("'requests per minute' (RPM) also classifies as rate-limit", () => {
      expect(classifyProviderError("error: requests per minute limit hit").category).toBe("rate-limit");
    });

    it("genuine 'context_length exceeded' still classifies as context-length", () => {
      const result = classifyProviderError("context_length_exceeded: prompt too long for model context window");
      expect(result.category).toBe("context-length");
      expect(result.userMessage).toContain("자동 압축 또는 새 대화");
    });
  });
});
