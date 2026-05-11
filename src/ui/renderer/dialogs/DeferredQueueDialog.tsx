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
      <DialogContent
        className="flex max-h-[calc(100dvh-48px)] w-[calc(100vw-32px)] max-w-[760px] min-w-0 flex-col gap-0 overflow-hidden p-0"
        data-testid="deferred-queue-dialog"
      >
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle className="text-base">보류된 승인 큐</DialogTitle>
          <DialogDescription className="leading-relaxed">
            사용자가 보지 않는 실행에서 보류된 도구 호출입니다. 현재 채팅 권한 요청과 달리 자동으로 전면에 뜨지 않습니다.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <DeferredQueuePanel showEmpty />
        </div>
        <DialogFooter className="border-t px-5 py-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
