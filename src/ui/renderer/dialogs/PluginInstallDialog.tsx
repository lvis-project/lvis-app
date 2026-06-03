import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";
import type { MarketplaceItem } from "../types.js";

export interface PluginInstallDialogProps {
  target: MarketplaceItem | null;
  onClose: () => void;
  onConfirm: (id: string) => void | Promise<void>;
  working: boolean;
}

export function PluginInstallDialog({ target, onClose, onConfirm, working }: PluginInstallDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pluginInstallDialog.title")}</DialogTitle>
          <DialogDescription>{target ? t("pluginInstallDialog.confirmInstall", { name: target.name }) : ""}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t("pluginInstallDialog.cancel")}</Button>
          <Button
            onClick={async () => {
              if (!target) return;
              const id = target.id;
              onClose();
              await onConfirm(id);
            }}
            disabled={working}
          >{t("pluginInstallDialog.install")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
