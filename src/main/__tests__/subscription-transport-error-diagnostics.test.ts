import { describe, expect, it } from "vitest";
import {
  projectSubscriptionTransportErrorDiagnostics,
  projectedSubscriptionTransportDiagnosticsFromError,
  subscriptionTransportFailure,
} from "../subscription-transport-error-diagnostics.js";

describe("subscription transport error diagnostics", () => {
  it("preserves a host RPC operation through repeated safe projection", () => {
    const projected = subscriptionTransportFailure({
      phase: "rpc-timeout", kind: "timeout", operation: "turn/start",
    });
    expect(projected.transport).toEqual({ phase: "rpc-timeout", kind: "timeout", operation: "turn/start" });
    expect(projected).not.toHaveProperty("isRetryable");
    expect(projectedSubscriptionTransportDiagnosticsFromError({ providerError: projected })).toEqual(projected);
  });

  it.each([
    "", "private-token", "/private/file", "turn/start\nsecret", "turn/시작", "x".repeat(65),
    null, 1, { method: "turn/start" },
  ])("rejects an undeclared RPC operation at the projection boundary: %j", (operation) => {
    const providerError = subscriptionTransportFailure({ phase: "rpc-timeout", kind: "timeout" });
    expect(projectedSubscriptionTransportDiagnosticsFromError({
      providerError: { ...providerError, transport: { ...providerError.transport, operation } },
    })).toBeUndefined();
  });

  it("never takes the operation from a remote error payload", () => {
    expect(projectSubscriptionTransportErrorDiagnostics({
      operation: "turn/start", method: "account/read", params: { token: "secret" },
    }, "rpc-response")).toEqual(subscriptionTransportFailure({ phase: "rpc-response", kind: "unknown" }));
  });

  it.each([
    [401, "authentication"], [429, "rate-limit"], [504, "timeout"], [503, "server"], [400, "unknown"],
  ])("retains only diagnostic status %i as %s without changing retry signals", (statusCode, kind) => {
    const projected = projectSubscriptionTransportErrorDiagnostics({
      error: { statusCode, message: "account=secret prompt=private", path: "/private/file" },
    }, "turn-completion");
    expect(projected).toEqual({
      origin: "unknown", classification: "unknown", messagePreview: "subscription runtime transport failure",
      transport: { phase: "turn-completion", kind, statusCode },
    });
    expect(projected).not.toHaveProperty("statusCode");
    expect(projected).not.toHaveProperty("isRetryable");
    expect(projectedSubscriptionTransportDiagnosticsFromError({ providerError: projected })).toEqual(projected);
    expect(JSON.stringify(projected)).not.toMatch(/secret|private/);
  });

  it("retains an unknown response phase without copying its unrecognised fields", () => {
    expect(projectSubscriptionTransportErrorDiagnostics({
      message: "private failure", code: "sensitive-custom-code", data: { token: "secret" },
    }, "rpc-response")).toEqual(subscriptionTransportFailure({ phase: "rpc-response", kind: "unknown" }));
  });

  it.each([
    { phase: "private-stage" }, { kind: "secret" }, { statusCode: 200 },
    { exitCode: Number.NaN }, { exitCode: "secret" }, { signal: "SIGSECRET" },
  ])("rejects invalid transport fields on a later local boundary: %j", (invalid) => {
    const providerError = subscriptionTransportFailure({ phase: "process-exit", kind: "process", exitCode: null, signal: "SIGKILL" });
    expect(projectedSubscriptionTransportDiagnosticsFromError({
      providerError: { ...providerError, transport: { ...providerError.transport, ...invalid } },
    })).toBeUndefined();
  });

  it("rebuilds process facts without forwarding extra fields", () => {
    const providerError = subscriptionTransportFailure({ phase: "process-exit", kind: "process", exitCode: 1, signal: null });
    expect(projectedSubscriptionTransportDiagnosticsFromError({
      providerError: { ...providerError, token: "secret", transport: { ...providerError.transport, stderr: "secret" } },
    })).toEqual(providerError);
  });

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
