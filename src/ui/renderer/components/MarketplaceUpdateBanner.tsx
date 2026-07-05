// S8 — Non-blocking banner shown when plugin updates are available.

import { useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import type { PluginUpdateInfo } from "../hooks/use-marketplace-updates.js";
import { MarqueeText } from "./MarqueeText.js";
import { useTranslation } from "../../../i18n/react.js";
import { PluginInstallDialog } from "../dialogs/PluginInstallDialog.js";
import type { MarketplaceItem, PluginMarketplaceInstallOptions } from "../types.js";
import {
  buildNetworkAccessAcknowledgement,
  hasNetworkAccessDisclosure,
} from "../../../shared/network-access.js";




export function MarketplaceUpdateBanner({
  updates,
  onDismiss,
  onSkip,
  onUpdate,
  onResolved,
}: {
  updates: PluginUpdateInfo[];
  onDismiss: () => void;
  onSkip: () => void | Promise<void>;
  onUpdate: (
    pluginId: string,
    expectedVersion?: string,
    options?: PluginMarketplaceInstallOptions,
  ) => Promise<void>;
  /**
   * Notifies the parent which plugin ids updated successfully so the visible
   * update list can drop them optimistically. On a partial-failure batch the
   * succeeded rows are removed and only the failed rows stay for retry; the
   * host-driven `marketplace:updates-available` re-broadcast remains the SOT.
   */
  onResolved?: (succeededPluginIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failureSummary, setFailureSummary] = useState<PartialFailureSummary | null>(null);
  const [pendingDisclosureUpdate, setPendingDisclosureUpdate] = useState<PluginUpdateInfo | null>(null);
  const disclosureResolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  if (updates.length === 0) return null;

  const updateLabels = updates.map((update) => formatUpdateLabel(update));
  const summary =
    updates.length === 1
      ? t("marketplaceUpdateBanner.summaryOne")
      : t("marketplaceUpdateBanner.summaryMany", { count: updates.length });
  const details = updateLabels.join(", ");
  const label = `${summary} ${details}`;

  const handleUpdate = async () => {
    setBusy(true);
    setFailureSummary(null);
    const succeeded: PluginUpdateInfo[] = [];
    const failed: { update: PluginUpdateInfo; message: string }[] = [];
    for (const u of updates) {
      try {
        if (hasNetworkAccessDisclosure(u.networkAccess)) {
          const confirmed = await requestNetworkAccessDisclosure(u);
          if (!confirmed) {
            failed.push({ update: u, message: t("marketplaceUpdateBanner.disclosureCancelled") });
            continue;
          }
        }
        await onUpdate(
          u.pluginId,
          u.latestVersion,
          hasNetworkAccessDisclosure(u.networkAccess)
            ? { networkAccessAcknowledgement: buildNetworkAccessAcknowledgement(u.networkAccess) }
            : undefined,
        );
        succeeded.push(u);
      } catch (e) {
        failed.push({ update: u, message: (e as Error).message });
      }
    }
    setBusy(false);
    if (failed.length === 0) {
      // Whole batch succeeded — clear the banner. The host detector's next
      // `marketplace:updates-available` broadcast reconciles the SOT.
      onDismiss();
      return;
    }
    // Partial (or total) failure: drop the succeeded rows so only the failed
    // ones remain for retry, and surface a success/failure count breakdown.
    if (succeeded.length > 0) onResolved?.(succeeded.map((u) => u.pluginId));
    setFailureSummary({
      succeeded: succeeded.length,
      failed: failed.length,
      failedNames: failed.map((f) => displayName(f.update)),
      detail: failed.map((f) => `${displayName(f.update)}: ${f.message}`).join("; "),
    });
  };

  return (
    <>
      <div
        className="flex h-11 items-center justify-between gap-2 overflow-hidden bg-popover border border-info/(--opacity-medium) text-info text-sm px-4 py-1.5 rounded-md mx-2 mt-2 shadow-lg lvis-anim-slide-down"
        data-testid="marketplace-update-banner"
      >
        <span className="min-w-0 flex-1" title={label}>
          <span className="block truncate leading-4">{summary}</span>
          <MarqueeText text={details} className="text-[11px] leading-3 text-info/(--opacity-emphatic)" />
          {failureSummary ? (
            <span
              className="ml-2 text-destructive"
              data-testid="marketplace-update-partial-failure"
              title={failureSummary.detail}
            >
              {t("marketplaceUpdateBanner.partialSummary", {
                succeeded: failureSummary.succeeded,
                failed: failureSummary.failed,
                names: failureSummary.failedNames.join(", "),
              })}
            </span>
          ) : null}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleUpdate()}
            disabled={busy}
            data-testid="marketplace-update-action"
            className="h-7 text-[12px]"
          >
            {busy
              ? t("marketplaceUpdateBanner.updating")
              : failureSummary
                ? t("marketplaceUpdateBanner.retryButton")
                : t("marketplaceUpdateBanner.updateButton")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onSkip()}
            disabled={busy}
            aria-label={t("marketplaceUpdateBanner.skipAriaLabel")}
            title={t("marketplaceUpdateBanner.skipTitle")}
            className="text-info hover:text-info/(--opacity-intense) h-auto p-1"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <PluginInstallDialog
        target={pendingDisclosureUpdate ? updateToDialogTarget(pendingDisclosureUpdate) : null}
        working={false}
        onClose={() => finishDisclosure(false)}
        onConfirm={() => finishDisclosure(true)}
      />
    </>
  );

  function requestNetworkAccessDisclosure(update: PluginUpdateInfo): Promise<boolean> {
    return new Promise((resolve) => {
      disclosureResolveRef.current = resolve;
      setPendingDisclosureUpdate(update);
    });
  }

  function finishDisclosure(confirmed: boolean): void {
    const resolve = disclosureResolveRef.current;
    disclosureResolveRef.current = null;
    setPendingDisclosureUpdate(null);
    resolve?.(confirmed);
  }
}

interface PartialFailureSummary {
  succeeded: number;
  failed: number;
  failedNames: string[];
  detail: string;
}

function displayName(update: PluginUpdateInfo): string {
  const name = update.pluginName?.trim() || update.pluginId;
  return name === update.pluginId ? name : `${name} (${update.pluginId})`;
}

function formatUpdateLabel(update: PluginUpdateInfo): string {
  return `${displayName(update)} → ${update.latestVersion}`;
}

function updateToDialogTarget(update: PluginUpdateInfo): MarketplaceItem {
  return {
    id: update.pluginId,
    name: update.pluginName?.trim() || update.pluginId,
    description: "",
    packageSpec: "",
    installed: true,
    enabled: true,
    pluginType: "plugin",
    installPolicy: "user",
    networkAccess: update.networkAccess,
  };
}
