import { describe, expect, it, vi } from "vitest";

import {
  createSafeLlmFetch,
  isAllowedLlmFetchUrl,
} from "../safe-llm-fetch.js";

describe("safe LLM fetch", () => {
  it("allows Azure OpenAI private-endpoint hosts", () => {
    expect(
      isAllowedLlmFetchUrl(
        new URL("https://aif-example.openai.azure.com/openai/v1/responses"),
      ),
    ).toBe(true);
  });

  it("allows Foundry project hosts", () => {
    expect(
      isAllowedLlmFetchUrl(
        new URL("https://project.services.ai.azure.com/models/gpt/chat/completions"),
      ),
    ).toBe(true);
  });

  it("rejects non-https and non-Azure hosts", () => {
    expect(
      isAllowedLlmFetchUrl(new URL("http://aif-example.openai.azure.com/openai/v1")),
    ).toBe(false);
    expect(isAllowedLlmFetchUrl(new URL("file:///tmp/token"))).toBe(false);
    expect(isAllowedLlmFetchUrl(new URL("https://api.openai.com/v1/responses"))).toBe(false);
    expect(
      isAllowedLlmFetchUrl(new URL("https://aif-example.openai.azure.com.attacker.test")),
    ).toBe(false);
    expect(isAllowedLlmFetchUrl(new URL("https://openai.azure.com/openai/v1"))).toBe(false);
  });

  it("rejects malformed Azure resource labels", () => {
    expect(
      isAllowedLlmFetchUrl(new URL("https://-bad.openai.azure.com/openai/v1")),
    ).toBe(false);
    expect(
      isAllowedLlmFetchUrl(new URL("https://bad-.services.ai.azure.com/models/gpt")),
    ).toBe(false);
  });

  it("sets bypassCustomProtocolHandlers before delegating to Electron net.fetch", async () => {
    const response = new Response("ok");
    const netFetch = vi.fn(async () => response);
    const fetch = createSafeLlmFetch(
      netFetch as unknown as Parameters<typeof createSafeLlmFetch>[0],
    );

    await expect(
      fetch("https://aif-example.openai.azure.com/openai/v1/responses", {
        method: "POST",
        headers: { "x-test": "1" },
      }),
    ).resolves.toBe(response);

    expect(netFetch).toHaveBeenCalledWith(
      "https://aif-example.openai.azure.com/openai/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: { "x-test": "1" },
        bypassCustomProtocolHandlers: true,
      }),
    );
  });

  it("blocks custom protocols before they reach Electron net.fetch", async () => {
    const netFetch = vi.fn(async () => new Response("ok"));
    const fetch = createSafeLlmFetch(
      netFetch as unknown as Parameters<typeof createSafeLlmFetch>[0],
    );

    await expect(fetch("lvis://plugin/internal")).rejects.toThrow(
      "blocked non-Azure-Foundry LLM request",
    );
    expect(netFetch).not.toHaveBeenCalled();
  });
});
