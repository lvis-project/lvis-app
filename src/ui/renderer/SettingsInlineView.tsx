/**
 * Settings as the app's own surface.
 *
 * It draws no page of its own. The pane it sits in IS the page: the frame's
 * outline is its edge, the frame's 36px header carries its name, and the inset
 * is whatever `SettingsContent`'s two regions set for themselves — the nav
 * column's `p-2`/`px-3` and the right pane's `px-4`/`px-8`. The page margin
 * this wrapper used to add on top of those (`px-3 pt-4 sm:px-4`) would have
 * pushed the nav column's full-height divider off the frame's hairline, and
 * its `sm:` measured the window while everything else in settings measures the
 * pane.
 */
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
  );
}
