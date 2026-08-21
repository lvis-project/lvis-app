/**
 * Boot step: load + activate the plugin revocation registry.
 *
 * Mirrors `whitelist-bootstrap.ts` structurally. Must run BEFORE plugins are
 * loaded (`startPlugins()`/`pluginRuntime.startAll()`) so the LOAD-boundary
 * gate (`markRevoked` in `plugins/runtime/index.ts`) observes a
 * populated registry on the very first boot pass — same ordering
 * requirement as the whitelist, for the same reason.
 *
 * Unlike the whitelist bootstrap, there is no "no-cache-and-offline" toast:
 * that state is a HARD DENY for the whitelist (secret access), but for the
 * revocation registry it is the deliberate fail-open default (nothing is
 * blocked) — not a condition the user needs to be warned about.
 */
import { app } from "electron";
import { revocationRegistry } from "../../plugins/revocation/revocation-registry.js";
import type { AuditLogger } from "../../audit/audit-logger.js";

export interface RevocationBootstrapInput {
  bootAuditLogger: AuditLogger;
  /** Online toggle — disabled in tests or user-selected offline mode. */
  online?: boolean;
  /** App-shutdown AbortSignal, aborts an in-flight fetch on quit. */
  appShutdownSignal?: AbortSignal;
}

function isOnlineByDefault(): boolean {
  // E2E + unit tests set this so they don't hit the public CDN.
  if (process.env.LVIS_REVOCATION_OFFLINE === "1") return false;
  return true;
}

/**
 * Load + activate the revocation registry. Resolves once init completes —
 * never throws (every fail path is recorded as a status, and the default on
 * any fail path is fail-open — see `revocation-registry.ts`).
 */
export async function wireRevocationRegistry(input: RevocationBootstrapInput): Promise<void> {
  const { bootAuditLogger } = input;
  const online = input.online ?? isOnlineByDefault();
  const userDataDir = app.getPath("userData");

  await revocationRegistry.init({
    userDataDir,
    online,
    ...(input.appShutdownSignal ? { signal: input.appShutdownSignal } : {}),
    audit: (line: string) => {
      try {
        bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "boot",
          type: "info",
          input: line,
        });
      } catch {
        /* audit must not break boot */
      }
    },
    telemetry: () => {
      /* Revocation events piggyback on the audit line above; no separate
         counter map exists yet for this registry (unlike the whitelist's
         host-secret counters, which this domain has no natural home in). */
    },
  });
}
