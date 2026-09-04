/**
 * The messaging connections installed from the marketplace, as rows in the
 * 원격 연결 list.
 *
 * A messaging connection is not a plugin bundle: installing one records that
 * this desktop may be reached through that service and nothing more. What the
 * catalog declared about it — the credentials it will ask for, the hosts it
 * reaches — is shown inside the row so the owner can read it back after
 * installing, and the controls that actually drive the connection open in the
 * same place rather than in a second section further down the page. One vendor
 * is one line; there is nowhere left to jump to.
 *
 * Its own file rather than a block inside `RemoteSurfacesTab`: this is the one
 * group on the tab whose membership is data — what the owner installed — so it
 * owns the read, the per-connection state subscriptions, and the driver table
 * that says which of those this build can actually operate.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type {
  MarketplaceInstalledMessagingConnection,
} from "../../../shared/marketplace-package-assets.js";
import type { TelegramConnectionSnapshot } from "../../../shared/telegram-connection.js";
import { ConnectionRow, type ConnectionRowState } from "../components/ConnectionRow.js";
import { TelegramConnectionContent } from "./TelegramConnectionContent.js";
import type { LvisApi } from "../types.js";

/** What a driver reports about its connection for the collapsed row. */
interface MessagingConnectionReading {
  readonly state: ConnectionRowState;
  /** The handle or address this connection is reachable at, when it has one. */
  readonly endpoint: string | null;
}

/**
 * A connection this build can actually drive.
 *
 * The host owns these connections outright — they are not plugins — so the
 * table is the host's own list of what it implements. A connection installed
 * from a catalog that this build has no entry for stays visible and reads
 * `unavailable`, rather than disappearing or pretending to work.
 */
interface MessagingConnectionDriver {
  /** The `data-settings-section` this connection's controls carry. */
  readonly settingsSection: string;
  readonly read: (api: LvisApi) => Promise<MessagingConnectionReading>;
  readonly subscribe: (api: LvisApi, onChanged: () => void) => () => void;
  /** The controls themselves, rendered inside the row this driver owns. */
  readonly renderSection: (api: LvisApi, chatGroupId: string) => ReactNode;
}

function telegramConnectionState(
  snapshot: TelegramConnectionSnapshot,
): ConnectionRowState {
  switch (snapshot.state) {
    case "active":
      return "connected";
    case "paused-by-owner":
      return "paused";
    case "disconnected":
    case "connected-unpaired":
    case "pairing-pending":
    case "paired-unapproved":
      return "needs-setup";
    case "unsupported":
    case "pairing-unrecognized":
    case "shared-conversation-missing":
    case "error":
      return "attention";
  }
}

const MESSAGING_CONNECTION_DRIVERS: Readonly<Record<string, MessagingConnectionDriver>> =
  Object.freeze({
    telegram: {
      settingsSection: "remote-telegram",
      read: async (api) => {
        const result = await api.telegramConnection.snapshot();
        if (!result.ok) return { state: "attention", endpoint: null };
        return {
          state: telegramConnectionState(result.snapshot),
          endpoint: result.snapshot.botUsername === null
            ? null
            : `@${result.snapshot.botUsername}`,
        };
      },
      subscribe: (api, onChanged) => api.telegramConnection.onChanged(onChanged),
      renderSection: (api, chatGroupId) => (
        <TelegramConnectionContent api={api} chatGroupId={chatGroupId} />
      ),
    },
  });

/** The row id the tab's accordion uses for one installed connection. */
function messagingConnectionRowId(connectionId: string): string {
  return `messaging-connection:${connectionId}`;
}

/**
 * The row a settings deep link into a messaging connection has to open.
 *
 * Null for an anchor no driver claims, which is how the tab tells a section
 * this group owns from one belonging to another vendor on the page.
 */
export function messagingConnectionRowForSection(section: string): string | null {
  for (const [connectionId, driver] of Object.entries(MESSAGING_CONNECTION_DRIVERS)) {
    if (driver.settingsSection === section) return messagingConnectionRowId(connectionId);
  }
  return null;
}

/** The catalog read-back: what this connection will ask for, and what it reaches. */
function MessagingConnectionCatalog({ api, connection }: {
  api: LvisApi;
  connection: MarketplaceInstalledMessagingConnection;
}) {
  const { t } = useTranslation();
  const { docsUrl } = connection;
  const rowId = messagingConnectionRowId(connection.connectionId);
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">{connection.summary}</p>
      <div className="space-y-1">
        <p className="text-[11px] font-medium">
          {t("remoteSurfacesTab.messagingCredentialsLabel")}
        </p>
        <ul className="space-y-0.5">
          {connection.credentials.map((credential) => (
            <li
              key={credential.key}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <span>{credential.label}</span>
              {credential.secret && (
                <Badge variant="outline" className="h-4 px-1 text-[9px]">
                  {t("remoteSurfacesTab.messagingSecretBadge")}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </div>
      {connection.egress && connection.egress.length > 0 && (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid={`${rowId}:egress`}
        >
          {t("remoteSurfacesTab.messagingEgressLabel", {
            hosts: connection.egress.join(", "),
          })}
        </p>
      )}
      {docsUrl && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => void api.openExternalUrl(docsUrl)}
          data-testid={`${rowId}:docs`}
        >
          {t("remoteSurfacesTab.messagingDocsLink")}
        </Button>
      )}
    </div>
  );
}

function MessagingConnectionRow({ api, chatGroupId, connection, expanded, onToggle }: {
  api: LvisApi;
  chatGroupId: string;
  connection: MarketplaceInstalledMessagingConnection;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const driver = MESSAGING_CONNECTION_DRIVERS[connection.connectionId];
  const [reading, setReading] = useState<MessagingConnectionReading>(
    driver ? { state: "checking", endpoint: null } : { state: "unavailable", endpoint: null },
  );

  useEffect(() => {
    if (!driver) {
      setReading({ state: "unavailable", endpoint: null });
      return;
    }
    let alive = true;
    const refresh = () => {
      void driver.read(api).then((next) => {
        if (alive) setReading(next);
      });
    };
    refresh();
    const unsubscribe = driver.subscribe(api, refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api, driver]);

  const rowId = messagingConnectionRowId(connection.connectionId);
  return (
    <ConnectionRow
      label={connection.label}
      state={reading.state}
      endpoint={reading.endpoint}
      expanded={expanded}
      onToggle={onToggle}
      separated={true}
      testId={rowId}
    >
      <div className="space-y-3">
        {driver === undefined ? (
          <p
            className="text-[11px] text-muted-foreground"
            data-testid={`${rowId}:unavailable`}
          >
            {t("remoteSurfacesTab.messagingUnavailableHelp")}
          </p>
        ) : (
          driver.renderSection(api, chatGroupId)
        )}
        <MessagingConnectionCatalog api={api} connection={connection} />
      </div>
    </ConnectionRow>
  );
}

export interface MessagingConnectionsSectionProps {
  api: LvisApi;
  chatGroupId: string;
  /** The one row the tab currently has open, across every vendor on the page. */
  expandedRowId: string | null;
  onToggleRow: (rowId: string) => void;
}

export function MessagingConnectionsSection({
  api,
  chatGroupId,
  expandedRowId,
  onToggleRow,
}: MessagingConnectionsSectionProps) {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<
    readonly MarketplaceInstalledMessagingConnection[]
  >([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const settings = await api.getSettings();
      if (!alive) return;
      setConnections(settings.marketplace?.installedMessagingConnections ?? []);
    })();
    return () => { alive = false; };
  }, [api]);

  const sorted = useMemo(
    () => [...connections].sort((a, b) => a.label.localeCompare(b.label)),
    [connections],
  );

  const toggle = useCallback(
    (connectionId: string) => onToggleRow(messagingConnectionRowId(connectionId)),
    [onToggleRow],
  );

  return (
    // A real block rather than a display-contents wrapper: arrival scrolls to
    // this element and focuses it, and a box with no layout of its own reports
    // no position to scroll to.
    <div
      data-settings-section="remote-messaging-connections"
      tabIndex={-1}
      data-testid="messaging-connections-content"
    >
      {sorted.length === 0 ? (
        <p
          className="border-t border-border px-3 py-2.5 text-sm text-muted-foreground"
          data-testid="messaging-connections-empty"
        >
          {t("remoteSurfacesTab.messagingEmpty")}
        </p>
      ) : sorted.map((connection) => (
        <MessagingConnectionRow
          key={connection.connectionId}
          api={api}
          chatGroupId={chatGroupId}
          connection={connection}
          expanded={expandedRowId === messagingConnectionRowId(connection.connectionId)}
          onToggle={() => toggle(connection.connectionId)}
        />
      ))}
    </div>
  );
}
