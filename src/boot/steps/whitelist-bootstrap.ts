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
import {
  incrementHostSecretCounter,
  type HostSecretCounterEvent,
} from "../../telemetry/host-secret-counters.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { createLogger } from "../../lib/logger.js";
import { emitEvent } from "../types.js";

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
  if (process.env.LVIS_DEMO_ENABLED === "1") return false;
  // E2E + unit tests set this so they don't hit the public CDN.
  if (process.env.LVIS_WHITELIST_OFFLINE === "1") return false;
  return true;
}

/**
 * Load + activate the whitelist registry. Resolves once init completes —
 * never throws (every fail path is recorded as a status).
 */
export async function wireWhitelistRegistry(input: WhitelistBootstrapInput): Promise<void> {
  const { bootAuditLogger } = input;
  const online = input.online ?? isOnlineByDefault();
  const userDataDir = app.getPath("userData");
  // Demo snapshot baked into asar at `resources/marketplace-whitelist.demo.json`.
  // Electron's `process.resourcesPath` points to `<app>/resources` in
  // packaged builds; in dev the path resolves relative to the project root.
  const demoSnapshotPath = process.resourcesPath
    ? join(process.resourcesPath, "marketplace-whitelist.demo.json")
    : join(process.cwd(), "resources", "marketplace-whitelist.demo.json");

  await whitelistRegistry.init({
    userDataDir,
    demoSnapshotPath,
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
