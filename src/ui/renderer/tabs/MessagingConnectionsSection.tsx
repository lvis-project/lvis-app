/**
 * The messaging connections, as rows in the 원격 연결 list.
 *
 * Two kinds sit in this group and they are not the same thing. Telegram is
 * BUILT INTO this build: the host owns the bot connection, the pairing and the
 * share outright, so its row is always here whether or not a catalog entry for
 * it was ever installed. A marketplace-installed messaging connection is only a
 * record — installing one says this desktop may be reached through that service
 * and nothing more — so it appears as a row that can read back what the catalog
 * declared and nothing else, because this build carries nothing that could
 * drive it.
 *
 * Gating the Telegram row on the installed list is exactly the regression this
 * comment exists to prevent: on a machine with an empty
 * `installedMessagingConnections` the only way to connect a bot would vanish
 * from the app.
 *
 * Its own file rather than a block inside `RemoteSurfacesTab`: this is the one
 * group on the tab whose membership is partly data — what the owner installed —
 * so it owns that read and the per-connection state subscription.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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

/**
 * The connection ids this build implements itself.
 *
 * A catalog entry for one of these is metadata ABOUT the built-in row, not a
 * second connection: it is folded into that row rather than listed beside it,
 * so installing the Telegram entry never produces two Telegram lines.
 */
const HOST_BUILT_IN_CONNECTION_IDS: ReadonlySet<string> = new Set(["telegram"]);

/** The built-in Telegram row, in the accordion the tab owns. */
const TELEGRAM_ROW_ID = "connection:telegram";

/** The row id for a marketplace connection this build cannot drive. */
function marketplaceConnectionRowId(connectionId: string): string {
  return `messaging-connection:${connectionId}`;
}

/**
 * The row a settings deep link into a messaging connection has to open.
 *
 * Null for an anchor this group does not own, which is how the tab tells its
 * own sections from another vendor's.
 */
export function messagingConnectionRowForSection(section: string): string | null {
  return section === "remote-telegram" ? TELEGRAM_ROW_ID : null;
}

/** What the collapsed Telegram line says, read from the host. */
interface TelegramReading {
  /** Null until the host has answered — the row draws no word until then. */
  readonly state: ConnectionRowState | null;
  /** The bot the owner connected, when there is one. */
  readonly endpoint: string | null;
}

function telegramConnectionState(
  snapshot: TelegramConnectionSnapshot,
): ConnectionRowState {
  switch (snapshot.state) {
    case "active":
      return "connected";
    case "paused-by-owner":
      return "off";
    case "disconnected":
    case "connected-unpaired":
      return "needs-setup";
    // The owner has done their part and something else has to happen next: the
    // code has to be sent, or the share has to be granted.
    case "pairing-pending":
    case "paired-unapproved":
      return "pending";
    // A build with no Telegram support is something the owner fixes by
    // updating, which is the same kind of "you have to do something" the word
    // already means.
    case "unsupported":
      return "needs-setup";
    case "pairing-unrecognized":
    case "shared-conversation-missing":
    case "error":
      return "attention";
  }
}

/** The catalog read-back: what this connection will ask for, and what it reaches. */
function MessagingConnectionCatalog({ api, connection, rowId }: {
  api: LvisApi;
  connection: MarketplaceInstalledMessagingConnection;
  rowId: string;
}) {
  const { t } = useTranslation();
  const { docsUrl } = connection;
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

function TelegramConnectionRow({ api, chatGroupId, catalog, expanded, onToggle, onCompleted }: {
  api: LvisApi;
  chatGroupId: string;
  /** The catalog entry, when the owner installed one. The row exists either way. */
  catalog: MarketplaceInstalledMessagingConnection | undefined;
  expanded: boolean;
  onToggle: () => void;
  onCompleted: () => void;
}) {
  const { t } = useTranslation();
  const [reading, setReading] = useState<TelegramReading>({ state: null, endpoint: null });

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void api.telegramConnection.snapshot().then((result) => {
        if (!alive) return;
        setReading(result.ok
          ? {
              state: telegramConnectionState(result.snapshot),
              endpoint: result.snapshot.botUsername === null
                ? null
                : `@${result.snapshot.botUsername}`,
            }
          : { state: "attention", endpoint: null });
      });
    };
    refresh();
    return api.telegramConnection.onChanged(refresh);
  }, [api]);

  return (
    <ConnectionRow
      label={t("telegramConnection.sectionTitle")}
      state={reading.state}
      endpoint={reading.endpoint}
      expanded={expanded}
      onToggle={onToggle}
      separated={true}
      testId={TELEGRAM_ROW_ID}
    >
      <div className="space-y-3">
        <TelegramConnectionContent
          api={api}
          chatGroupId={chatGroupId}
          onCompleted={onCompleted}
        />
        {catalog === undefined ? null : (
          <MessagingConnectionCatalog api={api} connection={catalog} rowId={TELEGRAM_ROW_ID} />
        )}
      </div>
    </ConnectionRow>
  );
}

/** A connection the owner installed that this build carries no code to drive. */
function MarketplaceConnectionRow({ api, connection, expanded, onToggle }: {
  api: LvisApi;
  connection: MarketplaceInstalledMessagingConnection;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const rowId = marketplaceConnectionRowId(connection.connectionId);
  return (
    <ConnectionRow
      label={connection.label}
      // Updating the app is the something the owner has to do, which is what
      // the word already means. It stays visible rather than disappearing:
      // the owner installed it and is owed an explanation.
      state="needs-setup"
      expanded={expanded}
      onToggle={onToggle}
      separated={true}
      testId={rowId}
    >
      <div className="space-y-3">
        <p
          className="text-[11px] text-muted-foreground"
          data-testid={`${rowId}:unavailable`}
        >
          {t("remoteSurfacesTab.messagingUnavailableHelp")}
        </p>
        <MessagingConnectionCatalog api={api} connection={connection} rowId={rowId} />
      </div>
    </ConnectionRow>
  );
}

export interface MessagingConnectionsSectionProps {
  api: LvisApi;
  chatGroupId: string;
  /** Every row the tab currently has open, across every vendor on the page. */
  expandedRowIds: readonly string[];
  onToggleRow: (rowId: string) => void;
  /** Fold a row away because what it was opened for is done. */
  onRowCompleted: (rowId: string) => void;
}

export function MessagingConnectionsSection({
  api,
  chatGroupId,
  expandedRowIds,
  onToggleRow,
  onRowCompleted,
}: MessagingConnectionsSectionProps) {
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

  const telegramCatalog = useMemo(
    () => connections.find((connection) => connection.connectionId === "telegram"),
    [connections],
  );
  const marketplaceOnly = useMemo(
    () => connections
      .filter((connection) => !HOST_BUILT_IN_CONNECTION_IDS.has(connection.connectionId))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [connections],
  );

  const toggleMarketplaceRow = useCallback(
    (connectionId: string) => onToggleRow(marketplaceConnectionRowId(connectionId)),
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
      <TelegramConnectionRow
        api={api}
        chatGroupId={chatGroupId}
        catalog={telegramCatalog}
        expanded={expandedRowIds.includes(TELEGRAM_ROW_ID)}
        onToggle={() => onToggleRow(TELEGRAM_ROW_ID)}
        onCompleted={() => onRowCompleted(TELEGRAM_ROW_ID)}
      />
      {marketplaceOnly.map((connection) => (
        <MarketplaceConnectionRow
          key={connection.connectionId}
          api={api}
          connection={connection}
          expanded={expandedRowIds.includes(marketplaceConnectionRowId(connection.connectionId))}
          onToggle={() => toggleMarketplaceRow(connection.connectionId)}
        />
      ))}
    </div>
  );
}
