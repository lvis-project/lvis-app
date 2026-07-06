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
import { BrowserWindow as BrowserWindowValue } from "electron";
import { sendToWindow } from "../../ipc/safe-send.js";
import { broadcastPermissionConfigChanged as broadcastPermissionConfigChangedFromIpc } from "../../ipc/domains/permissions.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { createProvider, secretKeyFor } from "../../engine/llm/provider-factory.js";
import { reviewerVendorFor } from "../../permissions/reviewer/reviewer-vendor-map.js";
import type { LLMProvider } from "../../engine/llm/types.js";
import {
  getLlmVendorSettings,
  isLLMVendor,
  canUseLlmVendorWithoutApiKey,
} from "../../shared/llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
import { wireReviewerAgent } from "./reviewer-wiring.js";
import {
  bindManifestIntegrityAudit,
  manifestIntegrityState,
} from "../../permissions/manifest-integrity.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");

export function wireReviewerAndPermissions(ctx: BootContext): void {
  const { toolRegistry, permissionManager, settingsService, llmFetch, getMainWindow, bootAuditLogger } = ctx;

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
    // Reviewer legacy provider names still resolve through the shared map.
    // Active-LLM following passes canonical LLMVendor names directly.
    const llmVendor = reviewerVendorFor(vendor) ?? (isLLMVendor(vendor) ? vendor : null);
    if (!llmVendor) return null;
    const llmSettings = settingsService.get("llm");
    const block = getLlmVendorSettings(llmSettings.vendors, llmVendor);
    const marketplaceProviderPreset = llmVendor === "openai-compatible" && llmSettings.marketplaceProviderPresetId
      ? settingsService
        .get("marketplace")
        .installedProviderPresets
        .find((preset) => preset.providerId === llmSettings.marketplaceProviderPresetId)
      : undefined;
    const apiKey = settingsService.getSecret(
      marketplaceProviderPreset
        ? marketplaceProviderPresetSecretKey(marketplaceProviderPreset.providerId)
        : secretKeyFor(llmVendor),
    );
    const isVertex = llmVendor === "vertex-ai";
    const canUseWithoutApiKey = marketplaceProviderPreset
      ? marketplaceProviderPreset.requiresApiKey === false && Boolean(block.baseUrl?.trim())
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
    return createProvider({
      vendor: llmVendor,
      apiKey: apiKey ?? "",
      model: block.model,
      ...(llmVendor === "azure-foundry" ? { fetch: llmFetch } : {}),
      ...(block.baseUrl ? { baseUrl: block.baseUrl } : {}),
      ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
      ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
    });
  };
  const readActiveReviewerLlm = () => {
    const llm = settingsService.get("llm");
    const provider = llm.provider;
    const block = getLlmVendorSettings(llm.vendors, provider);
    return {
      provider,
      ...(provider === "openai-compatible" && llm.marketplaceProviderPresetId
        ? { marketplaceProviderPresetId: llm.marketplaceProviderPresetId }
        : {}),
      model: block.model,
      ...(block.baseUrl ? { baseUrl: block.baseUrl } : {}),
      ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
      ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
    };
  };
  const rewireReviewerAgent = (): void => {
    wireReviewerAgent({
      permissionManager,
      readActiveLlm: readActiveReviewerLlm,
      streamProviderFor: reviewerStreamProviderFor,
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
    // A re-wire updates the runtime reviewer mode (notably the
    // llm-degraded-to-rule → llm heal driven by login or settings:update).
    // setReviewer itself does not broadcast, so an already-open PermissionsTab
    // would keep showing a stale degrade banner. Push a config-changed event so
    // its onConfigChanged subscription refetches reviewerDegradedToRule and the
    // banner clears the moment a provider/key heals the reviewer.
    broadcastPermissionConfigChangedFromIpc({ getMainWindow, getAppWindows: () => BrowserWindowValue.getAllWindows() } as Parameters<typeof broadcastPermissionConfigChangedFromIpc>[0]);
  };
  rewireReviewerAgent();

  // CRITICAL 4.1: wire memory-hit auto-approve IPC broadcast once at boot.
  // The broadcast fn is stable across rewires (always sends to the current mainWindow).
  permissionManager.setBroadcastUserApprovalHit((payload) => {
    sendToWindow(getMainWindow(), PERMISSIONS.userApprovalHit, payload, log);
  });

  // Round-4 fix: PermissionManager is the architectural choke point for
  // every persisted rule mutation (addAlwaysAllowedPersist /
  // addAlwaysDeniedPersist / removeRule). Wiring the broadcast here means
  // executor-side dialog approvals (always allow / always deny), slash
  // `/permission rules add|remove`, and the IPC addRule/removeRule
  // handlers all reach multi-window PermissionsTab — without each
  // call site re-implementing the wiring.
  permissionManager.setBroadcastConfigChanged(() => {
    broadcastPermissionConfigChangedFromIpc({ getMainWindow, getAppWindows: () => BrowserWindowValue.getAllWindows() } as Parameters<typeof broadcastPermissionConfigChangedFromIpc>[0]);
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
