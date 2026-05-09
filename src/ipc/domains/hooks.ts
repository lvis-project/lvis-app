/**
 * Q12 Phase 4 — Layer 6 hook IPC handlers.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 *
 * Channels:
 *   lvis:hooks:trust-prompt  (main → renderer; sent by boot when new
 *                             or changed hooks are discovered)
 *   lvis:hooks:current        (renderer → main; late-mount UI fetches
 *                             the current pending request)
 *   lvis:hooks:accept         (renderer → main; per-file trust decision)
 *   lvis:hooks:reject-all     (renderer → main; reject everything in
 *                             the current pending request)
 */
import { ipcMain } from "electron";
import { hookTrustResolverRegistry } from "../../hooks/hook-trust-resolver-registry.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";

export function registerHooksHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  // Returns the pending hook diff (filenames + script hashes); gated
  // so a compromised foreign frame cannot enumerate the hook surface
  // (Copilot round 3).
  ipcMain.handle("lvis:hooks:current", (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:hooks:current", e);
      return UNAUTHORIZED_FRAME;
    }
    return hookTrustResolverRegistry.current();
  });

  ipcMain.handle(
    "lvis:hooks:accept",
    (e, params: { id: string; trustedFileNames: string[] }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:hooks:accept", e);
        return UNAUTHORIZED_FRAME;
      }
      if (
        !params ||
        typeof params.id !== "string" ||
        !Array.isArray(params.trustedFileNames)
      ) {
        return { ok: false, error: "invalid-params" };
      }
      const ok = hookTrustResolverRegistry.acceptFiles(
        params.id,
        params.trustedFileNames.filter((s): s is string => typeof s === "string"),
      );
      return ok ? { ok: true } : { ok: false, error: "no-pending-request" };
    },
  );

  ipcMain.handle(
    "lvis:hooks:reject-all",
    (e, params: { id: string }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:hooks:reject-all", e);
        return UNAUTHORIZED_FRAME;
      }
      if (!params || typeof params.id !== "string") {
        return { ok: false, error: "invalid-params" };
      }
      const ok = hookTrustResolverRegistry.rejectAll(params.id);
      return ok ? { ok: true } : { ok: false, error: "no-pending-request" };
    },
  );
}
