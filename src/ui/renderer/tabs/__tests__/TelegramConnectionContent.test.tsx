import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type { TelegramConnectionSnapshot } from "../../../../shared/telegram-connection.js";
import type { LvisApi } from "../../types.js";
import { TelegramConnectionContent } from "../TelegramConnectionContent.js";

const PAIRING_ID = "33333333-3333-4333-8333-333333333333";
const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const CODE_ID = "55555555-5555-4555-8555-555555555555";
const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF";
const RAW_CODE = `lvis-tg-v1.${"A".repeat(43)}`;

function snapshotOf(
  overrides: Partial<TelegramConnectionSnapshot> = {},
): TelegramConnectionSnapshot {
  return {
    state: "disconnected",
    botUsername: null,
    pairing: null,
    approval: null,
    pendingCode: null,
    lastErrorCode: null,
    ...overrides,
  };
}

function makeApi(initial: TelegramConnectionSnapshot) {
  let current = initial;
  const snapshot = vi.fn(async () => ({ ok: true as const, snapshot: current }));
  const connect = vi.fn(async () => ({ ok: true as const }));
  const createPairingCode = vi.fn(async () => ({
    ok: true as const,
    pairingCode: {
      id: CODE_ID,
      code: RAW_CODE,
      expiresAt: 1_800_000_000_000,
      botUsername: "my_assistant_bot",
    },
  }));
  const approveCurrentConversation = vi.fn(async () => ({ ok: true as const }));
  const pause = vi.fn(async () => ({ ok: true as const }));
  const api = {
    telegramConnection: {
      snapshot,
      connect,
      disconnect: vi.fn(async () => ({ ok: true as const })),
      pause,
      resume: vi.fn(async () => ({ ok: true as const })),
      createPairingCode,
      revokePairing: vi.fn(async () => ({ ok: true as const })),
      approveCurrentConversation,
      revokeApproval: vi.fn(async () => ({ ok: true as const })),
      onChanged: vi.fn(() => () => undefined),
    },
  } as unknown as LvisApi;

  return {
    api,
    connect,
    createPairingCode,
    approveCurrentConversation,
    pause,
    setSnapshot(next: TelegramConnectionSnapshot) {
      current = next;
    },
  };
}

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
});

afterEach(() => {
  setLocale(localeBeforeTest);
});

describe("TelegramConnectionContent", () => {
  it("offers no way to connect when this machine cannot store the token", async () => {
    const { api, connect } = makeApi(snapshotOf({ state: "unsupported" }));
    render(<TelegramConnectionContent api={api} />);

    expect(await screen.findByTestId("telegram-connection-state")).toHaveTextContent(
      "Not available on this machine",
    );
    expect(screen.queryByTestId("telegram-connection-connect")).toBeNull();
    expect(screen.queryByTestId("telegram-connection-bot-token")).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it("is read-only when the launch environment owns the bridge", async () => {
    const { api } = makeApi(snapshotOf({ state: "env-managed", botUsername: "my_assistant_bot" }));
    render(<TelegramConnectionContent api={api} />);

    await screen.findByTestId("telegram-connection-state");
    expect(screen.queryByTestId("telegram-connection-connect")).toBeNull();
    expect(screen.queryByTestId("telegram-connection-create-pairing-code")).toBeNull();
    expect(screen.queryByTestId("telegram-connection-approve")).toBeNull();
  });

  it("discloses the continuous connection before the token is submitted", async () => {
    const { api, connect } = makeApi(snapshotOf());
    render(<TelegramConnectionContent api={api} />);

    fireEvent.click(await screen.findByTestId("telegram-connection-connect"));
    const form = await screen.findByTestId("telegram-connection-connect-form");
    expect(form).toHaveTextContent("keeps a connection open to Telegram");
    expect(form).toHaveTextContent("discarded, not replayed");
    expect(connect).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("telegram-connection-bot-token"), {
      target: { value: BOT_TOKEN },
    });
    fireEvent.click(screen.getByTestId("telegram-connection-submit-token"));

    await waitFor(() => expect(connect).toHaveBeenCalledWith(BOT_TOKEN));
    // The field is the only renderer home of the token and must not retain it.
    await waitFor(() => {
      expect(screen.queryByTestId("telegram-connection-bot-token")).toBeNull();
    });
  });

  it("masks the bot token field so it is never rendered as readable text", async () => {
    const { api } = makeApi(snapshotOf());
    render(<TelegramConnectionContent api={api} />);
    fireEvent.click(await screen.findByTestId("telegram-connection-connect"));

    expect(await screen.findByTestId("telegram-connection-bot-token")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("shows a minted pairing code once and drops it when it is no longer pending", async () => {
    const harness = makeApi(snapshotOf({ state: "connected-unpaired", botUsername: "my_assistant_bot" }));
    render(<TelegramConnectionContent api={harness.api} />);

    expect(screen.queryByTestId("telegram-connection-issued-code")).toBeNull();
    harness.setSnapshot(snapshotOf({
      state: "pairing-pending",
      botUsername: "my_assistant_bot",
      pendingCode: { id: CODE_ID, expiresAt: 1_800_000_000_000, attemptsRemaining: 5 },
    }));
    fireEvent.click(await screen.findByTestId("telegram-connection-create-pairing-code"));

    expect(await screen.findByTestId("telegram-connection-pairing-code")).toHaveTextContent(RAW_CODE);

    // Once main reports the code redeemed or replaced, the renderer copy goes.
    harness.setSnapshot(snapshotOf({
      state: "paired-unapproved",
      botUsername: "my_assistant_bot",
      pairing: { id: PAIRING_ID, accountFingerprint: "abc123def456" },
    }));
    fireEvent.click(screen.getByTestId("telegram-connection-refresh"));
    await waitFor(() => {
      expect(screen.queryByTestId("telegram-connection-pairing-code")).toBeNull();
    });
  });

  it("keeps pairing and sharing as separate owner actions", async () => {
    const harness = makeApi(snapshotOf({
      state: "paired-unapproved",
      botUsername: "my_assistant_bot",
      pairing: { id: PAIRING_ID, accountFingerprint: "abc123def456" },
    }));
    render(<TelegramConnectionContent api={harness.api} />);

    // Paired but nothing shared: the pairing summary is visible and the share
    // action is a separate, still-unclicked control.
    expect(await screen.findByTestId("telegram-connection-pairing")).toHaveTextContent("abc123def456");
    expect(harness.approveCurrentConversation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("telegram-connection-approve"));
    await waitFor(() => expect(harness.approveCurrentConversation).toHaveBeenCalledWith("8h"));
  });

  it("says the share survives while its conversation is closed", async () => {
    const { api } = makeApi(snapshotOf({
      state: "active",
      botUsername: "my_assistant_bot",
      pairing: { id: PAIRING_ID, accountFingerprint: "abc123def456" },
      approval: {
        id: APPROVAL_ID,
        expiresAt: 1_800_000_000_000,
        matchesCurrentConversation: false,
      },
    }));
    render(<TelegramConnectionContent api={api} />);

    const content = await screen.findByTestId("telegram-connection-content");
    expect(await screen.findByTestId("telegram-connection-shared-conversation-closed"))
      .toHaveTextContent("stays shared, including after a restart");
    // Named as a share that is not running, never as a lost or paused one.
    expect(screen.getByTestId("telegram-connection-state"))
      .toHaveTextContent("that conversation is not open");
    // Nothing invites the owner to "start" a conversation that cannot run.
    expect(content).not.toHaveTextContent("Send a message from Telegram to start");
    // The owner can share the conversation they now have open instead.
    expect(screen.getByTestId("telegram-connection-approve")).toBeTruthy();
  });

  it("offers no re-share while the shared conversation is the open one", async () => {
    const { api } = makeApi(snapshotOf({
      state: "active",
      botUsername: "my_assistant_bot",
      pairing: { id: PAIRING_ID, accountFingerprint: "abc123def456" },
      approval: {
        id: APPROVAL_ID,
        expiresAt: 1_800_000_000_000,
        matchesCurrentConversation: true,
      },
    }));
    render(<TelegramConnectionContent api={api} />);

    expect(await screen.findByTestId("telegram-connection-state"))
      .toHaveTextContent("Sharing this conversation");
    expect(screen.queryByTestId("telegram-connection-shared-conversation-closed")).toBeNull();
    expect(screen.queryByTestId("telegram-connection-approve")).toBeNull();
  });

  it("states what pausing and disconnecting cannot undo", async () => {
    const { api } = makeApi(snapshotOf({
      state: "active",
      botUsername: "my_assistant_bot",
      pairing: { id: PAIRING_ID, accountFingerprint: "abc123def456" },
      approval: {
        id: APPROVAL_ID,
        expiresAt: 1_800_000_000_000,
        matchesCurrentConversation: true,
      },
    }));
    render(<TelegramConnectionContent api={api} />);

    const content = await screen.findByTestId("telegram-connection-content");
    expect(content).toHaveTextContent("cannot be recalled");
    expect(content).toHaveTextContent("does not change anything on Telegram's side");
    expect(content).toHaveTextContent("Tool approvals stay on this desktop");
  });

  it("surfaces a provider conflict as a localized message, not a raw code", async () => {
    const { api } = makeApi(snapshotOf({ state: "error", lastErrorCode: "telegram-poll-conflict" }));
    render(<TelegramConnectionContent api={api} />);

    const error = await screen.findByTestId("telegram-connection-last-error");
    expect(error).toHaveTextContent("Another app or machine is already receiving");
    expect(error).not.toHaveTextContent("telegram-poll-conflict");
  });
});
