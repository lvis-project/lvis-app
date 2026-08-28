import { PageShell } from "./components/PageShell.js";
import { SettingsContent } from "./SettingsContent.js";
import type { LvisApi } from "./types.js";
import type { ExactDenyDraft } from "./exact-permission-decision.js";

export function SettingsInlineView({
  api,
  chatGroupId,
  initialTab,
  onSaved,
  onTabChange,
  exactDenyDraft = null,
  onExactDenySaved,
  onDiscardExactDeny,
}: {
  api: LvisApi;
  /**
   * The tile the away-authority grant would bind to — the focused conversation.
   * Threaded from the window because settings has no conversation of its own,
   * and main refuses a grant that names no tile.
   */
  chatGroupId: string;
  initialTab: string;
  onSaved: () => void;
  /** Required here (unlike on `SettingsContent`): the inline panel is the app's
   *  own settings surface, so dropping the read-back would leave the app unable
   *  to say where the user is. A missing forward is a type error, not a silent
   *  regression. */
  onTabChange: (tab: string) => void;
  exactDenyDraft?: ExactDenyDraft | null;
  onExactDenySaved?: (requestId: string) => void;
  onDiscardExactDeny?: () => void;
}) {
  return (
    <PageShell
      padded={false}
      maxWidth="none"
      className="px-3 pt-4 sm:px-4"
      contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <SettingsContent
        api={api}
        chatGroupId={chatGroupId}
        onSaved={onSaved}
        initialTab={initialTab}
        onTabChange={onTabChange}
        exactDenyDraft={exactDenyDraft}
        onExactDenySaved={onExactDenySaved}
        onDiscardExactDeny={onDiscardExactDeny}
      />
    </PageShell>
  );
}
