import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";

export interface PluginUninstallDialogProps {
  target: { id: string; name: string } | null;
  onClose: () => void;
  onConfirm: (id: string) => void | Promise<void>;
  working: boolean;
}

export function PluginUninstallDialog({ target, onClose, onConfirm, working }: PluginUninstallDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !working && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pluginUninstallDialog.title")}</DialogTitle>
          <DialogDescription>
            {target
              ? t("pluginUninstallDialog.description", { name: target.name })
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={working}>{t("pluginUninstallDialog.cancelButton")}</Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (!target) return;
              const id = target.id;
              await onConfirm(id);
            }}
            disabled={working}
          >{working ? t("pluginUninstallDialog.workingButton") : t("pluginUninstallDialog.confirmButton")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
