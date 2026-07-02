import type { ReactNode } from "react";
import { Dialog as DialogPrimitive, VisuallyHidden } from "radix-ui";
import { DialogOverlay } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";

/**
 * Narrow-screen fallback for the docked workspace rail (§6.10.8 부가-A). When
 * the ChatView container is too narrow to dock the panel beside the transcript,
 * the SAME ChatSidePanel renders inside a right-anchored modal sheet built on
 * Radix Dialog (focus trap, ESC, backdrop, aria-modal for free). The panel's
 * tab state is unaffected because the store lives at ChatView level.
 */
export function WorkspaceRailDrawer({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal>
      <DialogPrimitive.Portal>
        <DialogOverlay data-testid="workspace-rail-drawer-backdrop" />
        <DialogPrimitive.Content
          data-testid="workspace-rail-drawer"
          aria-label={t("chatPreviewRail.title")}
          className="fixed inset-y-0 right-0 z-50 flex h-full w-[min(92vw,32rem)] flex-col border-l bg-background shadow-xl data-[state=open]:animate-in data-[state=open]:slide-in-from-right motion-reduce:animate-none"
        >
          <VisuallyHidden.Root>
            <DialogPrimitive.Title>{t("chatPreviewRail.title")}</DialogPrimitive.Title>
          </VisuallyHidden.Root>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
