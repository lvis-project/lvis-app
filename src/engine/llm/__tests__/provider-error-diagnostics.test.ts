import { describe, expect, it } from "vitest";

import { extractProviderErrorDiagnostics } from "../provider-error-diagnostics.js";

describe("provider error diagnostics", () => {
  it("extracts OpenAI TPM rate-limit numbers without retaining org ids", () => {
    const diagnostics = extractProviderErrorDiagnostics({
      type: "error",
      sequence_number: 2,
      error: {
        type: "tokens",
        code: "rate_limit_exceeded",
        message:
          "Rate limit reached for gpt-5.4-mini in organization org-IiSU6QTnhaSXVSkRxDCFuf3u on tokens per min (TPM): Limit 200000, Used 165785, Requested 47118. Please try again in 3.87s.",
      },
    });

    expect(diagnostics.origin).toBe("provider");
    expect(diagnostics.providerType).toBe("tokens");
    expect(diagnostics.providerCode).toBe("rate_limit_exceeded");
    expect(diagnostics.messagePreview).toContain("org-***");
    expect(diagnostics.messagePreview).not.toContain("org-IiSU6QTnhaSXVSkRxDCFuf3u");
    expect(diagnostics.rateLimit).toEqual({
      kind: "tokens-per-minute",
      limit: 200000,
      used: 165785,
      requested: 47118,
      retryAfterSeconds: 3.87,
    });
  });

  it("extracts APICallError-style response body fields and strips URL query", () => {
    const diagnostics = extractProviderErrorDiagnostics({
      message:
        "Rate limit reached on tokens per minute (TPM): Limit 200000, Used 158645, Requested 47118.",
      statusCode: 429,
      isRetryable: false,
      url: "https://aif.example.openai.azure.com/openai/v1/responses?api-version=v1",
      responseHeaders: { "retry-after": "2" },
      responseBody: JSON.stringify({
        error: {
          type: "tokens",
          code: "rate_limit_exceeded",
          message:
            "Rate limit reached on tokens per minute (TPM): Limit 200000, Used 158645, Requested 47118.",
        },
      }),
    });

    expect(diagnostics).toMatchObject({
      origin: "provider",
      providerType: "tokens",
      providerCode: "rate_limit_exceeded",
      statusCode: 429,
      isRetryable: false,
      urlHost: "aif.example.openai.azure.com",
      urlPath: "/openai/v1/responses",
      rateLimit: {
        kind: "tokens-per-minute",
        limit: 200000,
        used: 158645,
        requested: 47118,
        retryAfterSeconds: 2,
      },
    });
  });
});
