import { useRef, useState } from "react";
import { AlertTriangle, Puzzle, RefreshCw, X } from "lucide-react";
import type { PluginUpdateInfo } from "../hooks/use-marketplace-updates.js";
import { useTranslation } from "../../../i18n/react.js";
import { PluginInstallDialog } from "../dialogs/PluginInstallDialog.js";
import { ToolbarStatusPill } from "./ToolbarStatusPill.js";
import type { MarketplaceItem, PluginMarketplaceInstallOptions } from "../types.js";
import {
  buildNetworkAccessAcknowledgement,
  hasNetworkAccessDisclosure,
} from "../../../shared/network-access.js";
import { errorMessage } from "../../../shared/error-message.js";

export interface PluginUpdatesPillProps {
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
}

/**
 * Toolbar pill for available plugin updates. Clicking runs the whole batch:
 * each update that discloses network access opens the install dialog for that
 * plugin's own consent first, so consent stays per plugin even though one
 * click starts the batch.
 *
 * The full list and the failure breakdown live in the pill's hover text — the
 * band has room for a count, and a count is what the user acts on.
 */
export function PluginUpdatesPill({
  updates,
  onDismiss,
  onSkip,
  onUpdate,
  onResolved,
}: PluginUpdatesPillProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failureSummary, setFailureSummary] = useState<PartialFailureSummary | null>(null);
  const [pendingDisclosureUpdate, setPendingDisclosureUpdate] = useState<PluginUpdateInfo | null>(null);
  const disclosureResolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  if (updates.length === 0) return null;

  const summary =
    updates.length === 1
      ? t("pluginUpdatesPill.summaryOne")
      : t("pluginUpdatesPill.summaryMany", { count: updates.length });
  const details = updates.map((update) => formatUpdateLabel(update)).join(", ");
  // The long form the band has no room for: either the full update list, or —
  // after a partial failure — the counts plus each failure's own message.
  const title = failureSummary
    ? `${t("pluginUpdatesPill.partialSummary", {
        succeeded: failureSummary.succeeded,
        failed: failureSummary.failed,
        names: failureSummary.failedNames.join(", "),
      })} ${failureSummary.detail}`
    : `${summary} ${details}`;
  // A failure the pill reports only in its hover text is a failure a screen
  // reader never announces: the accessible name is the whole of what that
  // reader gets. The update list is different — the count in the label already
  // says what there is to act on — so only the failure joins the name.
  const pillAriaLabel = failureSummary
    ? `${t("pluginUpdatesPill.pillAriaLabel")} ${title}`
    : t("pluginUpdatesPill.pillAriaLabel");

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
            failed.push({ update: u, message: t("pluginUpdatesPill.disclosureCancelled") });
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
        failed.push({ update: u, message: errorMessage(e) });
      }
    }
    setBusy(false);
    if (failed.length === 0) {
      // Whole batch succeeded — clear the pill. The host detector's next
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
      <ToolbarStatusPill
        tone={busy ? "muted" : failureSummary ? "warning" : "info"}
        icon={busy ? RefreshCw : failureSummary ? AlertTriangle : Puzzle}
        busy={busy}
        label={
          busy
            ? t("pluginUpdatesPill.updating")
            : failureSummary
              ? t("pluginUpdatesPill.retryButton")
              : updates.length === 1
                ? t("pluginUpdatesPill.pillLabelOne")
                : t("pluginUpdatesPill.pillLabelMany", { count: updates.length })
        }
        title={title}
        ariaLabel={pillAriaLabel}
        onClick={() => void handleUpdate()}
        disabled={busy}
        testId="marketplace-update-action"
        secondaryAction={{
          icon: X,
          title: t("pluginUpdatesPill.skipTitle"),
          ariaLabel: t("pluginUpdatesPill.skipAriaLabel"),
          onClick: () => void onSkip(),
          disabled: busy,
          testId: "marketplace-update-skip",
        }}
      />
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
