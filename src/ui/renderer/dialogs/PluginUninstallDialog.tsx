import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";

export interface PluginUninstallDialogProps {
  target: { id: string; name: string } | null;
  onClose: () => void;
  onConfirm: (id: string) => void | Promise<void>;
  working: boolean;
}

export function PluginUninstallDialog({ target, onClose, onConfirm, working }: PluginUninstallDialogProps) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !working && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>플러그인 제거</DialogTitle>
          <DialogDescription>
            {target
              ? `'${target.name}' 플러그인을 제거합니다. 로컬 데이터, 설정, 저장된 비밀값, 기록된 로그인 세션도 함께 삭제됩니다.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={working}>취소</Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (!target) return;
              const id = target.id;
              await onConfirm(id);
            }}
            disabled={working}
          >{working ? "제거 중..." : "제거"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
