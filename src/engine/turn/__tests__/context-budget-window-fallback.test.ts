/**
 * The warning a budget resting on a guess owes the user.
 *
 * When no source knows the served model's capacity, compaction is budgeted
 * against the conservative fallback window. That is a silent misconfiguration:
 * a 229K-window deployment gets compacted at a third of its real capacity and
 * nothing in the UI says why. The host says it once, naming the model and the
 * setting that fixes it.
 *
 * Separate file because it mocks the logger for the whole module registry, and
 * the compaction suites next door run the code paths that log through it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every import, so the double it hands back has to
// be hoisted with it.
const logged = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: () => logged,
}));

import type { ConversationLoop } from "../../conversation-loop.js";
import { contextBudgetForCurrentRuntime } from "../compaction.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { FALLBACK_PRICING } from "../../../shared/pricing-data.js";
import { getPreflightThreshold } from "../../../shared/context-budget.js";

function loopOnModel(model: string, contextWindow?: number): ConversationLoop {
  const llm = fakeLlmSettings({ provider: "openai-compatible", model }) as Record<string, unknown>;
  if (contextWindow !== undefined) {
    (llm.vendors as Record<string, Record<string, unknown>>)["openai-compatible"].contextWindow =
      contextWindow;
  }
  return {
    provider: null,
    deps: {
      settingsService: {
        get: (key: string) => (key === "llm" ? llm : {}),
      },
    },
  } as unknown as ConversationLoop;
}

beforeEach(() => {
  logged.warn.mockClear();
});

describe("context budget — unknown context window", () => {
  it("warns once per route, naming the model and the setting to declare", () => {
    const loop = loopOnModel("a-model-nothing-knows");

    const budget = contextBudgetForCurrentRuntime(loop);
    contextBudgetForCurrentRuntime(loop);
    contextBudgetForCurrentRuntime(loop);

    expect(budget.contextWindowSource).toBe("fallback");
    expect(budget.preflight).toBe(getPreflightThreshold(FALLBACK_PRICING.contextWindow));
    expect(logged.warn).toHaveBeenCalledTimes(1);
    const message = String(logged.warn.mock.calls[0]?.[0]);
    expect(message).toContain("a-model-nothing-knows");
    expect(message).toContain("contextWindow");
  });

  it("says nothing when the route declares its window", () => {
    const budget = contextBudgetForCurrentRuntime(
      loopOnModel("another-model-nothing-knows", 229_376),
    );

    expect(budget.contextWindowSource).toBe("vendor-setting");
    expect(budget.preflight).toBe(getPreflightThreshold(229_376));
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("says nothing when the pricing catalog knows the model", () => {
    const budget = contextBudgetForCurrentRuntime(loopOnModel("Qwen3.6-35B-A3B-NVFP4"));

    expect(budget.contextWindowSource).toBe("pricing-catalog");
    expect(logged.warn).not.toHaveBeenCalled();
  });
});
