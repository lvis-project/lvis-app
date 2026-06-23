import { useEffect } from "react";
import { t } from "../../../../i18n/runtime.js";
import type { LvisApi } from "../../types.js";
import type { PersistentItem } from "./types.js";

interface Options {
  api: LvisApi;
  upsertPersistent: (item: PersistentItem) => void;
  /** Opens Settings → Permissions when the cell is clicked. */
  onOpenPermissions?: () => void;
}

type ModeVariant = "default" | "strict" | "auto" | "allow" | "unknown";

const MODE_LABEL_KEYS: Record<ModeVariant, string> = {
  default: "permissionModeBadge.labelDefault",
  strict: "permissionModeBadge.labelStrict",
  auto: "permissionModeBadge.labelAuto",
  allow: "permissionModeBadge.labelAllow",
  unknown: "permissionModeBadge.labelUnknown",
};

function normalizeMode(raw: string): ModeVariant {
  if (raw === "default" || raw === "strict" || raw === "auto" || raw === "allow") return raw;
  return "unknown";
}

/**
 * Permission/review status for the status bar.
 *
 * Renders the active permission mode (default | strict | auto | allow) as PLAIN
 * TEXT — styled exactly like the vendor/model cell (a `value`-only persistent
 * item, no pill/badge). It registers AFTER the vendor producer so it lands to
 * the right of the model name (the status bar maps persistent items in
 * registration order, with a `|` divider between cells).
 *
 * The pending-approval count is appended to the same text when the deferred
 * queue is non-empty, so users keep one glanceable permission cell instead of
 * the old action-row pill + queue badge pair.
 *
 * Reads via the existing `window.lvis.permission` IPC (getMode + deferredList)
 * and stays reactive through `onModeChanged` / `onDeferredPending`.
 */
export function useStatusBarPermission({ api, upsertPersistent, onOpenPermissions }: Options): void {
  useEffect(() => {
    const perm = api.permission;
    if (!perm) return;
    let mode: ModeVariant = "unknown";
    let pending = 0;
    let cancelled = false;

    const render = () => {
      if (cancelled) return;
      const label = t(MODE_LABEL_KEYS[mode]);
      const value = pending > 0 ? `${label}${t("permissionModeBadge.pendingTextCount", { count: pending })}` : label;
      upsertPersistent({
        id: "permission:mode",
        severity: pending > 0 ? "warning" : "info",
        value,
        a11yLabel: t("permissionModeBadge.labelUnknown"),
        tooltip: value,
        onClick: onOpenPermissions,
      });
    };

    void (async () => {
      try {
        const r = await perm.getMode();
        mode = normalizeMode(r.mode);
      } catch {
        mode = "unknown";
      }
      render();
    })();

    void (async () => {
      try {
        const result = await perm.deferredList?.();
        if (result?.ok) pending = result.pending?.length ?? 0;
      } catch {
        pending = 0;
      }
      render();
    })();

    const unsubs: Array<() => void> = [];
    const offMode = perm.onModeChanged?.((next) => {
      mode = normalizeMode(next);
      render();
    });
    if (offMode) unsubs.push(offMode);
    const offPending = perm.onDeferredPending?.((summary) => {
      pending = Math.max(0, summary.pending);
      render();
    });
    if (offPending) unsubs.push(offPending);

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [api, upsertPersistent, onOpenPermissions]);
}
