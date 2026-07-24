/**
 * Boot step — marketplace backend + managed plugin bootstrap (§9.5, extracted
 * from boot.ts C18).
 *
 * Selects the marketplace fetcher (real-cloud when a base URL is configured,
 * otherwise the disabled variant), constructs the PluginMarketplaceService, and
 * wires the live-refresh closures the settings IPC handlers invoke: the fetcher
 * SSRF-bypass toggle, the active-LLM wildcard config push, and the ASRT sandbox
 * network allow-list rebuild. Finally it runs the managed enterprise-plugin
 * bootstrap.
 */
import { app } from "electron";
import { DisabledMarketplaceFetcher, PluginMarketplaceService } from "../../plugins/marketplace.js";
import type { MarketplaceFetcher } from "../../plugins/marketplace.js";
import { CloudMarketplaceFetcher } from "../../plugins/cloud-marketplace-fetcher.js";
import { createRefreshActiveLlmWildcard } from "./refresh-active-llm-wildcard.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");

export async function setupMarketplace(ctx: BootContext): Promise<void> {
  const {
    settingsService,
    pluginPaths,
    deploymentGuard,
    bootAuditLogger,
    pluginRuntime,
  } = ctx;

  // §9.5 marketplace backend selection.
  const marketplaceSettings = settingsService.get("marketplace");
  // Marketplace fetcher selection — single production path:
  //   - real-cloud + URL → CloudMarketplaceFetcher
  //   - otherwise (no URL configured) → DisabledMarketplaceFetcher
  // No `MockMarketplaceFetcher` fallback at boot. Default points at the
  // production tunnel (`https://marketplace.lvisai.xyz`); dev operators
  // running the marketplace server locally override via the settings UI.
  // Tests inject their own fetcher.
  let marketplaceFetcher: MarketplaceFetcher;
  if (marketplaceSettings.cloudBaseUrl) {
    marketplaceFetcher = new CloudMarketplaceFetcher({
      baseUrl: marketplaceSettings.cloudBaseUrl,
      apiKey: settingsService.getSecret("marketplace.apiKey") ?? undefined,
      allowPrivateNetwork: marketplaceSettings.cloudAllowPrivateNetwork,
    });
    log.info("boot: marketplace backend = real-cloud (%s)", marketplaceSettings.cloudBaseUrl);
  } else {
    marketplaceFetcher = new DisabledMarketplaceFetcher();
    log.warn("boot: marketplace backend disabled (no cloudBaseUrl configured)");
  }
  const pluginMarketplace = new PluginMarketplaceService(
    pluginPaths,
    marketplaceFetcher,
    deploymentGuard,
    bootAuditLogger,
  );

  // Closure invoked by the settings IPC handler when MarketplaceTab fields
  // change. Re-reads the persisted `marketplace.cloudAllowPrivateNetwork`
  // value and pushes it into the live CloudMarketplaceFetcher so the
  // SSRF-guard bypass toggle takes effect on the next request (honoring the

  // a disabled marketplace has no live config to refresh.
  const refreshMarketplaceFetcherConfig = (): void => {
    if (!(marketplaceFetcher instanceof CloudMarketplaceFetcher)) return;
    const next = settingsService.get("marketplace").cloudAllowPrivateNetwork ?? false;
    marketplaceFetcher.updateAllowPrivateNetwork(next);
  };

  // #893 — Push the active LLM vendor id into the plugin runtime's wildcard
  // configOverrides slot. Plugins read this via
  // `hostApi.config.get("hostApiVendor")` so a plugin that needs an LLM call
  // doesn't have to ship its own vendor-detection logic. Called once at
  // boot (after plugin runtime is available) and again after every
  // llm-settings IPC change.
  //
  // PR #894 review B2: we no longer inject `hostApiKey` here. The actual
  // secret must always flow through `hostApi.getSecret("llm.apiKey.<vendor>")`,
  // which routes through the three-tier allowlist gate (only plugins that
  // declare the matching `hostSecrets.read[]` entry receive the key).
  // Injecting the apiKey into a wildcard config slot bypassed that gate
  // — every plugin received the key via `config.get("hostApiKey")`
  // regardless of its manifest. Removing it closes that hole.
  // PR #894 Cycle 3 T1-2 — factory extracted to
  // `boot/steps/refresh-active-llm-wildcard.ts` so the debounce + vendor-
  // change-restart contract is independently unit-testable. Same semantics
  // as before: first call seeds, subsequent vendor changes trigger a
  // debounced restart sweep of every loaded plugin.
  const { refresh: refreshActiveLlmWildcard } = createRefreshActiveLlmWildcard({
    getActiveVendor: () => settingsService.get("llm").provider,
    setWildcardConfigOverride: (config) => pluginRuntime.setWildcardConfigOverride(config),
    clearWildcardConfigOverride: (keys) => pluginRuntime.clearWildcardConfigOverride(keys),
    listPluginIds: () => pluginRuntime.listPluginIds(),
    restartPlugin: async (pid) => {
      await pluginRuntime.restartPlugin(pid);
    },
  });
  refreshActiveLlmWildcard();

  // ── ASRT shared network-config union builder + live refresh ──────────────
  // The shared strict-union allow-list ASRT enforces = the UNION of every
  // loaded plugin's manifest `networkAccess.allowedDomains` PLUS the host-
  // resolved DYNAMIC endpoint hostnames (user-configured vendor baseUrls a
  // sandboxed worker actually reaches — e.g. local-indexer's Azure OpenAI
  // resource). Both the boot init block (below) and the live-refresh closure
  // (here) build the union the SAME way so they never drift.
  const buildSandboxUnionDomains = async (): Promise<string[]> => {
    const { computeUnionAllowedDomains, normalizeUnionForAsrt, computeDynamicEndpointHosts } =
      await import("../../permissions/asrt-sandbox.js");
    const manifestAllowLists = pluginRuntime
      .listPluginIds()
      .map((id) => pluginRuntime.getPluginManifest(id)?.networkAccess?.allowedDomains ?? []);
    const dynamicEndpointHosts = computeDynamicEndpointHosts(settingsService.getAll());
    return normalizeUnionForAsrt(
      computeUnionAllowedDomains([...manifestAllowLists, dynamicEndpointHosts], []),
    );
  };

  // Closure invoked by the settings IPC handler when a vendor/embedding
  // endpoint changes. Recomputes the dynamic-endpoint union and LIVE-SWAPS the
  // shared ASRT network config so a reconfigured endpoint is enforced/allowed
  // without an app restart. The network config is a SAFE, GLOBAL live swap
  // (filterNetworkRequest reads the shared config; updateConfig replaces it).
  // GATED: no-op when ASRT is not active (gate OFF, or deps-missing/Windows-
  // not-ready paths where the sandbox was never initialized) — there is no live
  // config to update, and we must not initialize one outside the boot gate.
  const refreshSandboxNetworkConfig = (): void => {
    void (async () => {
      const {
        isAsrtSandboxActive,
        updateAsrtSandboxConfig,
      } = await import(
        "../../permissions/asrt-sandbox.js"
      );
      if (!isAsrtSandboxActive()) return;
      const allowedDomains = await buildSandboxUnionDomains();
      // Same trusted shape boot init uses: enforced allow-list + strict, no
      // weakening flags. Plugin-worker filesystem grants are not kept in the
      // shared config; Windows worker spawn remains fail-closed until ASRT can
      // scope allow grants per worker/plugin.
      await updateAsrtSandboxConfig({
        allowedDomains,
        strictAllowlist: true,
        userDataDir: app.getPath("userData"),
      });
      log.info(
        "boot: ASRT network config live-refreshed (%d union domains after settings change)",
        allowedDomains.length,
      );
    })().catch((err) => {
      log.warn(
        "boot: ASRT network config live-refresh failed: %s",
        err instanceof Error ? err.message : String(err),
      );
    });
  };

  ctx.marketplaceFetcher = marketplaceFetcher;
  ctx.pluginMarketplace = pluginMarketplace;
  ctx.refreshMarketplaceFetcherConfig = refreshMarketplaceFetcherConfig;
  ctx.refreshActiveLlmWildcard = refreshActiveLlmWildcard;
  ctx.buildSandboxUnionDomains = buildSandboxUnionDomains;
  ctx.refreshSandboxNetworkConfig = refreshSandboxNetworkConfig;
}
