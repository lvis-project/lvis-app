/**
 * Reviewer agent boot wiring.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 5,
 * §11 v2.1 binding decisions plus active-LLM following: persisted
 * `permissions.reviewer.provider/model` are legacy fields, while runtime
 * `mode="llm"` uses the active chat provider/model when boot supplies it.
 * `fallbackOnError ∈ {deny, rule}` with fail-closed default.
 *
 * This step wires the {@link RiskClassifier}, cache, and deferred queue into
 * {@link PermissionManager}:
 *
 * 1. Read `permissions.reviewer` block from `~/.lvis/settings.json`.
 * 2. For `mode: "rule" | "disabled" | "strict"` — sync classifier, no provider
 *    needed.
 * 3. For `mode: "llm"` — follow the active chat LLM provider/model and wrap
 *    host's existing LLMProvider in a thin
 *    {@link LlmReviewerProviderAdapter} that translates the provider's
 *    chunked `streamTurn` interface into the one-shot `complete` shape
 *    {@link LlmRiskClassifier} expects.
 * 4. Construct the cache + deferred queue (default file paths under
 *    `~/.lvis/permissions/`).
 * 5. Call {@link PermissionManager.setReviewer} so {@link
 *    PermissionManager.dispatchReviewer} can support foreground auto-review
 *    approval prompts and headless MED/HIGH queue deferral.
 *
 * Fresh-install degrade (CLAUDE.md No-Fallback boundary case): if `mode: "llm"`
 * is configured but the LLM provider/API key is not yet available (fresh
 * install before login), adapter resolution throws. Because the default mode is
 * now "llm", an unguarded throw here would crash the first boot — so the llm
 * branch catches the adapter-resolution failure and degrades to the rule
 * classifier (`runtimeMode = "llm-degraded-to-rule"`). This is the external
 * boundary the No-Fallback rule explicitly permits (missing user API key is an
 * external configuration state), the degrade is fail-safe (rule is stricter
 * than disabled), and it is self-healing (configuring a provider re-fires
 * wiring and restores "llm") — the self-heal IS the deprecation path, so no
 * lingering shim remains.
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
import type { LLMProvider, LLMVendor } from "../../engine/llm/types.js";
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
 * Key inheritance: `foundry` reads `llm.apiKey.azure-foundry` via
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
   * Active chat LLM identity. When supplied, reviewer mode="llm" follows this
   * provider/model instead of the legacy permissions.reviewer provider/model
   * fields, so the permission reviewer stays on the same vendor/model as chat.
   */
  readActiveLlm?: () => ActiveReviewerLlmIdentity;
  /**
   * Provider factory for `mode: "llm"` stream-based host providers. Legacy
   * reviewer names (`openai | anthropic | google`) and active LLM vendor names
   * (`claude | openai | gemini | copilot | azure-foundry | vertex-ai`) can
   * reach this callback.
   * Returning `null` means "vendor not configured" — wiring fails closed.
   * Not called for `foundry` or `gcp-playground` (direct HTTP adapters).
   */
  streamProviderFor?: (vendor: string) => LLMProvider | null;
  /**
   * Secret accessor for Foundry and GCP playground providers.
   * Required when `settings.reviewer.provider` is `"foundry"` or
   * `"gcp-playground"`. Reads `llm.apiKey.azure-foundry` (Foundry) or
   * `llm.apiKey.gemini` (GCP). Override in tests to supply fake secrets.
   */
  getSecret?: (key: string) => string | null;
  /**
   * Endpoint accessor for the Foundry provider. Reads the plain
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

/**
 * Runtime reviewer mode discriminant — what classifier the runtime actually
 * runs, which can differ from the persisted {@link ReviewerSettingsBlock.mode}.
 * `"llm-degraded-to-rule"` is emitted when persisted mode is `"llm"` but the
 * provider adapter could not be instantiated at boot (fresh install: no chat
 * provider/key configured) and wiring fell back to the rule classifier. UI and
 * boot diagnostics consume this; it is never persisted to settings.
 */
export type RuntimeReviewerMode =
  | "disabled"
  | "rule"
  | "llm"
  | "strict"
  | "llm-degraded-to-rule";

export interface WireReviewerResult {
  classifier: RiskClassifier;
  cache: VerdictCache;
  deferredQueue: DeferredQueue;
  /** Persisted reviewer block actually loaded (post-normalisation). */
  appliedSettings: ReviewerSettingsBlock;
  /** Provider/model actually used by the runtime after active-LLM following. */
  effectiveSettings: EffectiveReviewerSettings;
  /**
   * Classifier the runtime actually wired. Equals `appliedSettings.mode` except
   * when an "llm" mode degraded to rule (`"llm-degraded-to-rule"`).
   */
  runtimeMode: RuntimeReviewerMode;
}

export interface ActiveReviewerLlmIdentity {
  provider: LLMVendor;
  marketplaceProviderPresetId?: string;
  model: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
}

type EffectiveReviewerSettings = Omit<ReviewerSettingsBlock, "provider"> & {
  provider: string;
  marketplaceProviderPresetId?: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
};

/**
 * Wire the reviewer agent. Idempotent — calling twice replaces the
 * previously-installed classifier on `permissionManager`.
 *
 * MEDIUM: VerdictCache and DeferredQueue are lightweight file-backed stores
 * with no persistent open file handles — each operation opens, appends, and
 * closes atomically via withFileLock. Creating new instances on re-wire is
 * therefore safe: the new instances share the same backing files as the old
 * ones and no write-queue state is lost. The `onDeferredPendingChange`
 * callback is re-supplied so the new queue instance keeps notifying the
 * renderer. For settings changes that only affect the classifier (provider,
 * model, fallbackOnError), the cache and queue file paths are identical
 * across rewires — the data persists transparently.
 */
export function wireReviewerAgent(deps: WireReviewerDeps): WireReviewerResult {
  const settings = (deps.readSettings ?? defaultReadSettings)();
  const effectiveSettings = resolveEffectiveSettings(settings, deps);
  const cache = new VerdictCache(deps.verdictCachePath);
  const deferredQueue = new DeferredQueue(
    deps.deferredQueuePath,
    deps.onDeferredPendingChange,
  );

  let classifier: RiskClassifier;
  // Runtime classifier discriminant — diverges from persisted mode only on
  // the llm-degraded-to-rule path below.
  let runtimeMode: RuntimeReviewerMode = settings.mode;
  let degradedToRule = false;
  if (settings.mode === "disabled" || settings.mode === "strict" || settings.mode === "rule") {
    classifier = createRiskClassifier({ mode: settings.mode });
    log.info("boot: reviewer wired (mode=%s)", settings.mode);
  } else {
    // mode === "llm"
    //
    // CLAUDE.md No-Fallback compliance for the degrade path below:
    //   - External boundary: `resolveReviewerAdapter` throws only when the
    //     user-supplied LLM provider/API key is absent or invalid — that is an
    //     *external configuration state* (the user has not finished login),
    //     not an internal contract violation. Catching it here is the boundary
    //     handling the No-Fallback rule explicitly permits.
    //   - Fail-safe, not fail-open: degrading to the rule classifier is
    //     *stricter* than "disabled" (rule still raises MEDIUM/HIGH for
    //     un-sandboxed writes/network), so the catch never makes the system
    //     more permissive than the user's intent.
    //   - Self-healing IS the deprecation path: there is no lingering shim.
    //     The moment a provider/key is configured, the auth login flow
    //     (ipc/domains/auth.ts) and settings:update both re-fire
    //     `rewireReviewerAgent()`, this branch instantiates the adapter
    //     successfully, and `runtimeMode` returns to "llm". No removal date is
    //     needed because the degrade has no persisted footprint.
    //
    // Scope discipline: the try only wraps `resolveReviewerAdapter`, which is
    // the sole call that throws on the external boundary (missing user API
    // key). The classifier construction + telemetry log below run *outside*
    // the catch so that any internal programming error there (a contract
    // violation, not an external configuration state) surfaces loudly rather
    // than being silently swallowed as a degrade. No-Fallback strictness:
    // only the documented external boundary is caught.
    let adapter: LlmReviewerProvider | undefined;
    try {
      adapter = resolveReviewerAdapter(effectiveSettings.provider, deps);
    } catch (err) {
      // Discriminate the two failure classes resolveReviewerAdapter can
      // throw: only ReviewerProviderUnconfiguredError (user has not
      // configured the provider/API key — the external boundary) degrades.
      // A contract violation (boot caller forgot getSecret /
      // streamProviderFor — a plain Error) is a caller bug and must crash
      // boot loudly, never silently degrade.
      if (!(err instanceof ReviewerProviderUnconfiguredError)) throw err;
      degradedToRule = true;
      runtimeMode = "llm-degraded-to-rule";
      log.warn(
        { provider: effectiveSettings.provider, error: (err as Error).message },
        "boot: reviewer mode=llm requested but provider could not be wired — " +
          "degrading to rule classifier. Reviewer auto-heals to llm once an LLM " +
          "provider/API key is configured (login or Intelligence settings re-fires wiring).",
      );
    }
    if (adapter) {
      const reviewerSettings: ReviewerSettings = {
        mode: "llm",
        provider: adapter,
        model: effectiveSettings.model,
        fallbackOnError: settings.fallbackOnError,
      };
      classifier = createRiskClassifier(reviewerSettings);
      log.info(
        "boot: reviewer wired (mode=llm provider=%s model=%s fallback=%s)",
        effectiveSettings.provider,
        effectiveSettings.model,
        settings.fallbackOnError,
      );
    } else {
      classifier = createRiskClassifier({ mode: "rule" });
    }
  }

  deps.permissionManager.setReviewer({
    classifier,
    cache,
    deferredQueue,
    degradedToRule,
    cacheScope: {
      // Use the *runtime* mode so verdicts produced by the degraded rule
      // classifier are not reused once wiring heals back to a real "llm"
      // classifier (the rule verdict was computed under different
      // assumptions). On heal, runtimeMode flips "llm-degraded-to-rule" →
      // "llm" and the scope mismatch forces a cache miss.
      mode: runtimeMode,
      provider: effectiveSettings.provider,
      model: effectiveSettings.model,
      fallbackOnError: settings.fallbackOnError,
      // Include interactive auto-approve in the cache scope so a setting
      // change naturally invalidates cached verdicts. Without this,
      // toggling autoApprove off → on could reuse a stale verdict that
      // was produced under different policy assumptions.
      interactiveAutoApprove: settings.interactive.autoApprove,
      // Include active provider transport identity in cacheScope so baseUrl /
      // Vertex project changes invalidate reviewer verdicts produced under a
      // different upstream deployment.
      providerBaseUrl: effectiveSettings.baseUrl ?? null,
      marketplaceProviderPresetId: effectiveSettings.marketplaceProviderPresetId ?? null,
      vertexProject: effectiveSettings.vertexProject ?? null,
      vertexLocation: effectiveSettings.vertexLocation ?? null,
      // Legacy Foundry endpoint key retained for existing cache-scope tests.
      endpoint:
        effectiveSettings.provider === "foundry" ||
        effectiveSettings.provider === "azure-foundry"
          ? (effectiveSettings.baseUrl ?? deps.getFoundryEndpoint?.() ?? null)
          : null,
    },
  });
  // Issue #690 — push the interactive auto-approve policy onto the
  // PermissionManager so its gate can opt-in to the foreground reviewer
  // lane without re-reading settings on every tool call.
  deps.permissionManager.setInteractiveAutoApprove(settings.interactive.autoApprove);

  // Migration breadcrumb for users upgrading from a pre-PR install where
  // `mode="auto"` was the standalone trigger for foreground auto-approve.
  // Post-PR the SOT moved to `permissions.reviewer.interactive.autoApprove`;
  // if a user's existing `mode="auto"` lands without the new field, every
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
  // Symmetric inverted case: `mode=strict` promises "ask about everything"
  // but `interactive.autoApprove=low` silently bypasses LOW mutating tools.
  // These directly contradict. Warn at boot so the user notices.
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
  // `mode="allow"` bypasses the reviewer entirely, so the
  // `interactive.autoApprove` setting is dead config. A user reading
  // PermissionsTab might assume `interactive=off` protects them — but
  // `allow` is strictly more permissive than the reviewer lane.
  // Warn so the user notices the disabled-but-set signal is misleading.
  if (deps.permissionManager.getMode() === "allow") {
    log.warn(
      "exec mode=allow — reviewer (and reviewer.interactive.autoApprove) is " +
      "bypassed for all non-hard-blocked tools. `interactive.autoApprove` " +
      "setting has no effect under allow mode.",
    );
  }
  return {
    classifier,
    cache,
    deferredQueue,
    appliedSettings: settings,
    effectiveSettings,
    runtimeMode,
  };
}

function defaultReadSettings(): ReviewerSettingsBlock {
  return readPermissionSettings().permissions.reviewer;
}

function resolveEffectiveSettings(
  settings: ReviewerSettingsBlock,
  deps: WireReviewerDeps,
): EffectiveReviewerSettings {
  if (settings.mode !== "llm") return settings;
  const active = deps.readActiveLlm?.();
  if (!active) return settings;
  return {
    ...settings,
    provider: active.provider,
    ...(active.marketplaceProviderPresetId !== undefined
      ? { marketplaceProviderPresetId: active.marketplaceProviderPresetId }
      : {}),
    model: active.model,
    ...(active.baseUrl !== undefined ? { baseUrl: active.baseUrl } : {}),
    ...(active.vertexProject !== undefined ? { vertexProject: active.vertexProject } : {}),
    ...(active.vertexLocation !== undefined ? { vertexLocation: active.vertexLocation } : {}),
  };
}

/**
 * Thrown by {@link resolveReviewerAdapter} ONLY when the user has not (yet)
 * configured the LLM provider/API key — the *external configuration state*
 * the degrade-to-rule boundary in {@link wireReviewerAgent} is allowed to
 * catch. Contract violations (boot caller forgot to supply `getSecret` /
 * `streamProviderFor`) deliberately throw a plain Error instead, so they
 * propagate as loud boot failures and are never silently degraded.
 */
export class ReviewerProviderUnconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerProviderUnconfiguredError";
  }
}

/**
 * Resolve a concrete {@link LlmReviewerProvider} adapter for the configured
 * provider name. Two distinct failure classes:
 *   - {@link ReviewerProviderUnconfiguredError} — the user has not configured
 *     the provider/API key (external boundary; wiring degrades to rule).
 *   - plain Error — the boot caller violated the wiring contract (missing
 *     `getSecret` / `streamProviderFor` dependency); atomic cutover, no
 *     silent fallback per CLAUDE.md No-Fallback — this must crash boot.
 *
 * `foundry` and `gcp-playground` use direct HTTP adapters keyed from
 * the encrypted secret store via `deps.getSecret`. Other provider strings
 * use the host's streaming LLMProvider via `deps.streamProviderFor`.
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
      throw new ReviewerProviderUnconfiguredError(
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
      throw new ReviewerProviderUnconfiguredError(
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
    throw new ReviewerProviderUnconfiguredError(
      `Permission reviewer wiring: settings.reviewer.provider='${provider}' is not configured. ` +
      `Add an API key for ${provider} or change reviewer mode.`,
    );
  }
  return new LlmReviewerProviderAdapter(upstream);
}
