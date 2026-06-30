import { PageShell } from "./components/PageShell.js";
import { SettingsContent } from "./SettingsContent.js";
import type { LvisApi } from "./types.js";

/**
 * SettingsInlineView — the work-mode inline host for SettingsContent.
 *
 * appMode is the sole authority for inline-vs-detached (mirroring 업무보드 /
 * 루틴 / 메모리 / 별표 + plugin views): in work mode the sidebar Settings
 * item routes here via setActiveView("settings") + MainContent, instead of
 * the chat-mode detached BrowserWindow path (api.openSettingsWindow).
 *
 * The wrapper adds the back-to-home affordance the detached window does not
 * need (the window had its own OS chrome to close). SettingsContent itself is
 * reused verbatim — its tabs, normalizeSettingsTab routing, and per-tab save
 * orchestration are untouched.
 */
export function SettingsInlineView({
  api,
  initialTab,
  onSaved,
  onBack,
}: {
  api: LvisApi;
  initialTab: string;
  onSaved: () => void;
  onBack: () => void;
}) {
  return (
    <PageShell
      padded={false}
      maxWidth="none"
      onBack={onBack}
      backTestId="settings-inline-back"
      className="px-4 pt-4"
      contentClassName="flex min-h-0 flex-1 flex-col"
    >
      <SettingsContent api={api} onSaved={onSaved} initialTab={initialTab} />
    </PageShell>
  );
}
