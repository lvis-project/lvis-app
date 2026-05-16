import { useCallback, useEffect, useMemo, useState } from "react";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { normalizeSettingsTab } from "../../shared/settings-tabs.js";
import { getApi } from "./api-client.js";
import { SettingsContent } from "./SettingsDialog.js";
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
          <header className="border-b bg-card px-6 py-5">
            <h1 className="text-lg font-semibold leading-none tracking-tight">설정</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              앱 환경, 채팅 동작, 검색 엔진, 권한 정책을 설정합니다.
            </p>
          </header>
          {/* SettingsContent now owns its own sidebar + scrollable right pane;
              the main wrapper must NOT scroll, otherwise the inner scroll is
              double-nested (you'd scroll the page, not the right pane) and
              the sidebar would scroll out of view — defeating the fixed
              sidebar conversion. */}
          <main className="min-h-0 flex-1 overflow-hidden p-6">
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
