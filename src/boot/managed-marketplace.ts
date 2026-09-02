import type { BrowserWindow } from "electron";
import type { MarketplaceSettings } from "../data/settings-store.js";
import type {
  PluginMarketplaceService,
  PreparedMarketplacePluginActivation,
  RemoveDelistedAdminInstall,
} from "../plugins/marketplace.js";
import { notifyBootstrapStatus } from "./bootstrap-status.js";
import { createLogger } from "../lib/logger.js";
import { isE2eTestRuntime } from "./dev-flags.js";
import { withAllPluginInstallLocks } from "../plugins/install-lifecycle.js";
const log = createLogger("lvis");

export function resolveManagedPluginBootstrap(input: {
  marketplace: Pick<MarketplaceSettings, "backend" | "cloudBaseUrl">;
  e2eTestMode?: boolean;
}): { enabled: boolean; reason?: string } {
  const { marketplace } = input;
  if (input.e2eTestMode) {
    return {
      enabled: false,
      reason: "managed plugin bootstrap disabled in isolated E2E test mode",
    };
  }
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

interface RunManagedBootstrapBaseInput {
  pluginMarketplace: PluginMarketplaceService;
  ensurePluginStateReadyForInstall: (pluginId: string) => Promise<void>;
  mainWindow: BrowserWindow | null | undefined;
  marketplace: Pick<MarketplaceSettings, "backend" | "cloudBaseUrl">;
}

export type RunManagedBootstrapInput = RunManagedBootstrapBaseInput & (
  | {
      mode: "pre-start-sync";
      admitPreStartOperation: <T>(operation: () => Promise<T>) => Promise<T>;
      removeDelistedAdminInstall: RemoveDelistedAdminInstall;
      activatePreparedArtifact?: never;
    }
  | {
      mode: "repair-missing-only";
      admitPreStartOperation?: never;
      removeDelistedAdminInstall?: never;
      activatePreparedArtifact: PreparedMarketplacePluginActivation;
    }
);

/**
 * In-flight bootstrap promise. The first-boot caller and the renderer-driven
 * `lvis:bootstrap:retry` IPC both go through `runManagedBootstrap`; if the
 * user mashes the retry button or boot is still in progress when retry fires,
 * concurrent runs would race on `ensureManagedInstalled` and atomic runtime
 * publication. Coalescing eliminates both windows — subsequent callers await
 * the in-flight result.
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
 * identical to the original — same skip-reason resolution and status payload
 * shape. Pre-start sync is durable-only; true missing-only repair activates
 * through the already-running generation lifecycle before reporting success.
 *
 * Concurrent calls are coalesced via {@link bootstrapInFlight}: if a run is
 * already underway, the new caller awaits the same promise instead of
 * starting a parallel managed-install/activation cycle.
 *
 * Graceful by contract: marketplace unreachable / per-plugin failure /
 * thrown errors all emit a status event but never propagate. The caller does
 * not need to wrap this in try/catch.
 */
export function runManagedBootstrap(input: RunManagedBootstrapInput): Promise<void> {
  if (bootstrapInFlight) return bootstrapInFlight;
  const operation = input.mode === "pre-start-sync"
    ? requirePreStartAdmission(input.admitPreStartOperation)(() => doRunManagedBootstrap(input))
    : doRunManagedBootstrap(input);
  const promise = operation.finally(() => {
    // The .finally chain becomes the in-flight promise itself, so we clear
    // the singleton after it resolves regardless of identity comparison.
    bootstrapInFlight = null;
  });
  bootstrapInFlight = promise;
  return promise;
}

function requirePreStartAdmission(
  admission: RunManagedBootstrapInput["admitPreStartOperation"],
): NonNullable<RunManagedBootstrapInput["admitPreStartOperation"]> {
  if (typeof admission !== "function") {
    throw new Error("managed pre-start sync requires boot phase admission");
  }
  return admission;
}

async function doRunManagedBootstrap(input: RunManagedBootstrapInput): Promise<void> {
  const {
    pluginMarketplace,
    ensurePluginStateReadyForInstall,
    mainWindow,
    marketplace,
  } = input;
  const decision = resolveManagedPluginBootstrap({
    marketplace,
    e2eTestMode: isE2eTestRuntime(),
  });
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
    // The all-plugin lock remains the durable transaction boundary. Runtime
    // restart cancellation is unnecessary because this phase runs before the
    // one sealed start and never publishes or starts a candidate generation.
    const ensureResult = await withAllPluginInstallLocks(async () => {
      if (input.mode === "repair-missing-only") {
        return pluginMarketplace.ensureManagedInstalled({
          mode: "repair-missing-only",
          ensurePluginStateReadyForInstall,
          activatePreparedArtifact: input.activatePreparedArtifact,
        });
      }
      return pluginMarketplace.ensureManagedInstalled({
        mode: "pre-start-sync",
        ensurePluginStateReadyForInstall,
        removeDelistedAdminInstall: input.removeDelistedAdminInstall,
      });
    });
    const updated = ensureResult.updated ?? [];
    if (ensureResult.installed.length > 0) {
      log.info(
        `boot: managed plugin bootstrap installed ${ensureResult.installed.length}: ${ensureResult.installed.join(", ")}`,
      );
    }
    if (updated.length > 0) {
      log.info(
        `boot: managed plugin bootstrap auto-updated ${updated.length}: ${updated.join(", ")}`,
      );
    }
    const removed = ensureResult.removed ?? [];
    if (removed.length > 0) {
      // Removal is the enforced half of admin sync: the catalog stopped
      // publishing these, so the install goes with it. Logged at info because a
      // plugin disappearing is something an operator reading boot logs after
      // the fact needs to be able to account for.
      log.info(
        `boot: managed plugin bootstrap removed ${removed.length} delisted: ${removed.join(", ")}`,
      );
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
