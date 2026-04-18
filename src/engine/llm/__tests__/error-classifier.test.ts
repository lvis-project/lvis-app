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
});
