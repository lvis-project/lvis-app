import { describe, it, expect } from "vitest";
import {
  BUILT_IN_LLM_VENDOR_IDS,
  DEFAULT_VISIBLE_LLM_VENDOR_IDS,
  INSTALLED_LLM_VENDOR_IDS,
  KNOWN_LEGACY_LLM_VENDOR_IDS,
  isLLMVendor,
  LLM_VENDORS,
  LLM_VENDOR_DEFAULTS,
  LLM_VENDOR_MODEL_OPTIONS,
  MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS,
  canUseLlmVendorWithoutApiKey,
  freshAllVendorBlocks,
  freshVendorBlocks,
  getLlmVendorSettings,
  isApiKeyOptionalLlmVendor,
  isDefaultVisibleLLMVendor,
  isMarketplaceEligibleLLMVendor,
  isRetiredLlmModel,
  isSelfHostedTrustedNetworkVendor,
  isSelfHostedVllmVendor,
  normalizeLlmVendorModel,
} from "../llm-vendor-defaults.js";

describe("isLLMVendor", () => {
  it("accepts every member of LLM_VENDORS", () => {
    for (const v of LLM_VENDORS) {
      expect(isLLMVendor(v)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isLLMVendor("anthropic")).toBe(false);
    expect(isLLMVendor("unknown-vendor")).toBe(false);
    expect(isLLMVendor("")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isLLMVendor(undefined)).toBe(false);
    expect(isLLMVendor(null)).toBe(false);
    expect(isLLMVendor(42)).toBe(false);
    expect(isLLMVendor({ vendor: "claude" })).toBe(false);
    expect(isLLMVendor(["claude"])).toBe(false);
    expect(isLLMVendor(true)).toBe(false);
  });

  it("narrows the type so downstream callers receive a typed LLMVendor", () => {
    // Compile-time proof: passing `raw` to a function whose parameter is
    // typed `LLMVendor` only succeeds when the guard has narrowed it.
    // No hand-written exhaustive map needed — the call site itself is the
    // proof, and a future vendor added to LLM_VENDORS does not invalidate
    // this test.
    const acceptVendor = (v: import("../llm-vendor-defaults.js").LLMVendor) => v;
    const raw: unknown = "claude";
    if (isLLMVendor(raw)) {
      expect(acceptVendor(raw)).toBe("claude");
    } else {
      expect.fail("raw should have narrowed to LLMVendor");
    }
  });
});

describe("LLMVendorSettings", () => {
  it("freshVendorBlocks() returns default-visible mutable copies", () => {
    const blocks = freshVendorBlocks();
    expect(Object.keys(blocks).sort()).toEqual(
      [...DEFAULT_VISIBLE_LLM_VENDOR_IDS].sort(),
    );
  });

  it("freshAllVendorBlocks() remains available for exhaustive fixtures", () => {
    const blocks = freshAllVendorBlocks();
    expect(Object.keys(blocks)).toHaveLength(LLM_VENDORS.length);
  });
});

describe("LLM vendor defaults", () => {
  it("keeps provider count in the Cline-scale range", () => {
    // Cline had 49 built-in provider IDs when this expansion was mirrored
    // (2026-06-29). LVIS intentionally skips subscription/CLI-only providers,
    // but keeps the OpenAI-compatible preset surface broad enough to be
    // comparable rather than a small handful of hardcoded vendors.
    expect(LLM_VENDORS.length).toBeGreaterThanOrEqual(40);
    expect(isLLMVendor("openrouter")).toBe(true);
    expect(isLLMVendor("ollama")).toBe(true);
    expect(isLLMVendor("lmstudio")).toBe(true);
  });

  it("keeps only five providers in the default visible surface", () => {
    expect(BUILT_IN_LLM_VENDOR_IDS).toEqual([
      "openai",
      "claude",
      "gemini",
      "openrouter",
      "openai-compatible",
    ]);
    expect(DEFAULT_VISIBLE_LLM_VENDOR_IDS).toEqual([
      "openai",
      "claude",
      "gemini",
      "openrouter",
      "openai-compatible",
    ]);
    expect(DEFAULT_VISIBLE_LLM_VENDOR_IDS).toHaveLength(5);
    for (const vendor of DEFAULT_VISIBLE_LLM_VENDOR_IDS) {
      expect(isLLMVendor(vendor)).toBe(true);
      expect(isDefaultVisibleLLMVendor(vendor)).toBe(true);
      expect(MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS).not.toContain(vendor);
    }
    expect(MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS).toContain("azure-foundry");
    expect(MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS).toContain("groq");
    expect(MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS).toContain("ollama");
    expect(isMarketplaceEligibleLLMVendor("groq")).toBe(true);
    expect(isMarketplaceEligibleLLMVendor("openrouter")).toBe(false);
    expect(isMarketplaceEligibleLLMVendor("unknown-vendor")).toBe(false);
  });

  it("keeps built-in, marketplace-installed seed, and known legacy provider ids explicit", () => {
    expect(DEFAULT_VISIBLE_LLM_VENDOR_IDS).toBe(BUILT_IN_LLM_VENDOR_IDS);
    expect(INSTALLED_LLM_VENDOR_IDS).toEqual(MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS);
    expect(KNOWN_LEGACY_LLM_VENDOR_IDS).toEqual(INSTALLED_LLM_VENDOR_IDS);
    expect(INSTALLED_LLM_VENDOR_IDS).not.toContain("openai");
    expect(INSTALLED_LLM_VENDOR_IDS).not.toContain("openrouter");
    expect(INSTALLED_LLM_VENDOR_IDS).toContain("azure-foundry");
    expect(INSTALLED_LLM_VENDOR_IDS).toContain("groq");
    expect(KNOWN_LEGACY_LLM_VENDOR_IDS).toContain("vertex-ai");
    expect([...BUILT_IN_LLM_VENDOR_IDS, ...KNOWN_LEGACY_LLM_VENDOR_IDS].sort())
      .toEqual([...LLM_VENDORS].sort());
  });

  it("uses gpt-5.4-mini as the OpenAI default model", () => {
    expect(LLM_VENDOR_DEFAULTS.openai.model).toBe("gpt-5.4-mini");
  });

  it("offers the OpenRouter free router as an explicit selectable model", () => {
    expect(LLM_VENDOR_MODEL_OPTIONS.openrouter).toContain("openrouter/free");
  });

  it("marks only local or OpenAI-compatible endpoints as API-key optional", () => {
    expect(isApiKeyOptionalLlmVendor("openai-compatible")).toBe(true);
    expect(isApiKeyOptionalLlmVendor("litellm")).toBe(true);
    expect(isApiKeyOptionalLlmVendor("ollama")).toBe(true);
    expect(isApiKeyOptionalLlmVendor("lmstudio")).toBe(true);
    expect(isApiKeyOptionalLlmVendor("openrouter")).toBe(false);
    expect(isApiKeyOptionalLlmVendor("openai")).toBe(false);
  });

  it("classifies only the self-hosted vLLM class for vLLM request extensions", () => {
    // The endpoints that actually honor chat_template_kwargs +
    // continue_final_message.
    expect(isSelfHostedVllmVendor("openai-compatible")).toBe(true);
    expect(isSelfHostedVllmVendor("litellm")).toBe(true);
    expect(isSelfHostedVllmVendor("ollama")).toBe(true);
    expect(isSelfHostedVllmVendor("lmstudio")).toBe(true);
    // Commercial OpenAI-compatible gateways route through the same adapter but
    // do NOT run a vLLM chat template — they must be excluded so the adapter
    // never leaks chat_template_kwargs to them (the OpenRouter 400/422 bug).
    expect(isSelfHostedVllmVendor("openrouter")).toBe(false);
    expect(isSelfHostedVllmVendor("groq")).toBe(false);
    expect(isSelfHostedVllmVendor("together")).toBe(false);
    expect(isSelfHostedVllmVendor("deepseek")).toBe(false);
    expect(isSelfHostedVllmVendor("mistral")).toBe(false);
    expect(isSelfHostedVllmVendor("xai")).toBe(false);
    // Non-openai-compatible vendors are false too.
    expect(isSelfHostedVllmVendor("openai")).toBe(false);
    expect(isSelfHostedVllmVendor("claude")).toBe(false);
  });

  it("classifies the self-hosted trusted-network class for private/loopback + insecure-credentialed HTTP", () => {
    // Network-trust SOT — distinct concept from the vLLM request-extension set,
    // even though it mirrors the same ids today. Editing one must not move the
    // other; this pins the current membership.
    expect(isSelfHostedTrustedNetworkVendor("openai-compatible")).toBe(true);
    expect(isSelfHostedTrustedNetworkVendor("litellm")).toBe(true);
    expect(isSelfHostedTrustedNetworkVendor("ollama")).toBe(true);
    expect(isSelfHostedTrustedNetworkVendor("lmstudio")).toBe(true);
    // Commercial OpenAI-compatible gateways are NOT network-trusted.
    expect(isSelfHostedTrustedNetworkVendor("openrouter")).toBe(false);
    expect(isSelfHostedTrustedNetworkVendor("groq")).toBe(false);
    expect(isSelfHostedTrustedNetworkVendor("deepseek")).toBe(false);
    // First-party vendors are excluded too.
    expect(isSelfHostedTrustedNetworkVendor("openai")).toBe(false);
    expect(isSelfHostedTrustedNetworkVendor("claude")).toBe(false);
  });

  it("requires a configured base URL before treating a provider as keyless-ready", () => {
    expect(canUseLlmVendorWithoutApiKey("openai-compatible", { baseUrl: "http://localhost:8000/v1" })).toBe(true);
    expect(canUseLlmVendorWithoutApiKey("openai-compatible", { baseUrl: "  " })).toBe(false);
    expect(canUseLlmVendorWithoutApiKey("openrouter", { baseUrl: "https://openrouter.ai/api/v1" })).toBe(false);
  });

  it("does not offer gpt-4o in user-selectable LLM model options", () => {
    for (const v of LLM_VENDORS) {
      expect(LLM_VENDOR_MODEL_OPTIONS[v]).not.toContain("gpt-4o");
      expect(LLM_VENDOR_DEFAULTS[v].model).not.toBe("gpt-4o");
    }
  });

  it("normalizes the retired exact gpt-4o model id to each provider default", () => {
    expect(isRetiredLlmModel("gpt-4o")).toBe(true);
    expect(isRetiredLlmModel("gpt-4o-mini")).toBe(false);
    expect(isRetiredLlmModel("gpt-4o-deployment")).toBe(false);
    expect(normalizeLlmVendorModel("openai", "gpt-4o")).toBe("gpt-5.4-mini");
    expect(normalizeLlmVendorModel("azure-foundry", "gpt-4o")).toBe("gpt-5.4-mini");
  });

  it("uses gemini-2.5-flash as the Gemini default model", () => {
    expect(LLM_VENDOR_DEFAULTS.gemini.model).toBe("gemini-2.5-flash");
  });

  it("enables thinking by default for every provider", () => {
    for (const v of LLM_VENDORS) {
      expect(LLM_VENDOR_DEFAULTS[v].enableThinking).toBe(true);
    }
  });

  it("freshVendorBlocks() preserves the default-visible thinking-enabled blocks", () => {
    const blocks = freshVendorBlocks();
    expect(blocks.openai.model).toBe("gpt-5.4-mini");
    expect(blocks.gemini.model).toBe("gemini-2.5-flash");
    expect(blocks.groq).toBeUndefined();
    for (const v of DEFAULT_VISIBLE_LLM_VENDOR_IDS) {
      expect(blocks[v].enableThinking).toBe(true);
    }
  });

  it("getLlmVendorSettings() materializes missing marketplace blocks from defaults", () => {
    const block = getLlmVendorSettings(freshVendorBlocks(), "groq");
    expect(block.model).toBe(LLM_VENDOR_DEFAULTS.groq.model);
    expect(block.enableThinking).toBe(true);
  });

  it("includes each provider's default model in its dropdown options", () => {
    for (const v of LLM_VENDORS) {
      const options = LLM_VENDOR_MODEL_OPTIONS[v];
      const defaultModel = LLM_VENDOR_DEFAULTS[v].model;
      // Handshake-only providers (openai-compatible) ship no static catalog and
      // no default model — the list is fetched live from the endpoint's /models
      // handshake, so there is nothing to cross-check here.
      if (options.length === 0) {
        expect(defaultModel, `${v} handshake-only default must be empty`).toBe("");
        continue;
      }
      expect(options).toContain(defaultModel);
    }
  });
});
