import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";
import { DeferredQueuePanel } from "../components/permissions/DeferredQueuePanel.js";

export interface DeferredQueueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeferredQueueDialog({ open, onOpenChange }: DeferredQueueDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="flex min-w-0 flex-col gap-0 overflow-hidden p-0"
        data-testid="deferred-queue-dialog"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("deferredQueueDialog.title")}</DialogTitle>
          <DialogDescription>{t("deferredQueueDialog.description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <DeferredQueuePanel showEmpty onClose={() => onOpenChange(false)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
