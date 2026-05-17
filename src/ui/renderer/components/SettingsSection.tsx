import { type ReactNode } from "react";
import { cn } from "../../../lib/utils.js";

export interface SettingsSectionProps {
  title: string;
  description?: ReactNode;
  /** Optional small badge next to title (e.g. "즉시 적용"). */
  badge?: ReactNode;
  /** Optional action node rendered top-right (e.g. a "재설정" button). */
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
        "rounded-lg border bg-card p-5 space-y-4",
        className,
      )}
    >
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              {title}
              {badge}
            </h3>
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
