/**
 * Boot step — reviewer agent + permission-manager broadcast wiring
 * (permission policy P4 Layer 5, extracted from boot.ts C18).
 *
 * Pushes the visibility deny rules onto the tool registry, builds the reviewer
 * LLM provider adapters (active-LLM following), wires + fires the reviewer agent
 * binding, and hooks the PermissionManager's broadcast callbacks (user-approval
 * memory hit + config-changed) plus the manifest-integrity violation audit/IPC
 * bridge. `rewireReviewerAgent` is stored on the context so settings/auth
 * changes can re-fire it.
 */
import { sendToWindow } from "../../ipc/safe-send.js";
import { broadcastPermissionConfigChangedFromHost } from "../permission-config-broadcast.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { createProvider, secretKeyFor } from "../../engine/llm/provider-factory.js";
import { selectProviderRuntimeFetch } from "../../engine/llm/marketplace-provider-fetch.js";
import { reviewerVendorFor } from "../../permissions/reviewer/reviewer-vendor-map.js";
import type { LLMProvider } from "../../engine/llm/types.js";
import {
  getLlmVendorSettings,
  isLLMVendor,
  canUseLlmVendorWithoutApiKey,
} from "../../shared/llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
import { LlmReviewerProviderAdapter, wireReviewerAgent } from "./reviewer-wiring.js";
import type { ParentAdjudicationTarget } from "../../permissions/parent-adjudicator.js";
import {
  bindManifestIntegrityAudit,
  manifestIntegrityState,
} from "../../permissions/manifest-integrity.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");

export function wireReviewerAndPermissions(ctx: BootContext): void {
  const {
    toolRegistry,
    permissionManager,
    settingsService,
    llmFetch,
    getMainWindow,
    bootAuditLogger,
    subscriptionProviderFactory,
  } = ctx;

  // §6.3: PermissionManager — instance was constructed before
  // initPluginRuntime (cluster M1) so the resolveApiKey host wiring could
  // see it. Now that toolRegistry is built, push the visibility deny
  // rules across.
  toolRegistry.setDenyRules(permissionManager.getVisibilityDenyRules());

  // Permission policy P4 — Layer 5 reviewer agent wiring.
  // Reads `permissions.reviewer` from `~/.lvis/settings.json` and binds the
  // classifier + cache + deferred queue onto the live PermissionManager so
  // `dispatchReviewer()` routes HIGH verdicts into the deferred queue.
  // For mode=llm, build an adapter over the host's existing
  // VercelUnifiedProvider streaming surface — the reviewer needs only a
  // one-shot complete() call shape.
  const reviewerStreamProviderFor = (vendor: string): LLMProvider | null => {
    const llmSettings = settingsService.get("llm");
    const activeChatRuntime = llmSettings.activeChatRuntime;
    if (activeChatRuntime?.kind === "subscription") {
      // Treat the runtime id as part of the reviewer identity. This keeps
      // verdict cache entries scoped to the authenticated transport and makes
      // a stale active-LLM read fail closed rather than falling through to an
      // API-key provider.
      if (vendor !== `subscription:${activeChatRuntime.provider}`) return null;
      return subscriptionProviderFactory(activeChatRuntime);
    }

    // Reviewer legacy provider names still resolve through the shared map.
    // Active-LLM following passes canonical LLMVendor names directly.
    const llmVendor = reviewerVendorFor(vendor) ?? (isLLMVendor(vendor) ? vendor : null);
    if (!llmVendor) return null;
    const block = getLlmVendorSettings(llmSettings.vendors, llmVendor);
    const hasMarketplaceProviderPresetSelection =
      llmVendor === "openai-compatible" && Boolean(llmSettings.marketplaceProviderPresetId);
    const marketplaceProviderPreset = hasMarketplaceProviderPresetSelection
      ? (settingsService.get("marketplace").installedProviderPresets ?? [])
        .find((preset) => preset.providerId === llmSettings.marketplaceProviderPresetId)
      : undefined;
    if (hasMarketplaceProviderPresetSelection && !marketplaceProviderPreset) {
      return null;
    }
    const apiKey = settingsService.getSecret(
      marketplaceProviderPreset
        ? marketplaceProviderPresetSecretKey(marketplaceProviderPreset.providerId)
        : secretKeyFor(llmVendor),
    );
    const effectiveBaseUrl = marketplaceProviderPreset
      ? marketplaceProviderPreset.baseUrl
      : block.baseUrl;
    const isVertex = llmVendor === "vertex-ai";
    const canUseWithoutApiKey = marketplaceProviderPreset
      ? marketplaceProviderPreset.requiresApiKey === false && Boolean(effectiveBaseUrl?.trim())
      : canUseLlmVendorWithoutApiKey(llmVendor, block);
    if (!apiKey && !isVertex && !canUseWithoutApiKey) return null;
    if (
      isVertex &&
      !block.vertexProject &&
      !process.env.GOOGLE_CLOUD_PROJECT &&
      !process.env.GCLOUD_PROJECT
    ) {
      return null;
    }
    const providerFetch = selectProviderRuntimeFetch({
      vendor: llmVendor,
      baseUrl: effectiveBaseUrl,
      providerMetadata: marketplaceProviderPreset,
      llmFetch,
    });
    return createProvider({
      vendor: llmVendor,
      apiKey: apiKey ?? "",
      model: block.model,
      ...(providerFetch ? { fetch: providerFetch } : {}),
      ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
      ...(marketplaceProviderPreset ? { providerMetadata: marketplaceProviderPreset } : {}),
      ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
      ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
    });
  };
  const readActiveReviewerLlm = () => {
    const llm = settingsService.get("llm");
    const activeChatRuntime = llm.activeChatRuntime;
    if (activeChatRuntime?.kind === "subscription") {
      return {
        provider: `subscription:${activeChatRuntime.provider}` as `subscription:${typeof activeChatRuntime.provider}`,
        model: activeChatRuntime.model ?? "default",
      };
    }
    const provider = llm.provider;
    const block = getLlmVendorSettings(llm.vendors, provider);
    const activeMarketplaceProviderPreset =
      provider === "openai-compatible" && llm.marketplaceProviderPresetId
        ? (settingsService.get("marketplace").installedProviderPresets ?? [])
          .find((preset) => preset.providerId === llm.marketplaceProviderPresetId)
        : undefined;
    const providerBaseUrl = activeMarketplaceProviderPreset?.baseUrl ?? block.baseUrl;
    return {
      provider,
      ...(provider === "openai-compatible" && llm.marketplaceProviderPresetId
        ? { marketplaceProviderPresetId: llm.marketplaceProviderPresetId }
        : {}),
      model: block.model,
      ...(providerBaseUrl ? { baseUrl: providerBaseUrl } : {}),
      ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
      ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
    };
  };
  /**
   * The provider/model a parent session's own chat loop runs on, for tier 2's
   * `model: "parent-session"` option.
   *
   * Built from the same settings the loop's own provider construction reads —
   * the active chat runtime, or the configured vendor block — rather than from
   * a live loop object, so it answers for a parent session whether or not that
   * loop is the one currently running in this process. Resolved per ask, and
   * `null` whenever the chat provider is unconfigured, which escalates that ask
   * to the user rather than quietly answering it on another model.
   *
   * The session id is accepted and not yet consulted: no session carries its
   * own provider/model today, and this is the seam a per-session identity would
   * arrive on rather than at the gate's call site.
   */
  const resolveParentSessionAdjudicationTarget = (
    _parentSessionId: string,
  ): ParentAdjudicationTarget | null => {
    const identity = readActiveReviewerLlm();
    const upstream = reviewerStreamProviderFor(identity.provider);
    if (!upstream) return null;
    return {
      provider: new LlmReviewerProviderAdapter(upstream),
      model: identity.model,
    };
  };
  const rewireReviewerAgent = (): void => {
    const reviewerResult = wireReviewerAgent({
      permissionManager,
      readActiveLlm: readActiveReviewerLlm,
      streamProviderFor: reviewerStreamProviderFor,
      resolveParentSessionAdjudicationTarget,
      // Key inheritance — Foundry reads llm.apiKey.azure-foundry,
      // GCP playground reads llm.apiKey.gemini. Both use the same secret
      // store as the chat LLM providers so no new UI is required.
      getSecret: (key) => settingsService.getSecret(key),
      // Foundry endpoint is a plain (non-secret) setting: the same
      // llm.vendors.azure-foundry.baseUrl field used by the chat provider.
      getFoundryEndpoint: () =>
        getLlmVendorSettings(
          settingsService.get("llm").vendors,
          "azure-foundry",
        ).baseUrl ?? null,
      onDeferredPendingChange: (summary) => {
        sendToWindow(getMainWindow(), PERMISSIONS.deferredPending, summary, log);
      },
    });
    ctx.rationaleScopeReviewer = reviewerResult.rationaleScopeReviewer;
    ctx.approvalSentenceSelector = reviewerResult.approvalSentenceSelector;
    // Replaced on every re-wire, which is why the approval gate reaches it
    // through an accessor rather than holding the instance: a gate that
    // captured this at boot would still be asking the stand-in after a login
    // healed the reviewer, and every ask would escalate for a reason that had
    // stopped being true.
    ctx.parentAdjudicator = reviewerResult.parentAdjudicator;
    ctx.parentSessionAdjudicator = reviewerResult.parentSessionAdjudicator;
    // A re-wire updates the runtime reviewer mode (notably the
    // llm-degraded-to-rule → llm heal driven by login or settings:update).
    // setReviewer itself does not broadcast, so an already-open PermissionsTab
    // would keep showing a stale degrade banner. Push a config-changed event so
    // its onConfigChanged subscription refetches reviewerDegradedToRule and the
    // banner clears the moment a provider/key heals the reviewer.
    broadcastPermissionConfigChangedFromHost();
  };
  rewireReviewerAgent();

  // CRITICAL 4.1: wire memory-hit auto-approve IPC broadcast once at boot.
  // The broadcast fn is stable across rewires (always sends to the current mainWindow).
  permissionManager.setBroadcastUserApprovalHit((payload) => {
    sendToWindow(getMainWindow(), PERMISSIONS.userApprovalHit, payload, log);
  });

  // PermissionManager is the architectural choke point for
  // every persisted rule mutation (addAlwaysAllowedPersist /
  // addAlwaysDeniedPersist / removeRule). Wiring the broadcast here means
  // executor-side dialog approvals (always allow / always deny), slash
  // `/permission rules add|remove`, and the IPC addRule/removeRule
  // handlers all reach multi-window PermissionsTab — without each
  // call site re-implementing the wiring.
  permissionManager.setBroadcastConfigChanged(() => {
    broadcastPermissionConfigChangedFromHost();
  });

  // Manifest integrity proxy. Subscribes the audit logger so every read→write
  // violation lands in `~/.lvis/audit/` and pushes an IPC notification to the
  // renderer. Uses the live mainWindow getter so cross-restart UI keeps
  // receiving events.
  bindManifestIntegrityAudit(bootAuditLogger);
  manifestIntegrityState.onViolation((pluginId, toolName, attempted) => {
    try {
      getMainWindow()?.webContents.send(PERMISSIONS.manifestViolation, {
        pluginId,
        toolName,
        attempted,
      });
    } catch (err) {
      log.warn(
        "manifest-violation IPC emit failed (non-fatal): %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  ctx.rewireReviewerAgent = rewireReviewerAgent;
}
