/**
 * Reviewer agent boot wiring.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 5,
 * §11 v2.1 binding decisions (default `provider="openai"`,
 * `model="gpt-4o-mini"`, `fallbackOnError ∈ {deny, rule}` with
 * fail-closed default).
 *
 * This step wires the {@link RiskClassifier}, cache, and deferred queue into
 * {@link PermissionManager}:
 *
 * 1. Read `permissions.reviewer` block from `~/.lvis/settings.json`.
 * 2. For `mode: "rule" | "disabled"` — sync classifier, no provider needed.
 * 3. For `mode: "llm"` — wrap host's existing LLMProvider in a thin
 *    {@link LlmReviewerProviderAdapter} that translates the provider's
 *    chunked `streamTurn` interface into the one-shot `complete` shape
 *    {@link LlmRiskClassifier} expects.
 * 4. Construct the cache + deferred queue (default file paths under
 *    `~/.lvis/permissions/`).
 * 5. Call {@link PermissionManager.setReviewer} so {@link
 *    PermissionManager.dispatchReviewer} can support foreground auto-review
 *    approval prompts and headless MED/HIGH queue deferral.
 *
 * Atomic cutover (CLAUDE.md No-Fallback): if `mode: "llm"` is configured
 * but the boot caller fails to supply a provider factory, this module
 * throws — there's no silent fallback to rule-based.
 */
import {
  createRiskClassifier,
  type LlmCompletionResult,
  type LlmReviewerProvider,
  type RiskClassifier,
  type ReviewerSettings,
} from "../../permissions/reviewer/risk-classifier.js";
import {
  createFoundryProvider,
  createGcpPlaygroundProvider,
} from "../../permissions/reviewer/provider-adapters.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  readPermissionSettings,
  type ReviewerSettingsBlock,
} from "../../permissions/permission-settings-store.js";
import type { LLMProvider } from "../../engine/llm/types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("reviewer-wiring");

/**
 * Adapt a host {@link LLMProvider} (the one running interactive chat)
 * to the reviewer's one-shot `complete` shape. Collects the streamed
 * `text_delta` events into a single string and surfaces token + cost
 * telemetry from the final `message_complete` event.
 *
 * The reviewer prompt is short and the response is a small JSON object,
 * so a buffered collect (rather than incremental parse) is the simplest
 * correct shape.
 */
export class LlmReviewerProviderAdapter implements LlmReviewerProvider {
  constructor(private readonly provider: LLMProvider) {}

  async complete(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    abortSignal?: AbortSignal;
  }): Promise<LlmCompletionResult> {
    let text = "";
    let tokensIn = 0;
    let tokensOut = 0;
    const stream = this.provider.streamTurn({
      model: params.model,
      systemPrompt: params.systemPrompt,
      messages: [{ role: "user", content: params.userPrompt }],
      abortSignal: params.abortSignal,
    });
    for await (const event of stream) {
      if (params.abortSignal?.aborted) {
        throw new Error("reviewer LLM call aborted");
      }
      switch (event.type) {
        case "text_delta":
          text += event.text;
          break;
        case "message_complete":
          if (event.usage) {
            tokensIn = event.usage.inputTokens;
            tokensOut = event.usage.outputTokens;
          }
          break;
        case "error":
          throw new Error(`reviewer provider error: ${event.error}`);
        default:
          // reasoning_delta / tool_call ignored — reviewer prompt
          // never asks for tools and reasoning text is not used.
          break;
      }
    }
    // costUsd is not surfaced on StreamEvent — let the upstream
    // pricing layer compute it offline if needed; reviewer telemetry
    // tolerates 0 here.
    return { text, tokensIn, tokensOut, costUsd: 0 };
  }
}

/**
 * Inputs to the reviewer-wiring boot step.
 *
 * `streamProviderFor` resolves a host {@link LLMProvider} for a given
 * vendor name. Boot calls this only when `settings.reviewer.mode === "llm"`.
 * Returning `null` indicates the vendor is not configured; the caller
 * then fails the boot step (atomic cutover, no silent fallback).
 *
 * C3 key inheritance: `foundry` reads `llm.apiKey.azure-foundry` via
 * `getSecret` and the endpoint via `getFoundryEndpoint` (plain setting,
 * not a secret). `gcp-playground` reads `llm.apiKey.gemini` via `getSecret`.
 * This eliminates separate reviewer secret storage — users who have chat
 * working with Azure AI Foundry or Google Gemini get the reviewer provider
 * automatically.
 */
export interface WireReviewerDeps {
  permissionManager: PermissionManager;
  /**
   * Settings reader — defaults to {@link readPermissionSettings} which
   * pulls from `~/.lvis/settings.json`. Override in tests.
   */
  readSettings?: () => ReviewerSettingsBlock;
  /**
   * Provider factory for `mode: "llm"` with `openai | anthropic | google`
   * providers. Boot calls this only for the stream-based host providers.
   * Returning `null` means "vendor not configured" — wiring fails closed.
   * Not called for `foundry` or `gcp-playground` (direct HTTP adapters).
   */
  streamProviderFor?: (vendor: string) => LLMProvider | null;
  /**
   * C3 — Secret accessor for Foundry and GCP playground providers.
   * Required when `settings.reviewer.provider` is `"foundry"` or
   * `"gcp-playground"`. Reads `llm.apiKey.azure-foundry` (Foundry) or
   * `llm.apiKey.gemini` (GCP). Override in tests to supply fake secrets.
   */
  getSecret?: (key: string) => string | null;
  /**
   * C3 — Endpoint accessor for the Foundry provider. Reads the plain
   * (non-secret) `llm.vendors.azure-foundry.baseUrl` setting. Required
   * when `settings.reviewer.provider` is `"foundry"`. Override in tests.
   */
  getFoundryEndpoint?: () => string | null;
  /** Test override for the cache file path. */
  verdictCachePath?: string;
  /** Test override for the deferred queue file path. */
  deferredQueuePath?: string;
  /** Notify the foreground renderer whenever pending deferred entries change. */
  onDeferredPendingChange?: (summary: { pending: number }) => void;
}

export interface WireReviewerResult {
  classifier: RiskClassifier;
  cache: VerdictCache;
  deferredQueue: DeferredQueue;
  /** Reviewer block actually applied (post-normalisation). */
  appliedSettings: ReviewerSettingsBlock;
}

/**
 * Wire the reviewer agent. Idempotent — calling twice replaces the
 * previously-installed classifier on `permissionManager`.
 */
export function wireReviewerAgent(deps: WireReviewerDeps): WireReviewerResult {
  const settings = (deps.readSettings ?? defaultReadSettings)();
  const cache = new VerdictCache(deps.verdictCachePath);
  const deferredQueue = new DeferredQueue(
    deps.deferredQueuePath,
    deps.onDeferredPendingChange,
  );

  let classifier: RiskClassifier;
  if (settings.mode === "disabled" || settings.mode === "rule") {
    classifier = createRiskClassifier({ mode: settings.mode });
    log.info("boot: reviewer wired (mode=%s)", settings.mode);
  } else {
    // mode === "llm"
    const adapter = resolveReviewerAdapter(settings.provider, deps);
    const reviewerSettings: ReviewerSettings = {
      mode: "llm",
      provider: adapter,
      model: settings.model,
      fallbackOnError: settings.fallbackOnError,
    };
    classifier = createRiskClassifier(reviewerSettings);
    log.info(
      "boot: reviewer wired (mode=llm provider=%s model=%s fallback=%s)",
      settings.provider,
      settings.model,
      settings.fallbackOnError,
    );
  }

  deps.permissionManager.setReviewer({
    classifier,
    cache,
    deferredQueue,
    cacheScope: {
      mode: settings.mode,
      provider: settings.provider,
      model: settings.model,
      fallbackOnError: settings.fallbackOnError,
      // Include interactive auto-approve in the cache scope so a setting
      // change naturally invalidates cached verdicts. Without this,
      // toggling autoApprove off → on could reuse a stale verdict that
      // was produced under different policy assumptions.
      interactiveAutoApprove: settings.interactive.autoApprove,
    },
  });
  // Issue #690 — push the interactive auto-approve policy onto the
  // PermissionManager so its gate can opt-in to the foreground reviewer
  // lane without re-reading settings on every tool call.
  deps.permissionManager.setInteractiveAutoApprove(settings.interactive.autoApprove);

  // Round-2 architect + critic + security MAJOR — migration breadcrumb
  // for users upgrading from a pre-PR install where `mode="auto"` was
  // the standalone trigger for foreground auto-approve. Post-PR the
  // SOT moved to `permissions.reviewer.interactive.autoApprove`; if a
  // user's existing `mode="auto"` lands without the new field, every
  // mutating tool now hits a modal. Log a one-line warning so the user
  // can flip the setting (`/permission reviewer interactive low`) and
  // see the breadcrumb in the log instead of silently wondering.
  if (
    deps.permissionManager.getMode() === "auto" &&
    settings.interactive.autoApprove === "off"
  ) {
    log.warn(
      "legacy exec mode=auto + reviewer.interactive.autoApprove=off — " +
      "foreground auto-approve disabled. Use `/permission reviewer interactive low` " +
      "to re-enable LOW-verdict silent allow.",
    );
  }
  // Round-4 critic MAJOR-4 — symmetric inverted case. `mode=strict`
  // promises "ask about everything" but `interactive.autoApprove=low`
  // silently bypasses LOW mutating tools. These directly contradict.
  // Warn at boot so the user notices the inconsistency.
  if (
    deps.permissionManager.getMode() === "strict" &&
    settings.interactive.autoApprove === "low"
  ) {
    log.warn(
      "exec mode=strict + reviewer.interactive.autoApprove=low — " +
      "strict mode promises a modal for every tool call but interactive " +
      "auto-approve silently allows LOW mutating calls. Flip one of the " +
      "two to resolve the contradiction.",
    );
  }
  // Round-5 architect MAJOR — `mode="allow"` bypasses the reviewer
  // entirely, so the `interactive.autoApprove` setting is dead config.
  // A user reading PermissionsTab might assume `interactive=off`
  // protects them — but `allow` is strictly more permissive than the
  // reviewer lane. Warn so the user notices the disabled-but-set
  // signal is misleading.
  if (deps.permissionManager.getMode() === "allow") {
    log.warn(
      "exec mode=allow — reviewer (and reviewer.interactive.autoApprove) is " +
      "bypassed for all non-hard-blocked tools. `interactive.autoApprove` " +
      "setting has no effect under allow mode.",
    );
  }
  return { classifier, cache, deferredQueue, appliedSettings: settings };
}

function defaultReadSettings(): ReviewerSettingsBlock {
  return readPermissionSettings().permissions.reviewer;
}

/**
 * Resolve a concrete {@link LlmReviewerProvider} adapter for the configured
 * provider name. Throws with a clear message if the provider cannot be
 * instantiated (missing key, missing factory) — atomic cutover, no silent
 * fallback per CLAUDE.md No-Fallback.
 *
 * C3: `foundry` and `gcp-playground` use direct HTTP adapters keyed from
 * the encrypted secret store via `deps.getSecret`. `openai`, `anthropic`,
 * and `google` use the host's streaming LLMProvider via `deps.streamProviderFor`.
 */
function resolveReviewerAdapter(
  provider: string,
  deps: WireReviewerDeps,
): LlmReviewerProvider {
  if (provider === "foundry") {
    if (!deps.getSecret) {
      throw new Error(
        `Permission reviewer wiring: provider='foundry' requires getSecret to be supplied. ` +
        `Boot caller must provide a secret accessor (atomic cutover — no silent fallback).`,
      );
    }
    const adapter = createFoundryProvider(
      deps.getSecret,
      deps.getFoundryEndpoint ?? (() => null),
    );
    if (!adapter) {
      throw new Error(
        `Permission reviewer wiring: provider='foundry' — API key or endpoint not configured. ` +
        `Set the Azure AI Foundry API key ('llm.apiKey.azure-foundry') and endpoint ` +
        `('llm.vendors.azure-foundry.baseUrl') via the chat LLM provider settings, ` +
        `or change the reviewer provider.`,
      );
    }
    return adapter;
  }

  if (provider === "gcp-playground") {
    if (!deps.getSecret) {
      throw new Error(
        `Permission reviewer wiring: provider='gcp-playground' requires getSecret to be supplied. ` +
        `Boot caller must provide a secret accessor (atomic cutover — no silent fallback).`,
      );
    }
    const adapter = createGcpPlaygroundProvider(deps.getSecret);
    if (!adapter) {
      throw new Error(
        `Permission reviewer wiring: provider='gcp-playground' — API key not configured. ` +
        `Set the Google Gemini API key ('llm.apiKey.gemini') via the chat LLM provider ` +
        `settings, or change the reviewer provider.`,
      );
    }
    return adapter;
  }

  // openai | anthropic | google — use host streaming LLMProvider
  if (!deps.streamProviderFor) {
    throw new Error(
      `Permission reviewer wiring: settings.reviewer.mode='llm' but no streamProviderFor supplied. ` +
      `Boot caller must provide a provider factory (atomic cutover — no silent fallback).`,
    );
  }
  const upstream = deps.streamProviderFor(provider);
  if (!upstream) {
    throw new Error(
      `Permission reviewer wiring: settings.reviewer.provider='${provider}' is not configured. ` +
      `Add an API key for ${provider} or change reviewer mode.`,
    );
  }
  return new LlmReviewerProviderAdapter(upstream);
}
