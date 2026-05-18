/**
 * Boot §4.2 Step 2.5 — Marketplace whitelist registry bootstrap.
 *
 * Runs BEFORE `initPluginRuntime` so the per-plugin HostApi factory observes
 * a populated registry from the first `getSecret` call. The registry's
 * `init()` resolves whether or not the network fetch succeeds — every
 * failure path is recorded as a status (no-cache, stale-past-grace, …)
 * that `isAllowed` then reads synchronously.
 *
 * When `init()` settles into the `no-cache-and-offline` state a one-shot
 * toast event is emitted so the renderer can surface "마켓플레이스 화이트리스트
 * 미수신 — 호스트 시크릿 접근이 잠금 상태입니다.".
 */
import { app } from "electron";
import { join } from "node:path";
import { whitelistRegistry } from "../../plugins/whitelist/whitelist-registry.js";
import { WHITELIST_PRIMARY_KEY_ID } from "../../plugins/marketplace-keys.js";
import {
  incrementHostSecretCounter,
  type HostSecretCounterEvent,
} from "../../telemetry/host-secret-counters.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { createLogger } from "../../lib/logger.js";
import { emitEvent } from "../types.js";
import { isDemoEnabled } from "../../main/demo-credentials.js";

const log = createLogger("whitelist-bootstrap");

export interface WhitelistBootstrapInput {
  bootAuditLogger: AuditLogger;
  /** Online toggle — disabled in tests + when `LVIS_DEMO_ENABLED=1`. */
  online?: boolean;
  /**
   * Cluster review optional fix — app-shutdown AbortSignal. When the app
   * quits while a slow CDN response is in flight, this aborts the
   * underlying fetch immediately instead of waiting for the 10s HTTP
   * timeout. Boot passes its lifetime signal here.
   */
  appShutdownSignal?: AbortSignal;
}

function isOnlineByDefault(): boolean {
  // Demo / kiosk path: skip network. The registry loads the bundled snapshot.
  if (isDemoEnabled()) return false;
  // E2E + unit tests set this so they don't hit the public CDN.
  if (process.env.LVIS_WHITELIST_OFFLINE === "1") return false;
  return true;
}

function isE2eTestRuntime(): boolean {
  return process.env.LVIS_E2E === "1" && process.env.NODE_ENV === "test";
}

function resolveDemoSnapshotPath(): string {
  if (isE2eTestRuntime() && process.env.LVIS_E2E_WHITELIST_SNAPSHOT_PATH) {
    return process.env.LVIS_E2E_WHITELIST_SNAPSHOT_PATH;
  }

  // Electron always defines `process.resourcesPath`, including defaultApp
  // dev/test launches where it points at Electron's own resources directory.
  // Use packaged resources only for packaged app runs; otherwise use the repo
  // resources directory so demo E2E can load the checked-in snapshot.
  const isDefaultApp = !!(process as { defaultApp?: boolean }).defaultApp;
  return process.resourcesPath && !isDefaultApp
    ? join(process.resourcesPath, "marketplace-whitelist.demo.json")
    : join(process.cwd(), "resources", "marketplace-whitelist.demo.json");
}

function installE2eWhitelistPublicKeyOverride(): void {
  if (!isE2eTestRuntime()) return;
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
  const online = input.online ?? isOnlineByDefault();
  const userDataDir = app.getPath("userData");
  const demoSnapshotPath = resolveDemoSnapshotPath();
  installE2eWhitelistPublicKeyOverride();

  await whitelistRegistry.init({
    userDataDir,
    demoSnapshotPath,
    useDemoSnapshot: isDemoEnabled(),
    online,
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
        title: "마켓플레이스 화이트리스트 미수신",
        body: "오프라인 상태이며 캐시된 화이트리스트가 없어 호스트 시크릿 접근이 잠금됩니다.",
        source: "whitelist-bootstrap",
      });
    } catch (err) {
      log.warn(`toast emit failed: ${(err as Error).message}`);
    }
  }
}
