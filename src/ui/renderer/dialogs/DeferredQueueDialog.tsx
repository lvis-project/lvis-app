import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { Button } from "../../../components/ui/button.js";
import { DeferredQueuePanel } from "../components/permissions/DeferredQueuePanel.js";

export interface DeferredQueueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeferredQueueDialog({ open, onOpenChange }: DeferredQueueDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="deferred-queue-dialog">
        <DialogHeader>
          <DialogTitle>보류된 승인 큐</DialogTitle>
          <DialogDescription>
            사용자가 보지 않는 실행에서 보류된 도구 호출입니다. 현재 채팅 권한 요청과 달리 자동으로 전면에 뜨지 않습니다.
          </DialogDescription>
        </DialogHeader>
        <DeferredQueuePanel showEmpty />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
