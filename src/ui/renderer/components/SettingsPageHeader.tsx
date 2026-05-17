import { type ReactNode } from "react";

export interface SettingsPageHeaderProps {
  title: string;
  description?: ReactNode;
}

export function SettingsPageHeader({ title, description }: SettingsPageHeaderProps) {
  return (
    <header className="pt-2 space-y-1.5 mb-6">
      {/* Symmetric stack — both sidebar and right pane use pt-2 (8px) on
          their outer column wrapper to create matching top breathing
          room, then h2 inherits TabsContent's `mt-2` (8px) + this
          header's `pt-2` (8px) for a total Y=24 box top, matching the
          sidebar wrapper `pt-2 (8) + TabsList p-2 (8) + trigger py-2 (8)
          = 24` text box top. Both end at the same baseline.
          h2 uses `leading-9` so its line-box (36px) matches the sidebar
          trigger row height. */}
      <h2 className="text-xl font-semibold leading-9 tracking-tight">{title}</h2>
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
    </header>
  );
}
