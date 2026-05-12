import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { DeferredQueuePanel } from "../components/permissions/DeferredQueuePanel.js";

export interface DeferredQueueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeferredQueueDialog({ open, onOpenChange }: DeferredQueueDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="flex min-w-0 flex-col gap-0 overflow-hidden p-0"
        data-testid="deferred-queue-dialog"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>보류된 권한 요청 검토</DialogTitle>
          <DialogDescription>사용자가 권한 큐 버튼에서 직접 연 보류 승인 목록입니다.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <DeferredQueuePanel showEmpty onClose={() => onOpenChange(false)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
