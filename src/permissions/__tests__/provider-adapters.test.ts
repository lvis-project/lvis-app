/**
 * Permission policy C3 — Foundry + GCP playground reviewer LLM provider adapter tests.
 *
 * Coverage:
 *   - FoundryReviewerProvider: HTTP fetch + parse + verdict JSON extraction
 *   - GcpPlaygroundReviewerProvider: HTTP fetch + parse + verdict JSON extraction
 *   - createFoundryProvider / createGcpPlaygroundProvider factory helpers
 *   - reviewerProviderKeyPresent predicate for all five providers
 *   - Error propagation (non-2xx → thrown error for fallbackOnError chain)
 *   - Key inheritance: Foundry uses llm.apiKey.azure-foundry,
 *     GCP uses llm.apiKey.gemini (chat-provider key inheritance)
 *   - GCP API key in x-goog-api-key header (not URL query param)
 *   - Foundry endpoint validation (HTTPS + .azure.com suffix)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FoundryReviewerProvider,
  GcpPlaygroundReviewerProvider,
  createFoundryProvider,
  createGcpPlaygroundProvider,
  reviewerProviderKeyPresent,
  validateFoundryEndpoint,
  FOUNDRY_API_KEY_SECRET,
  GCP_PLAYGROUND_API_KEY_SECRET,
} from "../reviewer/provider-adapters.js";

// ─── fetch mock helpers ───────────────────────────────────────────────

function mockFetch(
  response: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> },
) {
  return vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: response.json ?? (async () => ({})),
    text: response.text ?? (async () => "error"),
  }));
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── FoundryReviewerProvider ─────────────────────────────────────────

describe("FoundryReviewerProvider", () => {
  it("constructs successfully with valid apiKey + endpoint", () => {
    expect(
      () => new FoundryReviewerProvider("sk-test", "https://my.services.ai.azure.com"),
    ).not.toThrow();
  });

  it("throws when apiKey is empty", () => {
    expect(() => new FoundryReviewerProvider("", "https://endpoint.services.ai.azure.com")).toThrow(
      /apiKey is required/,
    );
  });

  it("throws when endpoint is empty", () => {
    expect(() => new FoundryReviewerProvider("sk-test", "")).toThrow(/endpoint is required/);
  });

  it("throws when endpoint is HTTP (not HTTPS)", () => {
    expect(
      () => new FoundryReviewerProvider("sk-test", "http://proj.services.ai.azure.com"),
    ).toThrow(/must use HTTPS/);
  });

  it("throws when endpoint hostname does not end with .azure.com", () => {
    expect(
      () => new FoundryReviewerProvider("sk-test", "https://evil.example.com"),
    ).toThrow(/must end with .azure.com/);
  });

  it("builds correct URL with model encoded in path + api-version query param", async () => {
    const fetchSpy = mockFetch({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"level":"low","reason":"ok"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new FoundryReviewerProvider("sk-test", "https://proj.services.ai.azure.com");
    await provider.complete({
      model: "gpt-4o-mini",
      systemPrompt: "sys",
      userPrompt: "user",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/models/gpt-4o-mini/chat/completions");
    expect(url).toContain("api-version=");
    expect(url).toContain("proj.services.ai.azure.com");
  });

  it("sends Authorization: Bearer header", async () => {
    const fetchSpy = mockFetch({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"level":"medium","reason":"ok"}' } }],
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new FoundryReviewerProvider("my-foundry-key", "https://e.services.ai.azure.com");
    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer my-foundry-key",
    );
  });

  it("extracts text, tokensIn, tokensOut from successful response", async () => {
    const responseText = '{"level":"high","reason":"dangerous"}';
    globalThis.fetch = mockFetch({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: responseText } }],
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      }),
    }) as unknown as typeof fetch;

    const provider = new FoundryReviewerProvider("key", "https://e.services.ai.azure.com");
    const result = await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });

    expect(result.text).toBe(responseText);
    expect(result.tokensIn).toBe(42);
    expect(result.tokensOut).toBe(7);
    expect(result.costUsd).toBe(0);
  });

  it("throws on non-2xx HTTP response (for fallbackOnError chain)", async () => {
    globalThis.fetch = mockFetch({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    }) as unknown as typeof fetch;

    const provider = new FoundryReviewerProvider("bad-key", "https://e.services.ai.azure.com");
    await expect(
      provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow(/Foundry reviewer HTTP 401/);
  });

  it("returns empty text when choices array is empty", async () => {
    globalThis.fetch = mockFetch({
      ok: true,
      json: async () => ({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    }) as unknown as typeof fetch;

    const provider = new FoundryReviewerProvider("key", "https://e.services.ai.azure.com");
    const result = await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect(result.text).toBe("");
  });
});

// ─── validateFoundryEndpoint ─────────────────────────────────────────

describe("validateFoundryEndpoint", () => {
  it("accepts https://<subdomain>.services.ai.azure.com", () => {
    expect(() => validateFoundryEndpoint("https://proj.services.ai.azure.com")).not.toThrow();
  });

  it("accepts https://<resource>.openai.azure.com", () => {
    expect(() => validateFoundryEndpoint("https://myresource.openai.azure.com")).not.toThrow();
  });

  it("rejects HTTP endpoints", () => {
    expect(() => validateFoundryEndpoint("http://proj.services.ai.azure.com")).toThrow(/HTTPS/);
  });

  it("rejects non-azure.com hostnames", () => {
    expect(() => validateFoundryEndpoint("https://attacker.example.com")).toThrow(/azure.com/);
  });

  it("rejects invalid URL strings", () => {
    expect(() => validateFoundryEndpoint("not-a-url")).toThrow(/valid URL/);
  });
});

// ─── GcpPlaygroundReviewerProvider ──────────────────────────────────

describe("GcpPlaygroundReviewerProvider", () => {
  it("constructs successfully with valid apiKey", () => {
    expect(() => new GcpPlaygroundReviewerProvider("gcp-key-123")).not.toThrow();
  });

  it("throws when apiKey is empty", () => {
    expect(() => new GcpPlaygroundReviewerProvider("")).toThrow(/apiKey is required/);
  });

  it("builds correct GCP URL with model in path (no API key in URL)", async () => {
    const fetchSpy = mockFetch({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"level":"low","reason":"ok"}' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new GcpPlaygroundReviewerProvider("AIza-test-key");
    await provider.complete({
      model: "gemini-1.5-flash",
      systemPrompt: "sys",
      userPrompt: "user",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("gemini-1.5-flash");
    expect(url).toContain(":generateContent");
    // API key must NOT appear in the URL — it is sent as a header instead.
    expect(url).not.toContain("key=");
    expect(url).not.toContain("AIza-test-key");
  });

  it("sends API key as x-goog-api-key header (not URL query param)", async () => {
    const fetchSpy = mockFetch({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"level":"low","reason":"ok"}' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new GcpPlaygroundReviewerProvider("AIza-secret-key");
    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-secret-key");
  });

  it("sends systemInstruction + contents in request body", async () => {
    const fetchSpy = mockFetch({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"level":"medium","reason":"r"}' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new GcpPlaygroundReviewerProvider("key");
    await provider.complete({ model: "m", systemPrompt: "system text", userPrompt: "user text" });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect((body.systemInstruction as { parts: Array<{ text: string }> }).parts[0].text).toBe(
      "system text",
    );
    expect(
      ((body.contents as Array<{ parts: Array<{ text: string }> }>)[0]).parts[0].text,
    ).toBe("user text");
  });

  it("extracts text, tokensIn, tokensOut from successful response", async () => {
    const responseText = '{"level":"high","reason":"risky"}';
    globalThis.fetch = mockFetch({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: responseText }] } }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
      }),
    }) as unknown as typeof fetch;

    const provider = new GcpPlaygroundReviewerProvider("key");
    const result = await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });

    expect(result.text).toBe(responseText);
    expect(result.tokensIn).toBe(20);
    expect(result.tokensOut).toBe(8);
    expect(result.costUsd).toBe(0);
  });

  it("throws on non-2xx HTTP response (for fallbackOnError chain)", async () => {
    globalThis.fetch = mockFetch({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    }) as unknown as typeof fetch;

    const provider = new GcpPlaygroundReviewerProvider("bad-key");
    await expect(
      provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow(/GCP reviewer HTTP 403/);
  });

  it("returns empty text when candidates array is empty", async () => {
    globalThis.fetch = mockFetch({
      ok: true,
      json: async () => ({ candidates: [], usageMetadata: {} }),
    }) as unknown as typeof fetch;

    const provider = new GcpPlaygroundReviewerProvider("key");
    const result = await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect(result.text).toBe("");
  });
});

// ─── Factory helpers ───────────────────────────────────────────────────

describe("createFoundryProvider", () => {
  it("returns null when API key is absent", () => {
    const getSecret = (_key: string) => null;
    const getEndpoint = () => "https://e.services.ai.azure.com";
    expect(createFoundryProvider(getSecret, getEndpoint)).toBeNull();
  });

  it("returns null when endpoint is absent (key present)", () => {
    const getSecret = (key: string) =>
      key === FOUNDRY_API_KEY_SECRET ? "api-key" : null;
    const getEndpoint = () => null;
    expect(createFoundryProvider(getSecret, getEndpoint)).toBeNull();
  });

  it("returns null when endpoint is invalid (key present, bad URL)", () => {
    const getSecret = (key: string) =>
      key === FOUNDRY_API_KEY_SECRET ? "api-key" : null;
    const getEndpoint = () => "http://evil.example.com";
    expect(createFoundryProvider(getSecret, getEndpoint)).toBeNull();
  });

  it("returns FoundryReviewerProvider when both key + endpoint are present and valid", () => {
    const getSecret = (key: string) =>
      key === FOUNDRY_API_KEY_SECRET ? "api-key" : null;
    const getEndpoint = () => "https://e.services.ai.azure.com";
    const provider = createFoundryProvider(getSecret, getEndpoint);
    expect(provider).toBeInstanceOf(FoundryReviewerProvider);
  });

  // Key inheritance — the factory reads llm.apiKey.azure-foundry
  it("reads llm.apiKey.azure-foundry (chat-provider key inheritance)", () => {
    const getSecret = vi.fn((key: string) =>
      key === "llm.apiKey.azure-foundry" ? "az-key" : null,
    );
    const getEndpoint = () => "https://proj.services.ai.azure.com";
    const provider = createFoundryProvider(getSecret, getEndpoint);
    expect(provider).toBeInstanceOf(FoundryReviewerProvider);
    expect(getSecret).toHaveBeenCalledWith("llm.apiKey.azure-foundry");
  });
});

describe("createGcpPlaygroundProvider", () => {
  it("returns null when API key is absent", () => {
    const getSecret = (_key: string) => null;
    expect(createGcpPlaygroundProvider(getSecret)).toBeNull();
  });

  it("returns GcpPlaygroundReviewerProvider when key is present", () => {
    const getSecret = (key: string) =>
      key === GCP_PLAYGROUND_API_KEY_SECRET ? "AIza-key" : null;
    const provider = createGcpPlaygroundProvider(getSecret);
    expect(provider).toBeInstanceOf(GcpPlaygroundReviewerProvider);
  });

  // Key inheritance — the factory reads llm.apiKey.gemini
  it("reads llm.apiKey.gemini (chat-provider key inheritance)", () => {
    const getSecret = vi.fn((key: string) =>
      key === "llm.apiKey.gemini" ? "gemini-key" : null,
    );
    const provider = createGcpPlaygroundProvider(getSecret);
    expect(provider).toBeInstanceOf(GcpPlaygroundReviewerProvider);
    expect(getSecret).toHaveBeenCalledWith("llm.apiKey.gemini");
  });
});

// ─── reviewerProviderKeyPresent ───────────────────────────────────────

describe("reviewerProviderKeyPresent", () => {
  it("openai → checks llm.apiKey.openai", () => {
    const getSecret = vi.fn((key: string) => (key === "llm.apiKey.openai" ? "sk-x" : null));
    expect(reviewerProviderKeyPresent("openai", getSecret)).toBe(true);
    expect(getSecret).toHaveBeenCalledWith("llm.apiKey.openai");
  });

  it("anthropic → checks llm.apiKey.anthropic", () => {
    const getSecret = vi.fn((_key: string) => null);
    expect(reviewerProviderKeyPresent("anthropic", getSecret)).toBe(false);
    expect(getSecret).toHaveBeenCalledWith("llm.apiKey.anthropic");
  });

  it("google → checks llm.apiKey.google", () => {
    const getSecret = vi.fn((key: string) => (key === "llm.apiKey.google" ? "k" : null));
    expect(reviewerProviderKeyPresent("google", getSecret)).toBe(true);
  });

  it("foundry → false when API key absent (even with endpoint)", () => {
    const getSecret = vi.fn((_key: string) => null);
    const getEndpoint = vi.fn(() => "https://e.services.ai.azure.com");
    expect(reviewerProviderKeyPresent("foundry", getSecret, getEndpoint)).toBe(false);
  });

  it("foundry → false when only API key present (endpoint missing)", () => {
    const getSecret = vi.fn((key: string) =>
      key === FOUNDRY_API_KEY_SECRET ? "k" : null,
    );
    const getEndpoint = vi.fn(() => null);
    expect(reviewerProviderKeyPresent("foundry", getSecret, getEndpoint)).toBe(false);
  });

  it("foundry → true when both llm.apiKey.azure-foundry and endpoint present", () => {
    const getSecret = vi.fn((key: string) =>
      key === FOUNDRY_API_KEY_SECRET ? "api-key" : null,
    );
    const getEndpoint = vi.fn(() => "https://e.services.ai.azure.com");
    expect(reviewerProviderKeyPresent("foundry", getSecret, getEndpoint)).toBe(true);
    expect(getSecret).toHaveBeenCalledWith("llm.apiKey.azure-foundry");
  });

  it("foundry → false when getEndpoint not supplied (conservative)", () => {
    const getSecret = vi.fn((key: string) =>
      key === FOUNDRY_API_KEY_SECRET ? "k" : null,
    );
    // No getEndpoint supplied → treated as no endpoint
    expect(reviewerProviderKeyPresent("foundry", getSecret)).toBe(false);
  });

  it("gcp-playground → false when API key absent", () => {
    const getSecret = vi.fn((_key: string) => null);
    expect(reviewerProviderKeyPresent("gcp-playground", getSecret)).toBe(false);
  });

  it("gcp-playground → true when llm.apiKey.gemini is present", () => {
    const getSecret = vi.fn((key: string) =>
      key === GCP_PLAYGROUND_API_KEY_SECRET ? "AIza-key" : null,
    );
    expect(reviewerProviderKeyPresent("gcp-playground", getSecret)).toBe(true);
    expect(getSecret).toHaveBeenCalledWith("llm.apiKey.gemini");
  });

  it("unknown provider → false (checked via llm.apiKey.unknown)", () => {
    const getSecret = vi.fn((_key: string) => null);
    expect(reviewerProviderKeyPresent("unknown-provider", getSecret)).toBe(false);
    expect(getSecret).toHaveBeenCalledWith("llm.apiKey.unknown-provider");
  });
});
