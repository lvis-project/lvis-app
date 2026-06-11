/**
 * Permission policy P4 Area A — reviewer-wiring boot integration tests.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 5,
 * §11 v2.1 binding decisions.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wireReviewerAgent,
  LlmReviewerProviderAdapter,
} from "../reviewer-wiring.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import {
  RuleBasedRiskClassifier,
  DisabledRiskClassifier,
  LlmRiskClassifier,
} from "../../../permissions/reviewer/risk-classifier.js";
import type { LLMProvider, StreamEvent } from "../../../engine/llm/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "permission-policy-p4-rw-"));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** Factory for a stub LLMProvider that yields the supplied StreamEvents. */
function stubProvider(events: StreamEvent[]): LLMProvider {
  return {
    vendor: "openai",
    streamTurn: async function* () {
      for (const e of events) yield e;
    },
  };
}

describe("Permission policy P4 reviewer-wiring", () => {
  it("settings mode=rule wires RuleBasedRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "rule",
        interactive: { autoApprove: "off" },
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(setReviewerSpy).toHaveBeenCalledOnce();
    expect(pm.hasReviewer()).toBe(true);
  });

  it("settings mode=disabled wires DisabledRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "disabled",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "rule",
        interactive: { autoApprove: "off" },
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(DisabledRiskClassifier);
    expect(pm.hasReviewer()).toBe(true);
  });

  it("settings mode=llm + provider available wires LlmRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const provider = stubProvider([
      {
        type: "message_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
    const factorySpy = vi.fn((vendor: string) =>
      vendor === "openai" ? provider : null,
    );
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "rule",
        interactive: { autoApprove: "off" },
      }),
      streamProviderFor: factorySpy,
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(LlmRiskClassifier);
    expect(factorySpy).toHaveBeenCalledWith("openai");
    expect(pm.hasReviewer()).toBe(true);
  });

  it("mode=llm follows active chat LLM provider and model", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");
    const provider = stubProvider([
      {
        type: "message_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
    const factorySpy = vi.fn((vendor: string) =>
      vendor === "claude" ? provider : null,
    );
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      readActiveLlm: () => ({
        provider: "claude",
        model: "claude-sonnet-4-6",
        baseUrl: "https://anthropic-proxy.example/v1",
      }),
      streamProviderFor: factorySpy,
      verdictCachePath: join(tmpDir, "cache-active-llm.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-active-llm.jsonl"),
    });

    expect(result.appliedSettings.provider).toBe("openai");
    expect(result.effectiveSettings.provider).toBe("claude");
    expect(result.effectiveSettings.model).toBe("claude-sonnet-4-6");
    expect(factorySpy).toHaveBeenCalledWith("claude");
    const { cacheScope } = setReviewerSpy.mock.calls[0][0];
    expect(cacheScope?.provider).toBe("claude");
    expect(cacheScope?.model).toBe("claude-sonnet-4-6");
    expect(cacheScope?.providerBaseUrl).toBe("https://anthropic-proxy.example/v1");
  });

  it("mode=llm active cacheScope includes Vertex transport identity", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");
    const provider = stubProvider([
      {
        type: "message_complete",
        stopReason: "end_turn",
      },
    ]);
    const factorySpy = vi.fn((vendor: string) =>
      vendor === "vertex-ai" ? provider : null,
    );

    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      readActiveLlm: () => ({
        provider: "vertex-ai",
        model: "gemini-2.5-pro",
        vertexProject: "prod-project",
        vertexLocation: "us-central1",
      }),
      streamProviderFor: factorySpy,
      verdictCachePath: join(tmpDir, "cache-active-vertex.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-active-vertex.jsonl"),
    });

    expect(result.effectiveSettings.provider).toBe("vertex-ai");
    expect(result.effectiveSettings.vertexProject).toBe("prod-project");
    expect(result.effectiveSettings.vertexLocation).toBe("us-central1");
    expect(factorySpy).toHaveBeenCalledWith("vertex-ai");
    const { cacheScope } = setReviewerSpy.mock.calls[0][0];
    expect(cacheScope?.provider).toBe("vertex-ai");
    expect(cacheScope?.vertexProject).toBe("prod-project");
    expect(cacheScope?.vertexLocation).toBe("us-central1");
  });

  it("mode=llm but no streamProviderFor → degrades to rule (fresh install, no boot crash)", () => {
    // Fresh install: default mode is "llm" but the LLM provider/key is not yet
    // configured. wireReviewerAgent must NOT throw — it degrades to the rule
    // classifier and surfaces the degrade discriminant for the UI/boot warn.
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    let result: ReturnType<typeof wireReviewerAgent>;
    expect(() => {
      result = wireReviewerAgent({
        permissionManager: pm,
        readSettings: () => ({
          mode: "llm",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "deny",
          interactive: { autoApprove: "low" },
        }),
        verdictCachePath: join(tmpDir, "cache-degrade.jsonl"),
        deferredQueuePath: join(tmpDir, "queue-degrade.jsonl"),
      });
    }).not.toThrow();
    expect(result!.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(result!.runtimeMode).toBe("llm-degraded-to-rule");
    // Persisted mode is preserved (still "llm") — only the runtime classifier degrades.
    expect(result!.appliedSettings.mode).toBe("llm");
    expect(pm.hasReviewer()).toBe(true);
    expect(pm.isReviewerDegradedToRule()).toBe(true);
  });

  it("mode=llm + factory null → degrades to rule (provider unconfigured)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        fallbackOnError: "deny",
        interactive: { autoApprove: "low" },
      }),
      streamProviderFor: () => null,
      verdictCachePath: join(tmpDir, "cache-degrade-null.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-degrade-null.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(result.runtimeMode).toBe("llm-degraded-to-rule");
    expect(pm.isReviewerDegradedToRule()).toBe(true);
  });

  it("logs a boot warn on llm→rule degrade", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      wireReviewerAgent({
        permissionManager: pm,
        readSettings: () => ({
          mode: "llm",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "deny",
          interactive: { autoApprove: "low" },
        }),
        verdictCachePath: join(tmpDir, "cache-degrade-warn.jsonl"),
        deferredQueuePath: join(tmpDir, "queue-degrade-warn.jsonl"),
      });
      const fired = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("degrading to rule classifier")),
      );
      expect(fired).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("re-wiring after provider becomes available heals llm-degraded-to-rule → llm", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    // First wiring: no provider → degraded.
    const degraded = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "low" },
      }),
      verdictCachePath: join(tmpDir, "cache-heal-1.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-heal-1.jsonl"),
    });
    expect(degraded.runtimeMode).toBe("llm-degraded-to-rule");
    expect(pm.isReviewerDegradedToRule()).toBe(true);

    // Second wiring: provider now available → heals to llm, flag clears.
    const provider = stubProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const healed = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "low" },
      }),
      streamProviderFor: () => provider,
      verdictCachePath: join(tmpDir, "cache-heal-2.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-heal-2.jsonl"),
    });
    expect(healed.classifier).toBeInstanceOf(LlmRiskClassifier);
    expect(healed.runtimeMode).toBe("llm");
    expect(pm.isReviewerDegradedToRule()).toBe(false);
  });

  it("preserves caller-supplied settings on appliedSettings", () => {
    // Settings loaded externally and passed in via readSettings; assert
    // the wiring surfaces the same block on its result.
    const settingsPath = join(tmpDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: {
          additionalDirectories: [],
          reviewer: {
            mode: "rule",
            provider: "google",
            model: "gemini-2.5-flash",
            fallbackOnError: "deny",
            interactive: { autoApprove: "off" },
          },
        },
      }),
    );
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        provider: "google",
        model: "gemini-2.5-flash",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    expect(result.appliedSettings.provider).toBe("google");
    expect(result.appliedSettings.fallbackOnError).toBe("deny");
  });

  it("pushes interactive.autoApprove onto the live PermissionManager instance (round-3 test-engineer MAJOR-1)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "low" },
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    // Critical post-rewire invariant — the live PermissionManager state
    // reflects the persisted settings without requiring a process
    // restart. A refactor that drops setInteractiveAutoApprove() must
    // be caught here.
    expect(pm.getInteractiveAutoApprove()).toBe("low");
  });

  it("logs boot warning when mode=auto + interactive.autoApprove=off (round-5 test-engineer MAJOR)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    pm.setMode("auto");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      wireReviewerAgent({
        permissionManager: pm,
        readSettings: () => ({
          mode: "rule",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "deny",
          interactive: { autoApprove: "off" },
        }),
        verdictCachePath: join(tmpDir, "cache-warn-auto-off.jsonl"),
        deferredQueuePath: join(tmpDir, "queue-warn-auto-off.jsonl"),
      });
      // The logger calls into pino which may stream via console or a
      // dedicated transport. We use a permissive assertion that fires
      // when *any* warn-level emission contains the canonical phrase.
      // Round-6 test-engineer CRITICAL — strict assertion. The earlier
      // `fired || calls.length===0` form was a tautology that passed
      // even when the warn never fired. The logger's vitest path
      // routes through `console.warn` directly (lib/logger.ts), so
      // `warnSpy.mock.calls` is the SOT.
      const fired = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("legacy exec mode=auto")),
      );
      expect(fired).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs boot warning when mode=strict + interactive.autoApprove=low (round-5 test-engineer MAJOR)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    pm.setMode("strict");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      wireReviewerAgent({
        permissionManager: pm,
        readSettings: () => ({
          mode: "rule",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "deny",
          interactive: { autoApprove: "low" },
        }),
        verdictCachePath: join(tmpDir, "cache-warn-strict.jsonl"),
        deferredQueuePath: join(tmpDir, "queue-warn-strict.jsonl"),
      });
      const fired = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("exec mode=strict")),
      );
      // Round-6 test-engineer CRITICAL — strict, no-tautology assertion.
      expect(fired).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("re-rewiring with a different interactive.autoApprove updates the live state (round-3 test-engineer MAJOR-1)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "low" },
      }),
      verdictCachePath: join(tmpDir, "cache-1.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-1.jsonl"),
    });
    expect(pm.getInteractiveAutoApprove()).toBe("low");
    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      verdictCachePath: join(tmpDir, "cache-2.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-2.jsonl"),
    });
    expect(pm.getInteractiveAutoApprove()).toBe("off");
  });
});

describe("Permission policy C3 foundry/gcp wiring paths", () => {
  it("mode=llm provider=foundry without getSecret → degrades to rule (no boot crash)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "foundry",
        model: "gpt-4o",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      // getSecret intentionally omitted
      getFoundryEndpoint: () => "https://proj.services.ai.azure.com",
      verdictCachePath: join(tmpDir, "cache-foundry-nosecret.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-foundry-nosecret.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(result.runtimeMode).toBe("llm-degraded-to-rule");
    expect(pm.isReviewerDegradedToRule()).toBe(true);
  });

  it("mode=llm provider=foundry with getSecret returning null → degrades to rule", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "foundry",
        model: "gpt-4o",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      getSecret: () => null,
      getFoundryEndpoint: () => "https://proj.services.ai.azure.com",
      verdictCachePath: join(tmpDir, "cache-foundry-nokey.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-foundry-nokey.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(result.runtimeMode).toBe("llm-degraded-to-rule");
    expect(pm.isReviewerDegradedToRule()).toBe(true);
  });

  it("mode=llm provider=foundry with valid secrets → wires LlmRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "foundry",
        model: "gpt-4o",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      getSecret: (key) => {
        if (key === "llm.apiKey.azure-foundry") return "az-api-key";
        return null;
      },
      getFoundryEndpoint: () => "https://proj.services.ai.azure.com",
      verdictCachePath: join(tmpDir, "cache-foundry-ok.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-foundry-ok.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(LlmRiskClassifier);
    expect(pm.hasReviewer()).toBe(true);
  });

  it("mode=llm provider=gcp-playground without getSecret → degrades to rule (no boot crash)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "gcp-playground",
        model: "gemini-1.5-flash",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      // getSecret intentionally omitted
      verdictCachePath: join(tmpDir, "cache-gcp-nosecret.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-gcp-nosecret.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(result.runtimeMode).toBe("llm-degraded-to-rule");
    expect(pm.isReviewerDegradedToRule()).toBe(true);
  });

  it("mode=llm provider=gcp-playground with getSecret returning null → degrades to rule", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "gcp-playground",
        model: "gemini-1.5-flash",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      getSecret: () => null,
      verdictCachePath: join(tmpDir, "cache-gcp-nokey.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-gcp-nokey.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(result.runtimeMode).toBe("llm-degraded-to-rule");
    expect(pm.isReviewerDegradedToRule()).toBe(true);
  });

  it("mode=llm provider=gcp-playground with llm.apiKey.gemini → wires LlmRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "gcp-playground",
        model: "gemini-1.5-flash",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      getSecret: (key) => {
        if (key === "llm.apiKey.gemini") return "AIza-gemini-key";
        return null;
      },
      verdictCachePath: join(tmpDir, "cache-gcp-ok.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-gcp-ok.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(LlmRiskClassifier);
    expect(pm.hasReviewer()).toBe(true);
  });
});

describe("MAJOR-2: cacheScope includes Foundry endpoint", () => {
  it("foundry provider — cacheScope.endpoint set to the current endpoint value", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");
    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "foundry",
        model: "gpt-4o",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      getSecret: (key) => (key === "llm.apiKey.azure-foundry" ? "az-api-key" : null),
      getFoundryEndpoint: () => "https://proj.services.ai.azure.com",
      verdictCachePath: join(tmpDir, "cache-m2-foundry.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-m2-foundry.jsonl"),
    });
    expect(setReviewerSpy).toHaveBeenCalledOnce();
    const { cacheScope } = setReviewerSpy.mock.calls[0][0];
    expect(cacheScope?.endpoint).toBe("https://proj.services.ai.azure.com");
  });

  it("gcp-playground provider — cacheScope.endpoint is null (no configurable endpoint)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");
    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "gcp-playground",
        model: "gemini-1.5-flash",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      getSecret: (key) => (key === "llm.apiKey.gemini" ? "AIza-key" : null),
      verdictCachePath: join(tmpDir, "cache-m2-gcp.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-m2-gcp.jsonl"),
    });
    const { cacheScope } = setReviewerSpy.mock.calls[0][0];
    expect(cacheScope?.endpoint).toBeNull();
  });

  it("openai provider — cacheScope.endpoint is null", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");
    const upstream = {
      vendor: "openai" as const,
      streamTurn: async function* () {},
    };
    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      streamProviderFor: () => upstream,
      verdictCachePath: join(tmpDir, "cache-m2-openai.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-m2-openai.jsonl"),
    });
    const { cacheScope } = setReviewerSpy.mock.calls[0][0];
    expect(cacheScope?.endpoint).toBeNull();
  });

  it("changing endpoint causes different cacheScope — cache miss on re-wire", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");

    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "foundry",
        model: "gpt-4o",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      getSecret: (key) => (key === "llm.apiKey.azure-foundry" ? "az-key" : null),
      getFoundryEndpoint: () => "https://proj-a.services.ai.azure.com",
      verdictCachePath: join(tmpDir, "cache-m2-change-a.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-m2-change-a.jsonl"),
    });
    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "foundry",
        model: "gpt-4o",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      getSecret: (key) => (key === "llm.apiKey.azure-foundry" ? "az-key" : null),
      getFoundryEndpoint: () => "https://proj-b.services.ai.azure.com",
      verdictCachePath: join(tmpDir, "cache-m2-change-b.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-m2-change-b.jsonl"),
    });

    expect(setReviewerSpy).toHaveBeenCalledTimes(2);
    const scope1 = setReviewerSpy.mock.calls[0][0].cacheScope;
    const scope2 = setReviewerSpy.mock.calls[1][0].cacheScope;
    expect(scope1?.endpoint).toBe("https://proj-a.services.ai.azure.com");
    expect(scope2?.endpoint).toBe("https://proj-b.services.ai.azure.com");
    expect(scope1?.endpoint).not.toBe(scope2?.endpoint);
  });
});

describe("Permission policy P4 LlmReviewerProviderAdapter", () => {
  it("collects streamTurn `text_delta` events into a single string", async () => {
    const provider = stubProvider([
      { type: "text_delta", text: '{"level":' },
      { type: "text_delta", text: ' "low",' },
      { type: "text_delta", text: ' "reason": "ok"}' },
      {
        type: "message_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 6 },
      },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    const out = await adapter.complete({
      model: "gpt-4o-mini",
      systemPrompt: "system",
      userPrompt: "user",
    });
    expect(out.text).toBe('{"level": "low", "reason": "ok"}');
    expect(out.tokensIn).toBe(10);
    expect(out.tokensOut).toBe(6);
  });

  it("ignores reasoning_delta + tool_call events", async () => {
    const provider = stubProvider([
      { type: "reasoning_delta", text: "thinking..." },
      { type: "text_delta", text: '{"level":"high"}' },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    const out = await adapter.complete({
      model: "claude-haiku",
      systemPrompt: "s",
      userPrompt: "u",
    });
    expect(out.text).toBe('{"level":"high"}');
  });

  it("throws on `error` stream event", async () => {
    const provider = stubProvider([
      { type: "text_delta", text: '{"level":"low"}' },
      { type: "error", error: "rate limit" },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    await expect(
      adapter.complete({
        model: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
      }),
    ).rejects.toThrow(/rate limit/);
  });

  it("aborts mid-stream when abortSignal fires", async () => {
    const provider = stubProvider([
      { type: "text_delta", text: "first" },
      { type: "text_delta", text: "second" },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    const ac = new AbortController();
    ac.abort();
    await expect(
      adapter.complete({
        model: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
        abortSignal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
