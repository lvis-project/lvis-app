import { useCallback, useEffect, useMemo, useState } from "react";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { normalizeSettingsTab } from "../../shared/settings-tabs.js";
import { getApi } from "./api-client.js";
import { SettingsContent } from "./SettingsContent.js";
import { ThemeProvider } from "./theme/index.js";

function closeCurrentWindow(): void {
  const lvisWindow = (window as unknown as {
    lvisWindow?: { close?: () => Promise<unknown> | unknown };
  }).lvisWindow;
  void lvisWindow?.close?.();
}

export function SettingsWindow({ initialTab }: { initialTab: string }) {
  const api = useMemo(() => getApi(), []);
  const [tab, setTab] = useState(() => normalizeSettingsTab(initialTab));

  useEffect(() => {
    document.title = "LVIS 설정";
  }, []);

  useEffect(() => {
    return api.onSettingsWindowTab((nextTab) => {
      setTab(normalizeSettingsTab(nextTab));
    });
  }, [api]);

  const handleSaved = useCallback(() => {
    void api.notifySettingsWindowSaved();
  }, [api]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) closeCurrentWindow();
  }, []);

  return (
    <ThemeProvider api={api}>
      <TooltipProvider>
        <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
          {/* Linear-style — outer "설정 / 앱 환경..." header removed.
              The native window chrome already shows "LVIS 설정" as the
              title, and each tab renders its own SettingsPageHeader.
              The in-page header was redundant + created the "왜 컨텐츠
              안에 컨텐츠" visual the user kept reporting. */}
          {/* main wrapper owns NO padding now — sidebar must reach the
              window's left edge directly (not sit inside another card).
              The sidebar + right pane already own their own internal
              padding. SettingsContent owns the scroll surface. */}
          <main className="min-h-0 flex-1 overflow-hidden">
            <SettingsContent
              open={true}
              onOpenChange={handleOpenChange}
              api={api}
              onSaved={handleSaved}
              initialTab={tab}
            />
          </main>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}
