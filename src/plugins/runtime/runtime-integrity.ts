import { isDevModeUnlocked } from "../../boot/dev-flags.js";
import { createLogger } from "../../lib/logger.js";
import { verifyInstallReceipt } from "../plugin-install-receipt.js";
import type { PluginIntegrityCheckResult } from "./runtime-preflight.js";

const log = createLogger("plugin-runtime");

type IntegrityAuditLog = (
  level: "info" | "warn" | "error",
  message: string,
  data?: unknown,
) => void;

export async function verifyPluginIntegrity(
  cacheRoot: string | undefined,
  pluginId: string,
  pluginRoot: string,
): Promise<PluginIntegrityCheckResult> {
  if (!cacheRoot) return { ok: true };
  const receiptResult = await verifyInstallReceipt(cacheRoot, pluginId, pluginRoot);
  if (!receiptResult.ok) {
    return { ok: false, reason: receiptResult.reason };
  }
  const { installSource, signerKeyId, artifactSha256 } = receiptResult.receipt;
  if (installSource === "local-dev" && !isDevModeUnlocked()) {
    return {
      ok: false,
      reason: "local-dev install rejected in packaged build",
    };
  }
  return {
    ok: true,
    verified: { installSource, artifactSha256, signerKeyId },
  };
}

export function reportPluginIntegrity(
  pluginId: string,
  result: PluginIntegrityCheckResult,
  auditLog: IntegrityAuditLog | undefined,
): void {
  if (!result.ok) {
    log.error(
      {
        pluginId,
        reason: result.reason,
        ...(result.error === undefined ? {} : { err: result.error }),
      },
      `${pluginId} rejected — install receipt integrity failed`,
    );
    try {
      auditLog?.("error", "plugin_integrity_rejected", {
        pluginId,
        reason: result.reason,
      });
    } catch (error) {
      log.error({ pluginId, err: error }, "plugin integrity rejection audit failed");
    }
    return;
  }
  if (!result.verified) return;
  try {
    auditLog?.("info", "plugin_integrity_verified", {
      pluginId,
      ...result.verified,
    });
  } catch (error) {
    log.error({ pluginId, err: error }, "plugin integrity verification audit failed");
  }
}
