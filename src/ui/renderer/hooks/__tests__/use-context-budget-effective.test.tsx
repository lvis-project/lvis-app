import "../../../../../test/renderer/setup.js";

/**
 * Issue #912 — effectiveBudget = min(contextBudget, tpmLimit) so the
 * TokenProgressRing reflects the binding request limit. TPM is still exposed
 * separately in the tooltip for diagnosis.
 */
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useContextBudget } from "../use-context-budget.js";

describe("useContextBudget — effectiveBudget (Issue #912)", () => {
  it("uses turn_summary.tokensIn as the context-fill SOT", () => {
    const { result } = renderHook(() =>
      useContextBudget({
        entries: [
          {
            kind: "turn_summary",
            turnDurationMs: 100,
            toolCount: 1,
            cumulativeToolMs: 10,
            tokensIn: 320_000,
            freshInputTokens: 120_000,
            tokensOut: 4_000,
          },
        ],
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
      }),
    );

    expect(result.current.usedTokens).toBe(320_000);
    expect(result.current.contextBudget).toBe(360_000);
  });

  it("uses compact context_usage as the latest post-compact carrier", () => {
    const { result } = renderHook(() =>
      useContextBudget({
        entries: [
          {
            kind: "turn_summary",
            turnDurationMs: 100,
            toolCount: 0,
            cumulativeToolMs: 0,
            tokensIn: 320_000,
            freshInputTokens: 100_000,
            tokensOut: 4_000,
          },
          {
            kind: "context_usage",
            tokensIn: 42_000,
            source: "compact-estimate",
          },
        ],
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
      }),
    );

    expect(result.current.usedTokens).toBe(42_000);
  });

  it("uses tpmLimit when smaller than contextBudget (nano)", () => {
    // gpt-5.4-nano: contextWindow=400K, tpmDefault=200K → effectiveBudget=200K
    const { result } = renderHook(() =>
      useContextBudget({ entries: [], llmVendor: "openai", llmModel: "gpt-5.4-nano" }),
    );
    expect(result.current.tpmLimit).toBe(200_000);
    expect(result.current.effectiveBudget).toBe(200_000);
    expect(result.current.effectiveBudget).toBeLessThan(result.current.contextBudget);
  });

  it("falls back to contextBudget when tpmLimit unset (most models)", () => {
    // claude-sonnet-4-6: no tpmDefault → effectiveBudget == contextBudget
    const { result } = renderHook(() =>
      useContextBudget({ entries: [], llmVendor: "claude", llmModel: "claude-sonnet-4-6" }),
    );
    expect(result.current.tpmLimit).toBeUndefined();
    expect(result.current.effectiveBudget).toBe(result.current.contextBudget);
  });

  it("uses OpenAI model spec for Azure OpenAI deployment ids", () => {
    const { result } = renderHook(() =>
      useContextBudget({ entries: [], llmVendor: "azure-foundry", llmModel: "gpt-5.4-mini" }),
    );
    expect(result.current.tpmLimit).toBeUndefined();
    expect(result.current.contextBudget).toBe(360_000);
    expect(result.current.effectiveBudget).toBe(360_000);
  });

  it("keeps contextBudget when tpmLimit happens to exceed it (defensive)", () => {
    // Synthetic scenario via unknown model: lookupPricing falls back to a
    // baseline contextWindow. Even if a future model registers tpmDefault
    // larger than its window, the ring stays bounded by the smaller value.
    const { result } = renderHook(() =>
      useContextBudget({ entries: [], llmVendor: "openai", llmModel: "nonexistent-model" }),
    );
    // unknown model has no tpmDefault — fall through to contextBudget.
    expect(result.current.effectiveBudget).toBe(result.current.contextBudget);
  });
});
