import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import type { MarketplaceItem } from "../types.js";

export interface PluginUninstallDialogProps {
  target: MarketplaceItem | null;
  onClose: () => void;
  onConfirm: (id: string) => void | Promise<void>;
  working: boolean;
}

export function PluginUninstallDialog({ target, onClose, onConfirm, working }: PluginUninstallDialogProps) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>플러그인 제거</DialogTitle>
          <DialogDescription>{target ? `'${target.name}' 제거?` : ""}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (!target) return;
              const id = target.id;
              onClose();
              await onConfirm(id);
            }}
            disabled={working}
          >제거</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
