import type { BrowserWindow } from "electron";
import type { MarketplaceSettings } from "../data/settings-store.js";
import type { PluginMarketplaceService } from "../plugins/marketplace.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import { notifyBootstrapStatus } from "./bootstrap-status.js";

export function resolveManagedPluginBootstrap(input: {
  marketplace: Pick<MarketplaceSettings, "backend" | "realCloudBaseUrl">;
  isPackaged: boolean;
}): { enabled: boolean; reason?: string } {
  const { marketplace, isPackaged } = input;
  if (marketplace.backend === "real-cloud") {
    const baseUrl = marketplace.realCloudBaseUrl?.trim();
    if (baseUrl) {
      return { enabled: true };
    }
    return {
      enabled: false,
      reason: "real-cloud backend has no configured base URL",
    };
  }
  if (isPackaged) {
    return {
      enabled: false,
      reason: "packaged apps skip managed bootstrap when using the mock marketplace backend",
    };
  }
  return { enabled: true };
}

export interface RunManagedBootstrapInput {
  pluginMarketplace: PluginMarketplaceService;
  pluginRuntime: PluginRuntime;
  mainWindow: BrowserWindow | null | undefined;
  marketplace: Pick<MarketplaceSettings, "backend" | "realCloudBaseUrl">;
  isPackaged: boolean;
}

/**
 * Run the managed-plugin bootstrap once and emit lifecycle status to the
 * renderer. Shared between the first-boot call in `boot()` and the
 * `lvis:bootstrap:retry` IPC handler so the retry path is bug-for-bug
 * identical to the original — same skip-reason resolution, same
 * `restartAll()` call after a successful install, same status payload shape.
 *
 * Graceful by contract: marketplace unreachable / per-plugin failure /
 * thrown errors all emit a status event but never propagate. The caller does
 * not need to wrap this in try/catch.
 */
export async function runManagedBootstrap(input: RunManagedBootstrapInput): Promise<void> {
  const { pluginMarketplace, pluginRuntime, mainWindow, marketplace, isPackaged } = input;
  const decision = resolveManagedPluginBootstrap({ marketplace, isPackaged });
  if (!decision.enabled) {
    console.warn(`[lvis] boot: managed plugin bootstrap skipped: ${decision.reason}`);
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
      console.log(
        `[lvis] boot: managed plugin bootstrap installed ${ensureResult.installed.length}: ${ensureResult.installed.join(", ")}`,
      );
      await pluginRuntime.restartAll();
    }
    if (ensureResult.failed.length > 0) {
      console.warn(
        `[lvis] boot: managed plugin bootstrap failed ${ensureResult.failed.length}:`,
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
    console.warn(`[lvis] boot: ensureManagedInstalled error:`, message);
    notifyBootstrapStatus(mainWindow, { phase: "error", message });
  }
}
