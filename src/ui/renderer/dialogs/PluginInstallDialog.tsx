import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import type { MarketplaceItem } from "../types.js";

export interface PluginInstallDialogProps {
  target: MarketplaceItem | null;
  onClose: () => void;
  onConfirm: (id: string) => void | Promise<void>;
  working: boolean;
}

export function PluginInstallDialog({ target, onClose, onConfirm, working }: PluginInstallDialogProps) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>플러그인 설치</DialogTitle>
          <DialogDescription>{target ? `'${target.name}' 설치?` : ""}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button
            onClick={async () => {
              if (!target) return;
              const id = target.id;
              onClose();
              await onConfirm(id);
            }}
            disabled={working}
          >설치</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
