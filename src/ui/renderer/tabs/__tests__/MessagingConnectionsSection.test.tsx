/**
 * The messaging-connection rows in the 원격 연결 list.
 *
 * What is asserted is the reading, not the layout: an installed connection is
 * one row worded in the shared state vocabulary, a connection this build has no
 * driver for still appears and says why it cannot be driven, opening a row
 * shows the connection's own controls together with what the catalog declared,
 * and nothing is listed before one is installed.
 */
// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceInstalledMessagingConnection } from "../../../../shared/marketplace-package-assets.js";
import type { TelegramConnectionState } from "../../../../shared/telegram-connection.js";
import type { LvisApi } from "../../types.js";
import { MessagingConnectionsSection } from "../MessagingConnectionsSection.js";

const TELEGRAM: MarketplaceInstalledMessagingConnection = {
  connectionId: "telegram",
  label: "Telegram",
  summary: "Reach one LVIS conversation from Telegram.",
  pairing: "one-time-code",
  credentials: [{ key: "botToken", label: "Bot token", secret: true }],
  egress: ["api.telegram.org"],
  docsUrl: "https://core.telegram.org/bots/api",
};

function makeApi(
  connections: readonly MarketplaceInstalledMessagingConnection[],
  telegramState: TelegramConnectionState = "disconnected",
) {
  const openExternalUrl = vi.fn(async () => undefined);
  const api = {
    getSettings: vi.fn(async () => ({
      marketplace: { installedMessagingConnections: connections },
    })),
    openExternalUrl,
    telegramConnection: {
      snapshot: vi.fn(async () => ({
        ok: true as const,
        snapshot: {
          state: telegramState,
          botUsername: "lvis_desk_bot",
          pairing: null,
          approval: null,
          pendingCode: null,
          lastErrorCode: null,
        },
      })),
      onChanged: vi.fn(() => () => undefined),
    },
  } as unknown as LvisApi;
  return { api, openExternalUrl };
}

/** The accordion the tab owns, stood up around the group under test. */
function Harness({ api }: { api: LvisApi }) {
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  return (
    <MessagingConnectionsSection
      api={api}
      chatGroupId="main"
      expandedRowId={expandedRowId}
      onToggleRow={(rowId) => setExpandedRowId((open) => (open === rowId ? null : rowId))}
    />
  );
}

describe("MessagingConnectionsSection", () => {
  it("says nothing is installed before a connection is installed", async () => {
    const { api } = makeApi([]);
    render(<Harness api={api} />);
    expect(await screen.findByTestId("messaging-connections-empty")).toBeTruthy();
  });

  it("lists an installed connection as one row with the state its driver reports", async () => {
    const { api } = makeApi([TELEGRAM], "active");
    render(<Harness api={api} />);

    const rows = await screen.findAllByTestId("messaging-connection:telegram");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Telegram");
    await waitFor(() => {
      expect(screen.getByTestId("messaging-connection:telegram:state").textContent)
        .toBe("연결됨");
    });
    // The handle is what makes the collapsed line concrete.
    expect(screen.getByTestId("messaging-connection:telegram:endpoint").textContent)
      .toBe("@lvis_desk_bot");
  });

  it("reads a connection that still needs its bot token as setup-needed", async () => {
    const { api } = makeApi([TELEGRAM], "connected-unpaired");
    render(<Harness api={api} />);
    await waitFor(() => {
      expect(screen.getByTestId("messaging-connection:telegram:state").textContent)
        .toBe("설정 필요");
    });
  });

  it("opens the connection's own controls and catalog in the row", async () => {
    const { api, openExternalUrl } = makeApi([TELEGRAM]);
    render(<Harness api={api} />);

    fireEvent.click(await screen.findByTestId("messaging-connection:telegram:toggle"));
    const detail = await screen.findByTestId("messaging-connection:telegram:detail");
    // The driver's own section — the controls that used to live further down
    // the page — is what the row opens onto.
    expect(await screen.findByTestId("telegram-connection-content")).toBeTruthy();
    expect(detail.textContent).toContain("Bot token");
    expect(detail.textContent).toContain("비밀");
    expect(screen.getByTestId("messaging-connection:telegram:egress").textContent)
      .toContain("api.telegram.org");

    fireEvent.click(screen.getByTestId("messaging-connection:telegram:docs"));
    expect(openExternalUrl).toHaveBeenCalledWith("https://core.telegram.org/bots/api");
  });

  it("keeps a connection this build cannot drive visible and says so", async () => {
    const { api } = makeApi([{
      ...TELEGRAM,
      connectionId: "future-messenger",
      label: "Future Messenger",
    }]);
    render(<Harness api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId("messaging-connection:future-messenger:state").textContent)
        .toBe("지원 안 됨");
    });
    fireEvent.click(screen.getByTestId("messaging-connection:future-messenger:toggle"));
    expect(await screen.findByTestId("messaging-connection:future-messenger:unavailable"))
      .toBeTruthy();
  });
});
