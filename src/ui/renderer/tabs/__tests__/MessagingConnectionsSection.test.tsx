/**
 * The messaging-connection rows in the 원격 연결 list.
 *
 * The first assertion is the one that matters most: Telegram is built into this
 * build, so its row is on the page whether or not a marketplace catalog entry
 * for it was ever installed. Gating it on that list would delete the only way
 * to connect a bot from a machine that installed nothing.
 *
 * The rest is the reading, not the layout: the row is worded in the shared
 * state vocabulary, a marketplace connection this build cannot drive still
 * appears and says why, and a catalog entry for Telegram is folded INTO the
 * built-in row rather than listed beside it as a second Telegram.
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

/** The open-row set the tab owns, stood up around the group under test. */
function Harness({ api }: { api: LvisApi }) {
  const [expandedRowIds, setExpandedRowIds] = useState<readonly string[]>([]);
  const close = (rowId: string) =>
    setExpandedRowIds((open) => open.filter((id) => id !== rowId));
  return (
    <MessagingConnectionsSection
      api={api}
      chatGroupId="main"
      expandedRowIds={expandedRowIds}
      onToggleRow={(rowId) => setExpandedRowIds((open) => (
        open.includes(rowId) ? open.filter((id) => id !== rowId) : [...open, rowId]
      ))}
      onRowCompleted={close}
    />
  );
}

describe("MessagingConnectionsSection", () => {
  it("keeps Telegram on the page when nothing is installed from the marketplace", async () => {
    const { api } = makeApi([]);
    render(<Harness api={api} />);

    expect(await screen.findByTestId("connection:telegram")).toBeTruthy();
    fireEvent.click(screen.getByTestId("connection:telegram:toggle"));
    // The bot connection is a host surface, so its controls are reachable with
    // no catalog entry behind them at all.
    expect(await screen.findByTestId("telegram-connection-content")).toBeTruthy();
  });

  it("words the built-in row with the state the host reports", async () => {
    const { api } = makeApi([], "active");
    render(<Harness api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId("connection:telegram:state").textContent).toBe("연결됨");
    });
    // The handle is what makes the collapsed line concrete.
    expect(screen.getByTestId("connection:telegram:endpoint").textContent)
      .toBe("@lvis_desk_bot");
  });

  it("reads a connection that still needs its bot token as setup-needed", async () => {
    const { api } = makeApi([], "connected-unpaired");
    render(<Harness api={api} />);
    await waitFor(() => {
      expect(screen.getByTestId("connection:telegram:state").textContent).toBe("설정 필요");
    });
  });

  it("reads a pairing waiting on the other side as waiting, not as unset", async () => {
    const { api } = makeApi([], "pairing-pending");
    render(<Harness api={api} />);
    await waitFor(() => {
      expect(screen.getByTestId("connection:telegram:state").textContent).toBe("대기 중");
    });
  });

  it("reads a connection the owner paused as off", async () => {
    const { api } = makeApi([], "paused-by-owner");
    render(<Harness api={api} />);
    await waitFor(() => {
      expect(screen.getByTestId("connection:telegram:state").textContent).toBe("꺼짐");
    });
  });

  it("folds an installed Telegram catalog entry into the built-in row", async () => {
    const { api, openExternalUrl } = makeApi([TELEGRAM]);
    render(<Harness api={api} />);

    // One Telegram, not two: the catalog entry is metadata about the built-in
    // row, not a second connection.
    expect(await screen.findAllByTestId("connection:telegram")).toHaveLength(1);
    expect(screen.queryByTestId("messaging-connection:telegram")).toBeNull();

    fireEvent.click(screen.getByTestId("connection:telegram:toggle"));
    const detail = await screen.findByTestId("connection:telegram:detail");
    expect(await screen.findByTestId("telegram-connection-content")).toBeTruthy();
    expect(detail.textContent).toContain("Bot token");
    expect(detail.textContent).toContain("비밀");
    expect(screen.getByTestId("connection:telegram:egress").textContent)
      .toContain("api.telegram.org");

    fireEvent.click(screen.getByTestId("connection:telegram:docs"));
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
        .toBe("설정 필요");
    });
    // And it is listed BESIDE the built-in row, never instead of it.
    expect(screen.getByTestId("connection:telegram")).toBeTruthy();

    fireEvent.click(screen.getByTestId("messaging-connection:future-messenger:toggle"));
    expect(await screen.findByTestId("messaging-connection:future-messenger:unavailable"))
      .toBeTruthy();
  });
});
