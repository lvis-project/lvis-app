import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { SettingsPageHeader } from "../components/PageShell.js";
import { ConnectionRow, type ConnectionRowState } from "../components/ConnectionRow.js";
import { LocalApiSurfacesSection } from "./LocalApiSurfacesSection.js";
import {
  MessagingConnectionsSection,
  messagingConnectionRowForSection,
} from "./MessagingConnectionsSection.js";
import { TailnetAccessContent } from "./TailnetAccessContent.js";
import type { LvisApi } from "../types.js";

export interface RemoteSurfacesTabProps {
  api: LvisApi;
  /**
   * The tile the away-authority grant would bind to — the focused conversation.
   * Threaded from the window because settings has no conversation of its own,
   * and main refuses a grant that names no tile.
   */
  chatGroupId: string;
  /**
   * The `data-settings-section` a deep link named, while it is still unapplied.
   *
   * The tab needs it because arrival looks its anchor up in the DOM, and an
   * anchor inside a collapsed row is not in the DOM: without this the link
   * would land the reader at the top of the page with the section they asked
   * for still folded away.
   */
  sectionTarget?: string | null;
}

const TAILNET_ROW = "connection:tailnet";
const LOCAL_API_ROW = "connection:local-api";

/**
 * Which row holds each anchor the registry lists for this tab.
 *
 * `remote-messaging-connections` is deliberately absent: it names the group of
 * installed connections, which is always mounted, so arrival finds it without
 * anything having to open.
 */
const ROW_FOR_SECTION: Readonly<Record<string, string>> = Object.freeze({
  "remote-tailnet": TAILNET_ROW,
  "remote-tailnet-observer": TAILNET_ROW,
  "remote-local-api": LOCAL_API_ROW,
});

/** What the collapsed Tailnet and local-API lines say, read from the host. */
interface HostSurfaceReadings {
  readonly tailnet: ConnectionRowState;
  readonly tailnetOrigin: string | null;
  readonly localApi: ConnectionRowState;
}

const UNREAD: HostSurfaceReadings = Object.freeze({
  tailnet: "checking",
  tailnetOrigin: null,
  localApi: "checking",
});

/**
 * The owner-facing home for surfaces that observe or drive this desktop's
 * conversation from somewhere else.
 *
 * One line per vendor. Each surface still keeps its own trust story and its own
 * controls — they open inside the row rather than stacking down the page, so
 * the question "what can reach this desktop" is answerable by reading a column
 * instead of scrolling through four fully expanded sections.
 */
export function RemoteSurfacesTab({ api, chatGroupId, sectionTarget = null }: RemoteSurfacesTabProps) {
  const { t } = useTranslation();
  // One row open at a time: the reason the tab was rebuilt is that everything
  // being open at once is unreadable, and an accordion that can end up fully
  // expanded is the same page again.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [readings, setReadings] = useState<HostSurfaceReadings>(UNREAD);

  const toggleRow = useCallback((rowId: string) => {
    setExpandedRowId((open) => (open === rowId ? null : rowId));
  }, []);

  useEffect(() => {
    if (sectionTarget === null) return;
    const row = ROW_FOR_SECTION[sectionTarget] ?? messagingConnectionRowForSection(sectionTarget);
    // Not every anchor on this tab belongs to a row. One that does not is
    // already in the DOM, and arrival will find it on its own.
    if (row === undefined || row === null) return;
    setExpandedRowId(row);
  }, [sectionTarget]);

  // Re-read whenever the open row changes. Neither the Tailnet listener config
  // nor the local-API gates emit a change event, and the only things that write
  // them are the controls inside these rows — so the accordion moving is
  // exactly the moment a collapsed line could be reporting a stale answer.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [observer, settings] = await Promise.all([
        api.tailnetObserver.snapshot(),
        api.getSettings(),
      ]);
      if (!alive) return;
      const localApiOn = settings.system?.localApiServer === true
        || settings.features?.a2aLoopbackServer === true
        || settings.features?.a2aRemoteRouting === true
        || settings.features?.a2aRemoteReceiver === true;
      setReadings({
        tailnet: !observer.ok
          ? "attention"
          : observer.snapshot.effective.enabled && observer.snapshot.listeningPort !== null
            ? "connected"
            : "needs-setup",
        tailnetOrigin: observer.ok ? observer.snapshot.derivedWebOrigin : null,
        localApi: localApiOn ? "connected" : "needs-setup",
      });
    })();
    return () => { alive = false; };
  }, [api, expandedRowId]);

  return (
    <div className="space-y-4" data-testid="remote-surfaces-tab">
      <SettingsPageHeader
        title={t("settingsContent.tabRemoteSurfaces")}
        description={t("remoteSurfacesTab.pageDescription")}
      />
      <div
        className="overflow-hidden rounded-md border border-border"
        data-testid="remote-connections-list"
      >
        <ConnectionRow
          label={t("remoteSurfacesTab.tailnetSectionTitle")}
          state={readings.tailnet}
          endpoint={readings.tailnetOrigin}
          expanded={expandedRowId === TAILNET_ROW}
          onToggle={() => toggleRow(TAILNET_ROW)}
          testId={TAILNET_ROW}
        >
          <TailnetAccessContent api={api} />
        </ConnectionRow>

        <MessagingConnectionsSection
          api={api}
          chatGroupId={chatGroupId}
          expandedRowId={expandedRowId}
          onToggleRow={toggleRow}
        />

        <ConnectionRow
          label={t("localApiSurfaces.sectionTitle")}
          state={readings.localApi}
          expanded={expandedRowId === LOCAL_API_ROW}
          onToggle={() => toggleRow(LOCAL_API_ROW)}
          separated={true}
          testId={LOCAL_API_ROW}
        >
          <LocalApiSurfacesSection />
        </ConnectionRow>
      </div>
    </div>
  );
}
