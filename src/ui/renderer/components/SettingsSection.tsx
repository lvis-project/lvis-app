import { type ReactNode } from "react";
import { PageSection } from "./PageShell.js";

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
    <PageSection
      id={id}
      title={title}
      description={description}
      badge={badge}
      actions={actions}
      className={className}
    >
      {children}
    </PageSection>
  );
}
