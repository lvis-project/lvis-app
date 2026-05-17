import { type ReactNode } from "react";

export interface SettingsPageHeaderProps {
  title: string;
  description?: ReactNode;
}

export function SettingsPageHeader({ title, description }: SettingsPageHeaderProps) {
  return (
    <header className="pt-2 space-y-1 mb-4">
      {/*
        `leading-9` (36px) makes the h2's line-box height match the
        sidebar trigger's row height:
          sidebar p-2 (8) + trigger py-2 (8 top + 8 bottom) + text-sm
          (line-height 20px) = 36px total row + 8 outer = 44px block
          → text vertical center at 8 + 8 + 10 = 26px from sidebar top.
        With leading-9, h2's vertical center is at
          right-pane pt-2 (8) + 36/2 = 26px from right-pane top.
        Sidebar-top and right-pane-top share the same parent Y, so the
        two "모델" texts now align on a perfectly common baseline.
      */}
      <h2 className="text-xl font-semibold leading-9 tracking-tight">{title}</h2>
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
    </header>
  );
}
