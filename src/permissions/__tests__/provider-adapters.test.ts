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
  buildFoundryUrl,
  FOUNDRY_API_KEY_SECRET,
  GCP_PLAYGROUND_API_KEY_SECRET,
  REVIEWER_VENDOR_MAP,
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
// MAJOR-1: constructor now accepts accessor functions, not raw values.

describe("FoundryReviewerProvider", () => {
  it("constructs successfully with valid accessor functions", () => {
    expect(
      () => new FoundryReviewerProvider(
        () => "sk-test",
        () => "https://my.services.ai.azure.com",
      ),
    ).not.toThrow();
  });

  it("throws at complete() time when apiKey accessor returns null", async () => {
    globalThis.fetch = mockFetch({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
    const provider = new FoundryReviewerProvider(
      () => null,
      () => "https://e.services.ai.azure.com",
    );
    await expect(
      provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow(/apiKey not configured/);
  });

  it("throws at complete() time when endpoint accessor returns null", async () => {
    globalThis.fetch = mockFetch({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
    const provider = new FoundryReviewerProvider(
      () => "key",
      () => null,
    );
    await expect(
      provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow(/endpoint not configured/);
  });

  it("MAJOR-1: picks up rotated apiKey on next complete() call without rewiring", async () => {
    let currentKey = "key-v1";
    const fetchSpy = mockFetch({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"level":"low","reason":"ok"}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new FoundryReviewerProvider(
      () => currentKey,
      () => "https://proj.services.ai.azure.com",
    );

    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>)
      .toMatchObject({ Authorization: "Bearer key-v1" });

    fetchSpy.mockClear();
    currentKey = "key-v2";
    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>)
      .toMatchObject({ Authorization: "Bearer key-v2" });
  });

  it("throws at complete() time when endpoint is HTTP (not HTTPS)", async () => {
    const provider = new FoundryReviewerProvider(
      () => "sk-test",
      () => "http://proj.services.ai.azure.com",
    );
    await expect(
      provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow(/must use HTTPS/);
  });

  it("throws at complete() time when endpoint hostname is not a valid azure suffix", async () => {
    const provider = new FoundryReviewerProvider(
      () => "sk-test",
      () => "https://evil.example.com",
    );
    await expect(
      provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
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

    const provider = new FoundryReviewerProvider(
      () => "sk-test",
      () => "https://proj.services.ai.azure.com",
    );
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

    const provider = new FoundryReviewerProvider(
      () => "my-foundry-key",
      () => "https://e.services.ai.azure.com",
    );
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

    const provider = new FoundryReviewerProvider(
      () => "key",
      () => "https://e.services.ai.azure.com",
    );
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

    const provider = new FoundryReviewerProvider(
      () => "bad-key",
      () => "https://e.services.ai.azure.com",
    );
    await expect(
      provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow(/Foundry reviewer HTTP 401/);
  });

  it("returns empty text when choices array is empty", async () => {
    globalThis.fetch = mockFetch({
      ok: true,
      json: async () => ({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    }) as unknown as typeof fetch;

    const provider = new FoundryReviewerProvider(
      () => "key",
      () => "https://e.services.ai.azure.com",
    );
    const result = await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect(result.text).toBe("");
  });
});

// ─── buildFoundryUrl (M1: deployment URL shape detection) ────────────

describe("buildFoundryUrl", () => {
  it("Foundry-native: appends /models/<model>/chat/completions?api-version=...", () => {
    const url = buildFoundryUrl("https://proj.services.ai.azure.com", "gpt-4o");
    expect(url).toContain("/models/gpt-4o/chat/completions");
    expect(url).toContain("api-version=");
    expect(url).not.toContain("/openai/deployments/");
  });

  it("Foundry-native: strips trailing slash before appending path", () => {
    const url = buildFoundryUrl("https://proj.services.ai.azure.com/", "gpt-4o");
    expect(url).not.toMatch(/\/\/models/);
    expect(url).toContain("/models/gpt-4o/chat/completions");
  });

  it("Azure deployment (chat-shape): appends chat/completions only — no /models/<model>", () => {
    const base = "https://res.openai.azure.com/openai/deployments/gpt-4o-mini";
    const url = buildFoundryUrl(base, "gpt-4o-mini");
    expect(url).toContain("/openai/deployments/gpt-4o-mini/chat/completions");
    expect(url).toContain("api-version=");
    // Model must NOT appear twice (once in deployment path, once in /models/)
    expect(url).not.toMatch(/\/models\/gpt-4o-mini/);
  });

  it("Azure deployment with trailing slash: produces correct URL", () => {
    const base = "https://res.openai.azure.com/openai/deployments/gpt-4o/";
    const url = buildFoundryUrl(base, "gpt-4o");
    expect(url).toBe(
      "https://res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-05-01-preview",
    );
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
    expect(() => validateFoundryEndpoint("https://attacker.example.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });

  it("rejects invalid URL strings", () => {
    expect(() => validateFoundryEndpoint("not-a-url")).toThrow(/valid URL/);
  });

  it("rejects bare azure.com (m2: no longer accepted as endpoint)", () => {
    // Previously accepted by the broad .azure.com suffix; now rejected since
    // bare azure.com is not a valid Foundry project endpoint.
    expect(() => validateFoundryEndpoint("https://azure.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });

  it("rejects subdomain of azure.com that is not .services.ai or .openai (m2: narrowed)", () => {
    // e.g. management.azure.com — was accepted before, now rejected
    expect(() => validateFoundryEndpoint("https://management.azure.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });
});

// ─── GcpPlaygroundReviewerProvider ──────────────────────────────────
// MAJOR-1: constructor now accepts an accessor function, not a raw value.

describe("GcpPlaygroundReviewerProvider", () => {
  it("constructs successfully with valid accessor function", () => {
    expect(() => new GcpPlaygroundReviewerProvider(() => "gcp-key-123")).not.toThrow();
  });

  it("throws at complete() time when apiKey accessor returns null", async () => {
    const provider = new GcpPlaygroundReviewerProvider(() => null);
    await expect(
      provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow(/apiKey not configured/);
  });

  it("MAJOR-1: picks up rotated apiKey on next complete() call without rewiring", async () => {
    let currentKey = "AIza-v1";
    const fetchSpy = mockFetch({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"level":"low","reason":"ok"}' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new GcpPlaygroundReviewerProvider(() => currentKey);

    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>)
      .toMatchObject({ "x-goog-api-key": "AIza-v1" });

    fetchSpy.mockClear();
    currentKey = "AIza-v2";
    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>)
      .toMatchObject({ "x-goog-api-key": "AIza-v2" });
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

    const provider = new GcpPlaygroundReviewerProvider(() => "AIza-test-key");
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

    const provider = new GcpPlaygroundReviewerProvider(() => "AIza-secret-key");
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

    const provider = new GcpPlaygroundReviewerProvider(() => "key");
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

    const provider = new GcpPlaygroundReviewerProvider(() => "key");
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

    const provider = new GcpPlaygroundReviewerProvider(() => "bad-key");
    await expect(
      provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow(/GCP reviewer HTTP 403/);
  });

  it("returns empty text when candidates array is empty", async () => {
    globalThis.fetch = mockFetch({
      ok: true,
      json: async () => ({ candidates: [], usageMetadata: {} }),
    }) as unknown as typeof fetch;

    const provider = new GcpPlaygroundReviewerProvider(() => "key");
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

  // MAJOR-1: factory stores accessors — key/endpoint rotation transparent on complete()
  it("MAJOR-1: adapter uses accessor on each complete() — rotated key propagates", async () => {
    let liveKey = "az-key-v1";
    let liveEndpoint = "https://proj.services.ai.azure.com";
    const getSecret = vi.fn((key: string) =>
      key === FOUNDRY_API_KEY_SECRET ? liveKey : null,
    );
    const getEndpoint = vi.fn(() => liveEndpoint);
    const fetchSpy = mockFetch({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"level":"low","reason":"ok"}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = createFoundryProvider(getSecret, getEndpoint)!;
    expect(provider).not.toBeNull();

    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect(
      ((fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>)["Authorization"],
    ).toBe("Bearer az-key-v1");

    fetchSpy.mockClear();
    liveKey = "az-key-v2";
    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect(
      ((fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>)["Authorization"],
    ).toBe("Bearer az-key-v2");
  });

  it("MAJOR-1: adapter uses endpoint accessor on each complete() — endpoint rotation propagates", async () => {
    const getSecret = vi.fn(() => "az-key");
    const fetchSpy = mockFetch({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"level":"low","reason":"ok"}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    let liveEndpoint = "https://proj1.services.ai.azure.com";
    const getEndpoint = vi.fn(() => liveEndpoint);

    const provider = createFoundryProvider(getSecret, getEndpoint)!;
    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[0]).toContain("proj1.services.ai.azure.com");

    fetchSpy.mockClear();
    liveEndpoint = "https://proj2.services.ai.azure.com";
    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[0]).toContain("proj2.services.ai.azure.com");
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

  // MAJOR-1: factory stores accessor — key rotation propagates to complete()
  it("MAJOR-1: adapter uses accessor on each complete() — rotated key propagates", async () => {
    let liveKey = "AIza-v1";
    const getSecret = vi.fn((key: string) =>
      key === GCP_PLAYGROUND_API_KEY_SECRET ? liveKey : null,
    );
    const fetchSpy = mockFetch({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"level":"low","reason":"ok"}' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = createGcpPlaygroundProvider(getSecret)!;
    expect(provider).not.toBeNull();

    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect(
      ((fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>)["x-goog-api-key"],
    ).toBe("AIza-v1");

    fetchSpy.mockClear();
    liveKey = "AIza-v2";
    await provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });
    expect(
      ((fetchSpy.mock.calls[0] as [string, RequestInit])[1]?.headers as Record<string, string>)["x-goog-api-key"],
    ).toBe("AIza-v2");
  });
});

// ─── reviewerProviderKeyPresent ───────────────────────────────────────

describe("reviewerProviderKeyPresent", () => {
  it("openai → checks llm.apiKey.openai", () => {
    const getSecret = vi.fn((key: string) => (key === "llm.apiKey.openai" ? "sk-x" : null));
    expect(reviewerProviderKeyPresent("openai", getSecret)).toBe(true);
    expect(getSecret).toHaveBeenCalledWith("llm.apiKey.openai");
  });

  it("anthropic → checks llm.apiKey.claude (M2: vendor map, not llm.apiKey.anthropic)", () => {
    // UI sends "anthropic"; canonical vendor is "claude" — must look up llm.apiKey.claude
    const getSecret = vi.fn((key: string) => (key === "llm.apiKey.claude" ? "x" : null));
    expect(reviewerProviderKeyPresent("anthropic", getSecret)).toBe(true);
    expect(getSecret).toHaveBeenCalledWith("llm.apiKey.claude");
    expect(getSecret).not.toHaveBeenCalledWith("llm.apiKey.anthropic");
  });

  it("anthropic → false when only llm.apiKey.anthropic present (M2: regression guard)", () => {
    // Ensure the old (broken) key path no longer satisfies the check
    const getSecret = vi.fn((key: string) => (key === "llm.apiKey.anthropic" ? "x" : null));
    expect(reviewerProviderKeyPresent("anthropic", getSecret)).toBe(false);
  });

  it("google → checks llm.apiKey.gemini (M2: vendor map, not llm.apiKey.google)", () => {
    // UI sends "google"; canonical vendor is "gemini"
    const getSecret = vi.fn((key: string) => (key === "llm.apiKey.gemini" ? "k" : null));
    expect(reviewerProviderKeyPresent("google", getSecret)).toBe(true);
    expect(getSecret).toHaveBeenCalledWith("llm.apiKey.gemini");
    expect(getSecret).not.toHaveBeenCalledWith("llm.apiKey.google");
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

  // ── #766 regression: empty / whitespace endpoint must not be truthy ──

  it("foundry → false when endpoint is empty string (key present) — #766", () => {
    // Empty string is !== null so the old code returned true; must be false.
    const getSecret = vi.fn((key: string) =>
      key === FOUNDRY_API_KEY_SECRET ? "api-key" : null,
    );
    const getEndpoint = vi.fn(() => "");
    expect(reviewerProviderKeyPresent("foundry", getSecret, getEndpoint)).toBe(false);
  });

  it("foundry → false when endpoint is whitespace-only (key present) — #766", () => {
    const getSecret = vi.fn((key: string) =>
      key === FOUNDRY_API_KEY_SECRET ? "api-key" : null,
    );
    const getEndpoint = vi.fn(() => "   ");
    expect(reviewerProviderKeyPresent("foundry", getSecret, getEndpoint)).toBe(false);
  });

  it("foundry → true when endpoint is a valid non-empty URL (key present) — #766", () => {
    const getSecret = vi.fn((key: string) =>
      key === FOUNDRY_API_KEY_SECRET ? "api-key" : null,
    );
    const getEndpoint = vi.fn(() => "https://valid.services.ai.azure.com");
    expect(reviewerProviderKeyPresent("foundry", getSecret, getEndpoint)).toBe(true);
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

  it("unknown provider → false, fail-closed (getSecret not called)", () => {
    // MAJOR-3 R2: unknown provider name now returns false without probing getSecret.
    const getSecret = vi.fn((_key: string) => null);
    expect(reviewerProviderKeyPresent("unknown-provider", getSecret)).toBe(false);
    expect(getSecret).not.toHaveBeenCalled();
  });
});

// ─── M4: fetch timeout (Foundry) ──────────────────────────────────────

describe("FoundryReviewerProvider timeout (M4)", () => {
  it("aborts with AbortError when fetch hangs beyond 15s", async () => {
    vi.useFakeTimers();
    let rejectFetch!: (err: Error) => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<never>((_res, rej) => {
          rejectFetch = rej;
        }),
    ) as unknown as typeof fetch;

    const provider = new FoundryReviewerProvider(
      () => "key",
      () => "https://e.services.ai.azure.com",
    );
    const completionPromise = provider.complete({ model: "m", systemPrompt: "s", userPrompt: "u" });

    // Advance timers past the 15s timeout
    await vi.advanceTimersByTimeAsync(16_000);
    // Simulate the fetch being aborted (AbortController fires the rejection)
    rejectFetch(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));

    await expect(completionPromise).rejects.toThrow(/aborted|timeout/i);

    vi.useRealTimers();
  });
});

// ─── M4: fetch timeout (GCP) ─────────────────────────────────────────

describe("GcpPlaygroundReviewerProvider timeout (M4)", () => {
  it("aborts with AbortError when fetch hangs beyond 15s", async () => {
    vi.useFakeTimers();
    let rejectFetch!: (err: Error) => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<never>((_res, rej) => {
          rejectFetch = rej;
        }),
    ) as unknown as typeof fetch;

    const provider = new GcpPlaygroundReviewerProvider(() => "AIza-key");
    const completionPromise = provider.complete({ model: "gemini-1.5-flash", systemPrompt: "s", userPrompt: "u" });

    await vi.advanceTimersByTimeAsync(16_000);
    rejectFetch(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));

    await expect(completionPromise).rejects.toThrow(/aborted|timeout/i);

    vi.useRealTimers();
  });
});

// ─── HIGH-1: buildFoundryUrl path-segment + hostname-suffix check ─────

describe("buildFoundryUrl (HIGH-1 — path-segment + hostname-suffix detection)", () => {
  it("Foundry-native: appends /models/<model>/chat/completions?api-version=...", () => {
    const url = buildFoundryUrl("https://proj.services.ai.azure.com", "gpt-4o");
    expect(url).toContain("/models/gpt-4o/chat/completions");
    expect(url).toContain("api-version=");
    expect(url).not.toContain("/openai/deployments/");
  });

  it("Foundry-native: strips trailing slash before appending path", () => {
    const url = buildFoundryUrl("https://proj.services.ai.azure.com/", "gpt-4o");
    expect(url).not.toMatch(/\/\/models/);
    expect(url).toContain("/models/gpt-4o/chat/completions");
  });

  it("Azure deployment (chat-shape): appends chat/completions only — no /models/<model>", () => {
    const base = "https://res.openai.azure.com/openai/deployments/gpt-4o-mini";
    const url = buildFoundryUrl(base, "gpt-4o-mini");
    expect(url).toContain("/openai/deployments/gpt-4o-mini/chat/completions");
    expect(url).toContain("api-version=");
    expect(url).not.toMatch(/\/models\/gpt-4o-mini/);
  });

  it("Azure deployment with trailing slash: produces correct URL", () => {
    const base = "https://res.openai.azure.com/openai/deployments/gpt-4o/";
    const url = buildFoundryUrl(base, "gpt-4o");
    expect(url).toBe(
      "https://res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-05-01-preview",
    );
  });

  it("HIGH-1: Foundry-native endpoint with /openai/deployments/ in BASE PATH but .services.ai.azure.com host → treated as Foundry-native", () => {
    // A Foundry project whose path happens to contain the deployment substring
    // should NOT be misclassified as an Azure OpenAI deployment because its
    // hostname does not end with .openai.azure.com.
    const url = buildFoundryUrl(
      "https://proj.services.ai.azure.com/openai/deployments/fake",
      "actual-model",
    );
    // Must use Foundry-native shape (host does not end in .openai.azure.com)
    expect(url).toContain("/models/actual-model/chat/completions");
  });

  it("HIGH-1: .openai.azure.com host WITHOUT /openai/deployments/ path → treated as Foundry-native", () => {
    // An openai.azure.com endpoint that doesn't have the deployment path
    // should fall through to Foundry-native shape.
    const url = buildFoundryUrl("https://res.openai.azure.com", "gpt-4o");
    expect(url).toContain("/models/gpt-4o/chat/completions");
    expect(url).not.toContain("/openai/deployments/");
  });
});

// ─── LOW-1: validateFoundryEndpoint subdomain regex ───────────────────

describe("validateFoundryEndpoint (LOW-1 — subdomain regex tightening)", () => {
  it("accepts https://<subdomain>.services.ai.azure.com", () => {
    expect(() => validateFoundryEndpoint("https://proj.services.ai.azure.com")).not.toThrow();
  });

  it("accepts https://<resource>.openai.azure.com", () => {
    expect(() => validateFoundryEndpoint("https://myresource.openai.azure.com")).not.toThrow();
  });

  it("accepts multi-label subdomain (e.g. a.b.services.ai.azure.com)", () => {
    expect(() => validateFoundryEndpoint("https://a.b.services.ai.azure.com")).not.toThrow();
  });

  it("rejects HTTP endpoints", () => {
    expect(() => validateFoundryEndpoint("http://proj.services.ai.azure.com")).toThrow(/HTTPS/);
  });

  it("rejects non-azure.com hostnames", () => {
    expect(() => validateFoundryEndpoint("https://attacker.example.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });

  it("rejects invalid URL strings", () => {
    expect(() => validateFoundryEndpoint("not-a-url")).toThrow(/valid URL/);
  });

  it("rejects bare services.ai.azure.com without subdomain prefix (fails suffix check)", () => {
    // hostname = "services.ai.azure.com" does NOT end with ".services.ai.azure.com"
    // (the suffix starts with a dot), so this is rejected by the suffix check, not
    // the subdomain regex. The error is still a validation failure.
    expect(() => validateFoundryEndpoint("https://services.ai.azure.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });

  it("rejects bare openai.azure.com without subdomain prefix (fails suffix check)", () => {
    // hostname = "openai.azure.com" does NOT end with ".openai.azure.com"
    expect(() => validateFoundryEndpoint("https://openai.azure.com")).toThrow(/\.services\.ai\.azure\.com or \.openai\.azure\.com/);
  });

  it("rejects subdomain with leading hyphen (LOW-1 DNS label validation)", () => {
    expect(() => validateFoundryEndpoint("https://-bad.services.ai.azure.com")).toThrow(/invalid subdomain/);
  });

  it("rejects subdomain with trailing hyphen (LOW-1 DNS label validation)", () => {
    expect(() => validateFoundryEndpoint("https://bad-.services.ai.azure.com")).toThrow(/invalid subdomain/);
  });

  it("accepts valid subdomain with hyphens", () => {
    expect(() => validateFoundryEndpoint("https://my-project-123.services.ai.azure.com")).not.toThrow();
  });
});

// ─── MEDIUM-3: REVIEWER_VENDOR_MAP null-prototype + hasOwnProperty ────

describe("REVIEWER_VENDOR_MAP (MEDIUM-3 — prototype pollution closed)", () => {
  it("does not have prototype-chain properties as own entries", () => {
    // Object.create(null) has no prototype — __proto__, constructor, etc.
    // must not be accessible as map values.
    expect(Object.prototype.hasOwnProperty.call(REVIEWER_VENDOR_MAP, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(REVIEWER_VENDOR_MAP, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(REVIEWER_VENDOR_MAP, "hasOwnProperty")).toBe(false);
  });

  it("contains the expected reviewer provider mappings", () => {
    expect(REVIEWER_VENDOR_MAP["openai"]).toBe("openai");
    expect(REVIEWER_VENDOR_MAP["anthropic"]).toBe("claude");
    expect(REVIEWER_VENDOR_MAP["google"]).toBe("gemini");
    // "azure-foundry" and "gemini" are intentionally absent from REVIEWER_VENDOR_MAP
    // after #771 (10e07e2a): foundry / gcp-playground are handled by dedicated
    // branches in provider-adapters.ts before the map lookup is reached.
    expect(REVIEWER_VENDOR_MAP["azure-foundry"]).toBeUndefined();
    expect(REVIEWER_VENDOR_MAP["gemini"]).toBeUndefined();
  });
});

describe("reviewerProviderKeyPresent (MEDIUM-3 — prototype-safe lookup)", () => {
  it("unknown provider → false, fail-closed (does NOT fall through to getSecret)", () => {
    // MAJOR-3 R2: unknown UI name no longer falls through to `?? provider` → fail-closed.
    // getSecret must NOT be called for an unknown provider (no secret-store probe).
    const getSecret = vi.fn((_key: string) => null);
    expect(reviewerProviderKeyPresent("unknown-provider", getSecret)).toBe(false);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("prototype property name as provider → false, fail-closed (no prototype pollution)", () => {
    // If REVIEWER_VENDOR_MAP were a plain object, REVIEWER_VENDOR_MAP["constructor"]
    // would return the Object constructor function. With Object.create(null) +
    // hasOwnProperty check + MAJOR-3 fail-closed, unknown names return false immediately.
    const getSecret = vi.fn((_key: string) => null);
    expect(reviewerProviderKeyPresent("constructor", getSecret)).toBe(false);
    // MAJOR-3: fail-closed means getSecret is never called for an unmapped provider.
    expect(getSecret).not.toHaveBeenCalled();
  });
});
