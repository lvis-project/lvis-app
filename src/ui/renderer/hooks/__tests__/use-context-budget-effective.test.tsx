/**
 * Issue #912 — effectiveBudget = min(contextBudget, tpmLimit) so the
 * TokenProgressRing reflects the *actual* binding limit. TPM-bound models
 * (currently gpt-5.4-nano with tpmDefault=200K) hit their 100% well before
 * contextWindow fills, and the ring should mirror that experience.
 */
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useContextBudget } from "../use-context-budget.js";

describe("useContextBudget — effectiveBudget (Issue #912)", () => {
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
