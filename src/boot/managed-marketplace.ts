import type { BrowserWindow } from "electron";
import type { MarketplaceSettings } from "../data/settings-store.js";
import type { PluginMarketplaceService } from "../plugins/marketplace.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import { notifyBootstrapStatus } from "./bootstrap-status.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export function resolveManagedPluginBootstrap(input: {
  marketplace: Pick<MarketplaceSettings, "backend" | "cloudBaseUrl">;
}): { enabled: boolean; reason?: string } {
  const { marketplace } = input;
  // The cloud backend is the only marketplace backend; bootstrap is enabled iff
  // a base URL is configured. (The former mock-backend / isPackaged skip branch
  // was dead once the mock backend was removed.)
  const baseUrl = marketplace.cloudBaseUrl?.trim();
  if (baseUrl) {
    return { enabled: true };
  }
  return {
    enabled: false,
    reason: "marketplace backend has no configured base URL",
  };
}

export interface RunManagedBootstrapInput {
  pluginMarketplace: PluginMarketplaceService;
  pluginRuntime: PluginRuntime;
  mainWindow: BrowserWindow | null | undefined;
  marketplace: Pick<MarketplaceSettings, "backend" | "cloudBaseUrl">;
}

/**
 * In-flight bootstrap promise. The first-boot caller and the renderer-driven
 * `lvis:bootstrap:retry` IPC both go through `runManagedBootstrap`; if the
 * user mashes the retry button or boot is still in progress when retry fires,
 * concurrent runs would race on `ensureManagedInstalled` (registry write) +
 * `restartAll` (runtime tear-down/reload). Coalescing eliminates both
 * windows — subsequent callers await the in-flight result.
 *
 * Module-scoped (not instance-scoped) because the singleton matches the
 * single PluginMarketplaceService + PluginRuntime constructed at boot. If
 * tests need isolation they can call {@link _resetBootstrapInFlightForTest}.
 */
let bootstrapInFlight: Promise<void> | null = null;

/** Test-only — drop the in-flight singleton so per-test isolation is clean. */
export function _resetBootstrapInFlightForTest(): void {
  bootstrapInFlight = null;
}

/**
 * Run the managed-plugin bootstrap once and emit lifecycle status to the
 * renderer. Shared between the first-boot call in `boot()` and the
 * `lvis:bootstrap:retry` IPC handler so the retry path is bug-for-bug
 * identical to the original — same skip-reason resolution, same
 * `restartAll()` call after a successful install, same status payload shape.
 *
 * Concurrent calls are coalesced via {@link bootstrapInFlight}: if a run is
 * already underway, the new caller awaits the same promise instead of
 * starting a parallel `ensureManagedInstalled` / `restartAll` cycle.
 *
 * Graceful by contract: marketplace unreachable / per-plugin failure /
 * thrown errors all emit a status event but never propagate. The caller does
 * not need to wrap this in try/catch.
 */
export function runManagedBootstrap(input: RunManagedBootstrapInput): Promise<void> {
  if (bootstrapInFlight) return bootstrapInFlight;
  const promise = doRunManagedBootstrap(input).finally(() => {
    // The .finally chain becomes the in-flight promise itself, so we clear
    // the singleton after it resolves regardless of identity comparison.
    bootstrapInFlight = null;
  });
  bootstrapInFlight = promise;
  return promise;
}

async function doRunManagedBootstrap(input: RunManagedBootstrapInput): Promise<void> {
  const { pluginMarketplace, pluginRuntime, mainWindow, marketplace } = input;
  const decision = resolveManagedPluginBootstrap({ marketplace });
  if (!decision.enabled) {
    log.warn(`boot: managed plugin bootstrap skipped: ${decision.reason}`);
    notifyBootstrapStatus(mainWindow, {
      phase: "complete",
      installed: [],
      failed: [],
      skippedReason: decision.reason,
    });
    return;
  }
  notifyBootstrapStatus(mainWindow, { phase: "start" });
  try {
    const ensureResult = await pluginMarketplace.ensureManagedInstalled();
    if (ensureResult.installed.length > 0) {
      log.info(
        `boot: managed plugin bootstrap installed ${ensureResult.installed.length}: ${ensureResult.installed.join(", ")}`,
      );
      await pluginRuntime.restartAll();
    }
    if (ensureResult.failed.length > 0) {
      log.warn(
        `boot: managed plugin bootstrap failed ${ensureResult.failed.length}: %s`,
        ensureResult.failed,
      );
    }
    notifyBootstrapStatus(mainWindow, {
      phase: "complete",
      installed: ensureResult.installed,
      failed: ensureResult.failed,
    });
  } catch (err) {
    const message = (err as Error).message;
    log.warn(`boot: ensureManagedInstalled error: %s`, message);
    notifyBootstrapStatus(mainWindow, { phase: "error", message });
  }
}
