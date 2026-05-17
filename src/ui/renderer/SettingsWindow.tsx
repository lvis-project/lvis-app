import { useCallback, useEffect, useMemo, useState } from "react";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { normalizeSettingsTab } from "../../shared/settings-tabs.js";
import { getApi } from "./api-client.js";
import { SettingsContent } from "./SettingsContent.js";
import { ThemeProvider } from "./theme/index.js";

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

  return (
    <ThemeProvider api={api}>
      <TooltipProvider>
        <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
          <main className="min-h-0 flex-1 overflow-hidden">
            <SettingsContent
              open={true}
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
