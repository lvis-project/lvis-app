/**
 * Boot step — shared audit logger, notification service, and plugin
 * auth-partition tracker seeding (§4.2, extracted from boot.ts C18).
 *
 * The AuditLogger built here is the SINGLE instance shared by the plugin
 * runtime, hooks, and approval gate. The NotificationService is constructed
 * up-front so every lifecycle cue (turn-end / routine / ask-user / approval /
 * plugin / system) can fire against a live mainWindow getter. Finally the
 * in-memory plugin-auth-partition tracker is seeded from disk (#748) with
 * persistence callbacks wired so later observations flush to disk.
 */
import { NotificationService } from "../../main/notification-service.js";
import {
  readPersistedPluginAuthPartitions,
  writePersistedPluginAuthPartitions,
  deletePersistedPluginAuthPartitions,
  cleanupStaleTmpFiles,
} from "../../main/plugin-auth-partition-store.js";
import {
  wirePluginAuthPartitionPersistence,
  seedPluginAuthPartitions,
} from "../../main/auth-window-service.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");

export async function setupAuditAndNotification(ctx: BootContext): Promise<void> {
  const { getMainWindow, lvisHomeDocUpgradeMarkers } = ctx;

  // Shared AuditLogger instance (plugin runtime + hooks + gate).
  const { AuditLogger } = await import("../../audit/audit-logger.js");
  const { safeStorage } = await import("electron");
  const {
    FileSecretStore,
    SafeStorageSecretStore,
    ensureAuditSecret,
  } = await import("../../audit/hmac-chain.js");
  const bootAuditLogger = new AuditLogger();
  const permissionAuditSecretStore = safeStorage.isEncryptionAvailable()
    ? new SafeStorageSecretStore(safeStorage)
    : new FileSecretStore();
  bootAuditLogger.setupPermissionAuditChain(
    ensureAuditSecret(permissionAuditSecretStore),
    permissionAuditSecretStore,
  );

  // §14.2 Audit rotation must share the runtime writer instance. A separate
  // maintenance logger cannot drain records queued by the host/plugin paths.
  const runAuditMaintenance = () => {
    const auditCfg = ctx.settingsService.get("audit");
    void bootAuditLogger.rotateAndPrune({
      maxBytes: auditCfg.auditRotationMaxBytes,
      retentionDays: auditCfg.auditRetentionDays,
    }).catch((err: unknown) => {
      log.warn({ err }, "rotateAndPrune failed");
    });
  };
  runAuditMaintenance();
  const auditMaintenanceTimer = setInterval(runAuditMaintenance, 60 * 60 * 1000);
  auditMaintenanceTimer.unref?.();

  // Issue #260 — system notification service. Constructed up-front so
  // turn-end, routine, ask-user, approval, plugin, and system cues can call .fire().
  // Live mainWindow getter avoids a stale handle after Electron close+reopen.
  const notificationService = new NotificationService({
    getMainWindow,
    auditLogger: bootAuditLogger,
  });
  if (lvisHomeDocUpgradeMarkers.length > 0) {
    const markerSummary =
      lvisHomeDocUpgradeMarkers.length === 1
        ? `~/.lvis/${lvisHomeDocUpgradeMarkers[0].markerPath}`
        : t("be_boot.upgradeMarkersPlural", { count: String(lvisHomeDocUpgradeMarkers.length) });
    notificationService.fire({
      kind: "system",
      title: t("be_boot.upgradeNotificationTitle"),
      body: t("be_boot.upgradeNotificationBody", { markerSummary }),
    });
  }
  // Routine delivery sites pass `notificationService` explicitly per-call so
  // there's no module-level singleton to reset between tests/processes.

  // Issue #748 — seed the in-memory plugin-auth-partition tracker from disk so
  // uninstall can wipe partitions created in prior app sessions (not just the
  // current runtime). Wire persistence callbacks so every new observation is
  // immediately flushed to `~/.lvis/plugins/auth-partitions.json`.
  //
  // Sweep crashed-write tombstones from prior session before reading current state.
  // Non-fatal — continue boot if sweep fails.
  await cleanupStaleTmpFiles().catch((err: unknown) => {
    log.warn(
      "boot: cleanupStaleTmpFiles failed (non-fatal): %s",
      (err as Error).message,
    );
  });
  //
  // Corrupt file → throws loudly with an audit entry instead of silently
  // using an empty set (CLAUDE.md "No Fallback Code" rule).
  await readPersistedPluginAuthPartitions()
    .then((persisted) => {
      if (persisted !== null) seedPluginAuthPartitions(persisted);
    })
    .catch(async (err) => {
      const msg = (err as Error).message;
      bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "error",
        input: "plugin-auth-partition-store: load failed at boot",
        output: msg,
      });
      await bootAuditLogger.flush();
      throw err;
    });
  wirePluginAuthPartitionPersistence({
    write: writePersistedPluginAuthPartitions,
    delete: deletePersistedPluginAuthPartitions,
    onError: (msg) => {
      bootAuditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "error",
        input: "plugin-auth-partition-store: async write/delete failed",
        output: msg,
      });
    },
  });

  ctx.bootAuditLogger = bootAuditLogger;
  ctx.notificationService = notificationService;
}
