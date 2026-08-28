import { useTranslation } from "../../../i18n/react.js";
import { SettingsPageHeader } from "../components/PageShell.js";
import { LocalApiSurfacesSection } from "./LocalApiSurfacesSection.js";
import { TailnetAccessContent } from "./TailnetAccessContent.js";
import { TelegramConnectionContent } from "./TelegramConnectionContent.js";
import type { LvisApi } from "../types.js";

export interface RemoteSurfacesTabProps {
  api: LvisApi;
  /**
   * The tile the away-authority grant would bind to — the focused conversation.
   * Threaded from the window because settings has no conversation of its own,
   * and main refuses a grant that names no tile.
   */
  chatGroupId: string;
}

/**
 * The owner-facing home for surfaces that observe or drive this desktop's
 * conversation from somewhere else. Each surface keeps its own trust story and
 * its own section; they deliberately do not share a single enable switch.
 */
export function RemoteSurfacesTab({ api, chatGroupId }: RemoteSurfacesTabProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6" data-testid="remote-surfaces-tab">
      <SettingsPageHeader
        title={t("settingsContent.tabRemoteSurfaces")}
        description={t("remoteSurfacesTab.pageDescription")}
      />
      <TailnetAccessContent api={api} />
      <TelegramConnectionContent api={api} chatGroupId={chatGroupId} />
      <LocalApiSurfacesSection />
    </div>
  );
}
