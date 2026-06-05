import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";
import type { MarketplaceItem } from "../types.js";

export interface PluginInstallDialogProps {
  target: MarketplaceItem | null;
  onClose: () => void;
  onConfirm: (id: string) => void | Promise<void>;
  working: boolean;
}

/**
 * Install-confirmation dialog. For an `installPolicy: "admin"` plugin it acts as
 * a UAC-style consent gate (#1098): the user sees an explicit administrator-
 * privilege warning and must check an acknowledgment box before the install
 * button enables. Non-admin plugins get a plain confirm. The marketplace UI only
 * routes admin installs here, so the user-policy branch is a safe default.
 */
export function PluginInstallDialog({ target, onClose, onConfirm, working }: PluginInstallDialogProps) {
  const { t } = useTranslation();
  const isAdmin = target?.installPolicy === "admin";
  const [consented, setConsented] = useState(false);

  // Re-arm consent every time the dialog opens for a different plugin so a prior
  // acknowledgment can never carry over to the next admin install.
  useEffect(() => {
    setConsented(false);
  }, [target?.id]);

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isAdmin ? t("pluginInstallDialog.adminTitle") : t("pluginInstallDialog.title")}</DialogTitle>
          <DialogDescription>{target ? t("pluginInstallDialog.confirmInstall", { name: target.name }) : ""}</DialogDescription>
        </DialogHeader>
        {isAdmin && target && (
          <div className="space-y-3" data-testid="plugin-install-consent">
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive"
            >
              {t("pluginInstallDialog.adminWarning", { name: target.name })}
            </div>
            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                checked={consented}
                onCheckedChange={(value) => setConsented(value === true)}
                aria-label={t("pluginInstallDialog.adminConsent")}
              />
              <span>{t("pluginInstallDialog.adminConsent")}</span>
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t("pluginInstallDialog.cancel")}</Button>
          <Button
            variant={isAdmin ? "destructive" : "default"}
            onClick={() => {
              if (!target) return;
              void onConfirm(target.id);
            }}
            disabled={working || (isAdmin && !consented)}
          >
            {isAdmin ? t("pluginInstallDialog.adminInstall") : t("pluginInstallDialog.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
