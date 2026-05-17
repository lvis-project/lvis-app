import { type ReactNode } from "react";

export interface SettingsPageHeaderProps {
  title: string;
  description?: ReactNode;
}

export function SettingsPageHeader({ title, description }: SettingsPageHeaderProps) {
  return (
    <header className="space-y-1.5 mb-6">
      {/* Vertical alignment with sidebar first trigger:
          - Sidebar TabsList: `p-2` (8px) + trigger `py-2` (8px) + text-sm
            line-height 20px → trigger text box at Y=16, height 20.
          - Right pane stack: TabsContent's shadcn default `mt-2` (8px)
            is the ONLY top offset; we do NOT add additional pt-* to
            either the right-pane scroll container or this header.
            Header box top = 8 (mt-2).
          - h2 `leading-9` (36px) line box: text glyph top = 8 + (36-20)/2
            = 16, visually matching the sidebar trigger text top at Y=16. */}
      <h2 className="text-xl font-semibold leading-9 tracking-tight">{title}</h2>
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
    </header>
  );
}
