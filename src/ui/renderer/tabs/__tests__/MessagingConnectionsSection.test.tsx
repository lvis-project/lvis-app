/**
 * The 원격 연결 tab's list of installed messaging connections.
 *
 * What is asserted is the reading, not the layout: an installed connection is
 * listed with the state its own driver reports, a connection this build has no
 * driver for still appears and says so, and nothing is listed before one is
 * installed.
 */
// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
          botUsername: null,
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

describe("MessagingConnectionsSection", () => {
  it("says nothing is installed before a connection is installed", async () => {
    const { api } = makeApi([]);
    render(<MessagingConnectionsSection api={api} />);
    expect(await screen.findByTestId("messaging-connections-empty")).toBeTruthy();
  });

  it("lists an installed connection with the state its driver reports", async () => {
    const { api } = makeApi([TELEGRAM], "active");
    render(<MessagingConnectionsSection api={api} />);

    const card = await screen.findByTestId("messaging-connection:telegram");
    expect(card.textContent).toContain("Telegram");
    expect(card.textContent).toContain("Reach one LVIS conversation from Telegram.");
    await waitFor(() => {
      expect(screen.getByTestId("messaging-connection:state:telegram").textContent)
        .toBe("연결됨");
    });
    expect(
      (screen.getByTestId("messaging-connection:configure:telegram") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("reads a connection that still needs its bot token as setup-needed", async () => {
    const { api } = makeApi([TELEGRAM], "connected-unpaired");
    render(<MessagingConnectionsSection api={api} />);
    await waitFor(() => {
      expect(screen.getByTestId("messaging-connection:state:telegram").textContent)
        .toBe("설정 필요");
    });
  });

  it("shows what the connection asks for without ever holding a value", async () => {
    const { api, openExternalUrl } = makeApi([TELEGRAM]);
    render(<MessagingConnectionsSection api={api} />);

    fireEvent.click(await screen.findByTestId("messaging-connection:toggle:telegram"));
    const detail = await screen.findByTestId("messaging-connection:detail:telegram");
    expect(detail.textContent).toContain("Bot token");
    expect(detail.textContent).toContain("비밀");
    expect(screen.getByTestId("messaging-connection:egress:telegram").textContent)
      .toContain("api.telegram.org");

    fireEvent.click(screen.getByTestId("messaging-connection:docs:telegram"));
    expect(openExternalUrl).toHaveBeenCalledWith("https://core.telegram.org/bots/api");
  });

  it("keeps a connection this build cannot drive visible and inert", async () => {
    const { api } = makeApi([{
      ...TELEGRAM,
      connectionId: "future-messenger",
      label: "Future Messenger",
    }]);
    render(<MessagingConnectionsSection api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId("messaging-connection:state:future-messenger").textContent)
        .toBe("이 버전에서는 사용할 수 없음");
    });
    expect(
      (screen.getByTestId("messaging-connection:configure:future-messenger") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
