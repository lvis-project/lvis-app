



import { whitelistRegistry } from "../../plugins/whitelist/whitelist-registry.js";
import { WHITELIST_PRIMARY_KEY_ID } from "../../plugins/marketplace-keys.js";
import {
  incrementHostSecretCounter,
  type HostSecretCounterEvent,
} from "../../telemetry/host-secret-counters.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { createLogger } from "../../lib/logger.js";
import { emitEvent } from "../types.js";
import { t } from "../../i18n/index.js";
import { isE2eTestRuntime, readDevelopmentEnvVar } from "../dev-flags.js";

const log = createLogger("whitelist-bootstrap");

export interface WhitelistBootstrapInput {
  userDataPath: string;
  bootAuditLogger: AuditLogger;
  /** Authoritative host packaging state; never derived from process.env. */
  packaged: boolean;
  /** Transport for the document GETs — Chromium's stack, from `ctx.singleHopNetworkFetch`. */
  networkFetch: typeof fetch;
  /** Online toggle — disabled in tests or user-selected offline mode. */
  online?: boolean;
  /**
   * App-shutdown AbortSignal. When the app
   * quits while a slow CDN response is in flight, this aborts the
   * underlying fetch immediately instead of waiting for the 10s HTTP
   * timeout. Boot passes its lifetime signal here.
   */
  appShutdownSignal?: AbortSignal;
}

function isOnlineByDefault(packaged: boolean): boolean {
  // Source/E2E runs may opt out of the public CDN. Packaged builds ignore the
  // development-only flag even if early environment scrubbing is bypassed.
  if (readDevelopmentEnvVar("LVIS_WHITELIST_OFFLINE", process.env, packaged) === "1") return false;
  return true;
}

function installE2eWhitelistPublicKeyOverride(packaged: boolean): void {
  if (packaged || !isE2eTestRuntime()) return;
  const publicKey = process.env.LVIS_E2E_WHITELIST_PUBLIC_KEY;
  if (!publicKey) return;
  whitelistRegistry.setPublicKeysForTesting({
    [WHITELIST_PRIMARY_KEY_ID]: publicKey,
  });
}

/**
 * Load + activate the whitelist registry. Resolves once init completes —
 * never throws (every fail path is recorded as a status).
 */
export async function wireWhitelistRegistry(input: WhitelistBootstrapInput): Promise<void> {
  const { bootAuditLogger } = input;
  const online = input.online ?? isOnlineByDefault(input.packaged);
  const userDataDir = input.userDataPath;
  installE2eWhitelistPublicKeyOverride(input.packaged);

  await whitelistRegistry.init({
    userDataDir,
    online,
    networkFetch: input.networkFetch,
    ...(input.appShutdownSignal ? { signal: input.appShutdownSignal } : {}),
    audit: (input: string) => {
      try {
        bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "boot",
          type: "info",
          input,
        });
      } catch {
        /* audit must not break boot */
      }
    },
    telemetry: (event: string, meta?: Record<string, string>) => {
      try {
        // Re-use the host-secret counter map so operators see whitelist
        // observability alongside getSecret allow/deny in one place.
        // `<event>:<pluginId>:<keyPrefix>` schema — pluginId="boot" for
        // registry-wide events so they don't collide with per-plugin
        // hostSecret_read / hostSecret_denied buckets.
        const reasonBucket = meta?.reason ?? meta?.source ?? "default";
        incrementHostSecretCounter(
          event as HostSecretCounterEvent,
          "boot",
          reasonBucket,
        );
      } catch {
        /* never block boot on telemetry */
      }
    },
  });

  // No-cache + offline → one-shot system toast so the user knows host
  // secret access is locked. Other states (stale-within-grace etc.) keep
  // operating with a warn-level log only.
  if (whitelistRegistry.isNoCacheOffline()) {
    try {
      emitEvent("system.toast", {
        level: "warn",
        title: t("be_whitelistBootstrap.toastTitle"),
        body: t("be_whitelistBootstrap.toastBody"),
        source: "whitelist-bootstrap",
      });
    } catch (err) {
      log.warn(`toast emit failed: ${(err as Error).message}`);
    }
  }
}
