import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

/**
 * Modal v1 — solid card surface
 * ─────────────────────────────────────────────────────────────────────────
 *  Centered modals use a solid `bg-card` body so body text remains readable
 *  against the dimmed + blurred overlay behind. The earlier "glass" variant
 *  (`bg-action-view/5`) only worked for OverlayCard which floats directly
 *  over the chat surface — over a darkened backdrop, the 5% accent tint
 *  let the dim bleed through and washed out the content.
 *
 *  Visual contract:
 *    - DialogOverlay: themed --overlay backdrop + soft blur
 *    - DialogContent: solid `bg-card` + subtle accent border so the modal
 *      still picks up the bundle accent without sacrificing legibility.
 *      OverlayCard keeps its own glass styling (still applies to routine
 *      notification cards which never compete with a backdrop).
 *
 *  Size variants:
 *    sm   max-w-md  (448px)  — confirmations
 *    md   max-w-lg  (512px)  — default
 *    lg   max-w-2xl (672px)  — approval / queue / session detail
 *    xl   max-w-3xl (768px)  — multi-tab consoles
 *    2xl  max-w-5xl (1024px) — settings (plugin detail / per-section saves)
 *
 *  Consumers normally just write `<DialogContent size="lg">`. Specialized
 *  dialogs (e.g. ToolApprovalDialog) that need edge-to-edge inner sections
 *  can pass `className="p-0"` to drop the outer padding while keeping the
 *  card surface intact.
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-[hsl(var(--overlay)/0.72)] backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const dialogContentVariants = cva(
  [
    "fixed left-[50%] top-[50%] z-50 grid translate-x-[-50%] translate-y-[-50%] gap-4",
    "w-[calc(100vw-32px)] max-h-[90dvh] overflow-y-auto",
    "border border-action-view/30 bg-card text-card-foreground shadow-lg rounded-lg",
    "p-6 duration-200",
  ].join(" "),
  {
    variants: {
      size: {
        sm: "max-w-md",
        md: "max-w-lg",
        lg: "max-w-2xl",
        xl: "max-w-3xl",
        "2xl": "max-w-5xl",
      },
    },
    defaultVariants: {
      size: "md",
    },
  },
);

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof dialogContentVariants> {}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, size, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(dialogContentVariants({ size }), className)}
      {...props}
    />
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col space-y-1.5 text-center sm:text-left",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2 sm:gap-0",
        className,
      )}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
