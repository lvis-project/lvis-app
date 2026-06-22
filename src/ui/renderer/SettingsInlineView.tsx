import { ArrowLeft } from "lucide-react";
import { useTranslation } from "../../i18n/react.js";
import { Button } from "../../components/ui/button.js";
import { SettingsContent } from "./SettingsContent.js";
import type { LvisApi } from "./types.js";

/**
 * SettingsInlineView — the action-mode inline host for SettingsContent.
 *
 * appMode is the sole authority for inline-vs-detached (mirroring 업무보드 /
 * 루틴 / 메모리 / 별표 + plugin views): in action mode the sidebar Settings
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
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Back-to-home band — returns to the prior/home view. The 설정 heading
          lives in SettingsContent's own sidebar; this band carries only the
          return affordance the inline path requires (the detached window
          relied on OS window chrome to dismiss). */}
      <div className="flex shrink-0 items-center gap-2 px-2 pb-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="gap-2"
          data-testid="settings-inline-back"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("settingsContent.backToHome")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SettingsContent api={api} onSaved={onSaved} initialTab={initialTab} />
      </div>
    </div>
  );
}
