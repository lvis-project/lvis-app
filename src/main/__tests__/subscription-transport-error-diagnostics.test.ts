import { describe, expect, it } from "vitest";
import { projectSubscriptionTransportErrorDiagnostics } from "../subscription-transport-error-diagnostics.js";

describe("subscription transport error diagnostics", () => {
  it("projects a declared schema rejection without retaining remote text", () => {
    const rawDetail = "Invalid schema for function 'read_project_file': internal host=https://private.example token=secret";

    const projected = projectSubscriptionTransportErrorDiagnostics({
      code: -32_000,
      message: rawDetail,
      data: { statusCode: 400 },
    });

    expect(projected).toEqual({
      origin: "provider",
      statusCode: 400,
      providerCode: "invalid_function_parameters",
      classification: "unknown",
      messagePreview: "Invalid schema for function 'read_project_file'.",
    });
    expect(JSON.stringify(projected)).not.toContain(rawDetail);
    expect(JSON.stringify(projected)).not.toContain("private.example");
    expect(JSON.stringify(projected)).not.toContain("secret");
  });

  it("projects only structured context metadata", () => {
    const rawDetail = "context_length_exceeded for customer-private-history";

    const projected = projectSubscriptionTransportErrorDiagnostics({
      error: {
        message: rawDetail,
        data: { status: 413 },
      },
    });

    expect(projected).toEqual({
      origin: "provider",
      statusCode: 413,
      classification: "context-length",
      messagePreview: "context window exceeded",
    });
    expect(JSON.stringify(projected)).not.toContain(rawDetail);
  });

  it("projects bounded TPM facts and excludes unrecognised remote errors", () => {
    const rawDetail = "429 rate limit on private-plan: tokens per minute";
    const projected = projectSubscriptionTransportErrorDiagnostics({
      message: rawDetail,
      statusCode: 429,
      data: {
        rateLimit: {
          kind: "tokens_per_minute",
          limit: 200_000,
          used: 190_000,
          requested: 30_000,
          retryAfterSeconds: 2.5,
          privateValue: "do-not-copy",
        },
      },
    });

    expect(projected).toEqual({
      origin: "provider",
      statusCode: 429,
      providerType: "tokens",
      providerCode: "rate_limit_exceeded",
      classification: "rate-limit",
      messagePreview: "subscription runtime tokens-per-minute rate limit",
      rateLimit: {
        kind: "tokens-per-minute",
        limit: 200_000,
        used: 190_000,
        requested: 30_000,
        retryAfterSeconds: 2.5,
      },
    });
    expect(JSON.stringify(projected)).not.toContain(rawDetail);
    expect(JSON.stringify(projected)).not.toContain("privateValue");
    expect(JSON.stringify(projected)).not.toContain("do-not-copy");
    expect(projectSubscriptionTransportErrorDiagnostics({ message: "private upstream issue" })).toBeUndefined();
  });
});
