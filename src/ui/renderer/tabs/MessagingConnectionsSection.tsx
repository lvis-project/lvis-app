/**
 * Owner-facing list of the messaging connections installed from the
 * marketplace.
 *
 * A messaging connection is not a plugin bundle: installing one records that
 * this desktop may be reached through that service and nothing more. What the
 * catalog declared about it — the credentials it will ask for, the hosts it
 * reaches — is shown here so the owner can read it back after installing, and
 * the controls that actually drive a connection stay in that connection's own
 * section, which the card's action jumps to.
 *
 * Its own file rather than a block inside `RemoteSurfacesTab`: every other
 * surface on that tab is a section module of its own, and a tab body that also
 * held one section's state and IPC would be the odd one out.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type {
  MarketplaceInstalledMessagingConnection,
} from "../../../shared/marketplace-package-assets.js";
import type { TelegramConnectionSnapshot } from "../../../shared/telegram-connection.js";
import { SettingsSection } from "../components/PageShell.js";
import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion.js";
import type { LvisApi } from "../types.js";

/**
 * Coarse owner-visible state, shared by every connection.
 *
 * Deliberately far coarser than any one connection's own state machine: this
 * card answers "can I be reached here right now, and if not is that on me?".
 * The detail belongs to the connection's own section.
 */
type MessagingConnectionState =
  | "connected"
  | "paused"
  | "needs-setup"
  | "attention"
  /** Installed, but this build carries no driver for it. */
  | "unavailable";

/**
 * A connection this build can actually drive.
 *
 * The host owns these connections outright — they are not plugins — so the
 * table is the host's own list of what it implements. A connection installed
 * from a catalog that this build has no entry for stays visible and reads
 * `unavailable`, rather than disappearing or pretending to work.
 */
interface MessagingConnectionDriver {
  /** The `data-settings-section` the card's action sends the owner to. */
  readonly settingsSection: string;
  readonly readState: (api: LvisApi) => Promise<MessagingConnectionState>;
  readonly subscribe: (api: LvisApi, onChanged: () => void) => () => void;
}

function telegramConnectionState(
  snapshot: TelegramConnectionSnapshot,
): MessagingConnectionState {
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
      readState: async (api) => {
        const result = await api.telegramConnection.snapshot();
        return result.ok ? telegramConnectionState(result.snapshot) : "attention";
      },
      subscribe: (api, onChanged) => api.telegramConnection.onChanged(onChanged),
    },
  });

function stateLabelKey(state: MessagingConnectionState): string {
  switch (state) {
    case "connected": return "remoteSurfacesTab.messagingStateConnected";
    case "paused": return "remoteSurfacesTab.messagingStatePaused";
    case "needs-setup": return "remoteSurfacesTab.messagingStateNeedsSetup";
    case "attention": return "remoteSurfacesTab.messagingStateAttention";
    case "unavailable": return "remoteSurfacesTab.messagingStateUnavailable";
  }
}

function MessagingConnectionCard({ api, connection }: {
  api: LvisApi;
  connection: MarketplaceInstalledMessagingConnection;
}) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const driver = MESSAGING_CONNECTION_DRIVERS[connection.connectionId];
  const [state, setState] = useState<MessagingConnectionState>(
    driver ? "needs-setup" : "unavailable",
  );

  useEffect(() => {
    if (!driver) {
      setState("unavailable");
      return;
    }
    let alive = true;
    const refresh = () => {
      void driver.readState(api).then((next) => {
        if (alive) setState(next);
      });
    };
    refresh();
    const unsubscribe = driver.subscribe(api, refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api, driver]);

  const openDriverSection = useCallback(() => {
    if (!driver) return;
    const node = document.querySelector<HTMLElement>(
      `[data-settings-section="${driver.settingsSection}"]`,
    );
    if (!node) return;
    node.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
    // The scroll already put the section on screen; focusing without a second
    // scroll moves the keyboard caret to the controls the owner asked for.
    node.focus({ preventScroll: true });
  }, [driver, reducedMotion]);

  const bodyId = `messaging-connection-body-${connection.connectionId}`;
  const { docsUrl } = connection;
  return (
    <div
      className="rounded-md border border-border px-3 py-2.5"
      data-testid={`messaging-connection:${connection.connectionId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((open) => !open)}
          data-testid={`messaging-connection:toggle:${connection.connectionId}`}
        >
          <span className="mt-0.5 inline-block w-3 shrink-0 text-xs leading-none" aria-hidden={true}>
            {expanded ? "▾" : "▸"}
          </span>
          <span className="min-w-0 space-y-0.5">
            <span className="block truncate text-sm font-medium">{connection.label}</span>
            <span className="block line-clamp-1 text-[11px] text-muted-foreground">
              {connection.summary}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Badge
            variant={state === "connected" ? "default" : "secondary"}
            className="h-5 whitespace-nowrap px-2 text-[10px]"
            data-testid={`messaging-connection:state:${connection.connectionId}`}
          >
            {t(stateLabelKey(state))}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={driver === undefined}
            title={driver === undefined
              ? t("remoteSurfacesTab.messagingUnavailableHelp")
              : undefined}
            onClick={openDriverSection}
            data-testid={`messaging-connection:configure:${connection.connectionId}`}
          >
            {t("remoteSurfacesTab.messagingConfigure")}
          </Button>
        </div>
      </div>

      {expanded && (
        <div
          id={bodyId}
          className="mt-3 space-y-2 border-t border-border/(--opacity-medium) pt-2.5"
          data-testid={`messaging-connection:detail:${connection.connectionId}`}
        >
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
              data-testid={`messaging-connection:egress:${connection.connectionId}`}
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
              data-testid={`messaging-connection:docs:${connection.connectionId}`}
            >
              {t("remoteSurfacesTab.messagingDocsLink")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export interface MessagingConnectionsSectionProps {
  api: LvisApi;
}

export function MessagingConnectionsSection({ api }: MessagingConnectionsSectionProps) {
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

  return (
    <SettingsSection
      data-settings-section="remote-messaging-connections"
      title={t("remoteSurfacesTab.messagingTitle")}
      description={t("remoteSurfacesTab.messagingDescription")}
    >
      <div className="space-y-2" data-testid="messaging-connections-content">
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="messaging-connections-empty">
            {t("remoteSurfacesTab.messagingEmpty")}
          </p>
        ) : sorted.map((connection) => (
          <MessagingConnectionCard
            key={connection.connectionId}
            api={api}
            connection={connection}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
