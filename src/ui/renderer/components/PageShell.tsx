/**
 * The page chrome, whole: the outer page frame (`PageShell`), the unframed
 * section grouping inside it (`SettingsSection`), the settings page header, and
 * the "?" help popover that the header and the section both render.
 *
 * They live together because they only make sense together — the header and the
 * section each render the popover, and a reader asking "how is a page laid out"
 * should find the whole answer in one place. There is exactly one section
 * implementation; a second name for it is a copy waiting to drift.
 */
import { type ReactNode } from "react";
import { cn } from "../../../lib/utils.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover.js";

export interface SettingsHelpPopoverProps {
  children: ReactNode;
  ariaLabel?: string;
  testId?: string;
}

export function SettingsHelpPopover({
  children,
  ariaLabel,
  testId,
}: SettingsHelpPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          data-testid={testId}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          ?
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-sm leading-6 text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}

export interface PageShellProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  maxWidth?: "none" | "reading" | "5xl" | "6xl" | "7xl";
  className?: string;
  contentClassName?: string;
  headerClassName?: string;
  "data-testid"?: string;
}

const maxWidthClass: Record<NonNullable<PageShellProps["maxWidth"]>, string> = {
  none: "max-w-none",
  // The same `--reading-column-max` ChatView's conversation column takes, so a
  // paned view — e.g. an inline plugin panel — lines up with the chat reading
  // column instead of sprawling to the full main-pane width.
  reading: "max-w-(--reading-column-max)",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
  "7xl": "max-w-7xl",
};

export function PageShell({
  title,
  description,
  actions,
  children,
  padded = true,
  maxWidth = "6xl",
  className,
  contentClassName,
  headerClassName,
  "data-testid": testId,
}: PageShellProps) {
  const hasHeader = title || description || actions;

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

export interface SettingsPageHeaderProps {
  title: string;
  description?: ReactNode;
}

export function SettingsPageHeader({ title, description }: SettingsPageHeaderProps) {
  return (
    <header className="pt-2 mb-6">
      {/* Symmetric stack — both sidebar and right pane use pt-2 (8px) on
          their outer column wrapper to create matching top breathing
          room, then h2 inherits TabsContent's `mt-2` (8px) + this
          header's `pt-2` (8px) for a total Y=24 box top, matching the
          sidebar wrapper `pt-2 (8) + TabsList p-2 (8) + trigger py-2 (8)
          = 24` text box top. Both end at the same baseline.
          h2 uses `leading-9` so its line-box (36px) matches the sidebar
          trigger row height. */}
      <div className="flex min-w-0 items-center gap-2">
        <h2
          tabIndex={-1}
          className="min-w-0 truncate rounded-sm text-xl font-semibold leading-9 tracking-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="settings-page-title"
        >
          {title}
        </h2>
        {description ? (
          <SettingsHelpPopover ariaLabel={title} testId="settings-page-help">
            {description}
          </SettingsHelpPopover>
        ) : null}
      </div>
    </header>
  );
}

/** Outcome line a settings section shows under its controls after an action. */
export type SettingsSectionFeedback =
  | { readonly tone: "error" | "success"; readonly text: string }
  | null;

export interface SettingsSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  /** Optional id for anchor scroll. */
  id?: string;
  className?: string;
  children: ReactNode;
}

export function SettingsSection({
  title,
  description,
  badge,
  actions,
  id,
  className,
  children,
}: SettingsSectionProps) {
  return (
    <section
      id={id}
      className={cn(
        "min-w-0 border-t border-border/(--opacity-medium) py-5 first:border-t-0 first:pt-0 last:pb-0",
        className,
      )}
    >
      {(title || description || badge || actions) ? (
        <header className="mb-4 flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            {title ? (
              <h3 className="flex min-w-0 items-center gap-2 text-base font-semibold leading-6 text-foreground">
                <span className="min-w-0 truncate">{title}</span>
                {description ? (
                  <SettingsHelpPopover
                    ariaLabel={typeof title === "string" ? title : undefined}
                    testId="settings-section-help"
                  >
                    {description}
                  </SettingsHelpPopover>
                ) : null}
                {badge}
              </h3>
            ) : null}
            {!title && description ? (
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
