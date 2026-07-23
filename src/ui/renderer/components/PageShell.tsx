import { type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { cn } from "../../../lib/utils.js";
import { useTranslation } from "../../../i18n/react.js";

export interface PageShellProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  backTestId?: string;
  padded?: boolean;
  maxWidth?: "none" | "reading" | "5xl" | "6xl" | "7xl";
  className?: string;
  contentClassName?: string;
  headerClassName?: string;
  "data-testid"?: string;
}

const maxWidthClass: Record<NonNullable<PageShellProps["maxWidth"]>, string> = {
  none: "max-w-none",
  // Matches ChatView's conversation column (max-w-[58rem]) so a paned view —
  // e.g. an inline plugin panel — lines up with the chat reading column instead
  // of sprawling to the full main-pane width.
  reading: "max-w-[58rem]",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
  "7xl": "max-w-7xl",
};

export function PageShell({
  title,
  description,
  actions,
  children,
  onBack,
  backLabel,
  backTestId = "page-shell-back",
  padded = true,
  maxWidth = "6xl",
  className,
  contentClassName,
  headerClassName,
  "data-testid": testId,
}: PageShellProps) {
  const { t } = useTranslation();
  const resolvedBackLabel = backLabel ?? t("settingsContent.backToHome");
  const hasHeader = title || description || actions || onBack;

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        padded && "p-4",
        className,
      )}
      data-testid={testId}
    >
      <div className={cn("mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden", maxWidthClass[maxWidth])}>
        {hasHeader ? (
          <header className={cn("shrink-0 pb-4", headerClassName)}>
            {onBack ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="mb-2 gap-2 px-2"
                data-testid={backTestId}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
                {resolvedBackLabel}
              </Button>
            ) : null}
            {title || description || actions ? (
              <div className="flex min-w-0 items-start justify-between gap-4">
                <div className="min-w-0 space-y-1.5">
                  {title ? (
                    <h2 className="text-xl font-semibold leading-8 tracking-normal text-foreground">
                      {title}
                    </h2>
                  ) : null}
                  {description ? (
                    <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                      {description}
                    </p>
                  ) : null}
                </div>
                {actions ? <div className="shrink-0">{actions}</div> : null}
              </div>
            ) : null}
          </header>
        ) : null}
        <div className={cn("min-h-0 flex-1 overflow-hidden", contentClassName)}>
          {children}
        </div>
      </div>
    </div>
  );
}

export interface PageSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}

export function PageSection({
  title,
  description,
  badge,
  actions,
  id,
  className,
  children,
}: PageSectionProps) {
  return (
    <section
      id={id}
      className={cn(
        "border-t border-border/(--opacity-medium) py-5 first:border-t-0 first:pt-0 last:pb-0",
        className,
      )}
    >
      {(title || description || badge || actions) ? (
        <header className="mb-4 flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            {title ? (
              <h3 className="flex min-w-0 items-center gap-2 text-base font-semibold leading-6 text-foreground">
                <span className="min-w-0 truncate">{title}</span>
                {badge}
              </h3>
            ) : null}
            {description ? (
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </header>
      ) : null}
      <div className="space-y-3">{children}</div>
    </section>
  );
}
