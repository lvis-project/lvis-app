import { type ReactNode } from "react";
import { PageSection } from "./PageShell.js";

export interface SettingsSectionProps {
  title: string;
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
