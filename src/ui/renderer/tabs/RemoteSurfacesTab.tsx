import { useCallback, useEffect, useMemo, useState } from "react";
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
 * The local API binds loopback-only and cannot be made to bind anything else —
 * the guard is in `src/api/http-server.ts`. The row names the address because
 * "on" is not one, and this is what a companion actually connects to.
 */
const LOCAL_API_HOST = "127.0.0.1";

/** The four opt-ins the local-API row summarizes and its body switches. */
const LOCAL_API_GATE_COUNT = 4;

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
  readonly tailnet: ConnectionRowState | null;
  readonly tailnetOrigin: string | null;
  readonly localApi: ConnectionRowState | null;
  readonly localApiGatesOn: number;
}

const UNREAD: HostSurfaceReadings = Object.freeze({
  tailnet: null,
  tailnetOrigin: null,
  localApi: null,
  localApiGatesOn: 0,
});

/**
 * The owner-facing home for surfaces that observe or drive this desktop's
 * conversation from somewhere else.
 *
 * One line per vendor. Each surface still keeps its own trust story and its own
 * controls — they open inside the row rather than stacking down the page, so
 * the question "what can reach this desktop" is answerable by reading a column
 * instead of scrolling through four fully expanded sections.
 *
 * Rows open independently, because setting two connections up side by side is
 * a real thing to want. What keeps the list from quietly becoming the old stack
 * again is the other half: a row folds itself away the moment the thing it was
 * opened for is done, and stays open — carrying its own error — when that did
 * not work.
 */
export function RemoteSurfacesTab({ api, chatGroupId, sectionTarget = null }: RemoteSurfacesTabProps) {
  const { t } = useTranslation();
  const [expandedRowIds, setExpandedRowIds] = useState<readonly string[]>([]);
  const [readings, setReadings] = useState<HostSurfaceReadings>(UNREAD);

  const toggleRow = useCallback((rowId: string) => {
    setExpandedRowIds((open) => (
      open.includes(rowId) ? open.filter((id) => id !== rowId) : [...open, rowId]
    ));
  }, []);

  const closeRow = useCallback((rowId: string) => {
    setExpandedRowIds((open) => open.filter((id) => id !== rowId));
  }, []);

  useEffect(() => {
    if (sectionTarget === null) return;
    const row = ROW_FOR_SECTION[sectionTarget] ?? messagingConnectionRowForSection(sectionTarget);
    // Not every anchor on this tab belongs to a row. One that does not is
    // already in the DOM, and arrival will find it on its own.
    if (row === undefined || row === null) return;
    setExpandedRowIds((open) => (open.includes(row) ? open : [...open, row]));
  }, [sectionTarget]);

  // Re-read whenever the open set changes. Neither the Tailnet listener config
  // nor the local-API gates emit a change event, and the only things that write
  // them are the controls inside these rows — so a row opening or closing is
  // exactly the moment a collapsed line could be reporting a stale answer.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [observer, settings] = await Promise.all([
        api.tailnetObserver.snapshot(),
        api.getSettings(),
      ]);
      if (!alive) return;
      const gatesOn = [
        settings.system?.localApiServer,
        settings.features?.a2aLoopbackServer,
        settings.features?.a2aRemoteRouting,
        settings.features?.a2aRemoteReceiver,
      ].filter((gate) => gate === true).length;
      setReadings({
        tailnet: !observer.ok
          ? "attention"
          : observer.snapshot.effective.enabled && observer.snapshot.listeningPort !== null
            ? "connected"
            : "needs-setup",
        tailnetOrigin: observer.ok ? observer.snapshot.derivedWebOrigin : null,
        // Off rather than "setup needed": these four are the owner's own
        // switches, and all of them down is a resting state, not an unfinished
        // one.
        localApi: gatesOn > 0 ? "connected" : "off",
        localApiGatesOn: gatesOn,
      });
    })();
    return () => { alive = false; };
  }, [api, expandedRowIds]);

  const localApiSubline = useMemo(
    () => (readings.localApi === null ? null : t("localApiSurfaces.rowSubline", {
      host: LOCAL_API_HOST,
      enabled: String(readings.localApiGatesOn),
      total: String(LOCAL_API_GATE_COUNT),
    })),
    [readings.localApi, readings.localApiGatesOn, t],
  );

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
          expanded={expandedRowIds.includes(TAILNET_ROW)}
          onToggle={() => toggleRow(TAILNET_ROW)}
          testId={TAILNET_ROW}
        >
          <TailnetAccessContent api={api} onCompleted={() => closeRow(TAILNET_ROW)} />
        </ConnectionRow>

        <MessagingConnectionsSection
          api={api}
          chatGroupId={chatGroupId}
          expandedRowIds={expandedRowIds}
          onToggleRow={toggleRow}
          onRowCompleted={closeRow}
        />

        {/* Last, and this desktop's own setting rather than a vendor — but the
            place a person looks for "what can reach this machine" is this one
            list, so it is a row in it. */}
        <ConnectionRow
          label={t("localApiSurfaces.sectionTitle")}
          state={readings.localApi}
          endpoint={localApiSubline}
          expanded={expandedRowIds.includes(LOCAL_API_ROW)}
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
