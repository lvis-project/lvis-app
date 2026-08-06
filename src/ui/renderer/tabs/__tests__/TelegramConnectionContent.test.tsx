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
  const resume = vi.fn(async () => ({ ok: true as const }));
  const api = {
    telegramConnection: {
      snapshot,
      connect,
      disconnect: vi.fn(async () => ({ ok: true as const })),
      pause,
      resume,
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
    resume,
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

  it("stops claiming a paired account once this machine can no longer recognize it", async () => {
    // Positive control first: the reading the owner had before the rotation.
    const paired = makeApi(snapshotOf({
      state: "active",
      botUsername: "my_assistant_bot",
      pairing: { id: PAIRING_ID, accountFingerprint: "abc123def456" },
      approval: { id: APPROVAL_ID, expiresAt: 1_800_000_000_000, matchesCurrentConversation: true },
    }));
    const first = render(<TelegramConnectionContent api={paired.api} />);
    expect(await screen.findByTestId("telegram-connection-pairing")).toHaveTextContent("abc123def456");
    expect(screen.queryByTestId("telegram-connection-pairing-unrecognized")).toBeNull();
    first.unmount();

    const harness = makeApi(snapshotOf({
      state: "pairing-unrecognized",
      botUsername: "my_assistant_bot",
    }));
    render(<TelegramConnectionContent api={harness.api} />);

    // No fingerprint, an explanation, and the one repair that works.
    expect(await screen.findByTestId("telegram-connection-pairing-unrecognized")).toBeInTheDocument();
    expect(screen.queryByTestId("telegram-connection-pairing")).toBeNull();
    expect(screen.getByTestId("telegram-connection-state")).not.toHaveTextContent("abc123def456");
    fireEvent.click(screen.getByTestId("telegram-connection-create-pairing-code"));
    await waitFor(() => expect(harness.createPairingCode).toHaveBeenCalled());
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

  it("says the shared conversation is gone rather than telling the owner to reopen it", async () => {
    const { api } = makeApi(snapshotOf({
      state: "shared-conversation-missing",
      botUsername: "my_assistant_bot",
      pairing: { id: PAIRING_ID, accountFingerprint: "abc123def456" },
      approval: {
        id: APPROVAL_ID,
        expiresAt: 1_800_000_000_000,
        // Identical to the closed-conversation snapshot above. Only the state
        // differs, which is the whole point: the surface must not read this
        // flag and guess.
        matchesCurrentConversation: false,
      },
    }));
    render(<TelegramConnectionContent api={api} />);

    expect(await screen.findByTestId("telegram-connection-shared-conversation-missing"))
      .toHaveTextContent("has been deleted");
    expect(screen.getByTestId("telegram-connection-state"))
      .toHaveTextContent("no longer exists");
    // The "it stays shared, reopen it" advice belongs to the other reading and
    // would send the owner looking for something that is gone.
    expect(screen.queryByTestId("telegram-connection-shared-conversation-closed")).toBeNull();
    // Naming a problem without offering the repair would be worse than silence.
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

  it("offers a retry from a connection problem rather than only a disconnect", async () => {
    // A failed activation now keeps the pairing and reports the failure, so the
    // one control this state used to offer was Disconnect — which spends the
    // pairing the failure deliberately preserved.
    const { api, resume, pause } = makeApi(snapshotOf({
      state: "error",
      botUsername: "my_assistant_bot",
      pairing: { id: PAIRING_ID, accountFingerprint: "abc123def456" },
      lastErrorCode: "telegram-connection-unavailable",
    }));
    render(<TelegramConnectionContent api={api} />);

    const retry = await screen.findByTestId("telegram-connection-retry");
    expect(retry).toHaveTextContent("Try again");
    // Pausing a bridge that is already not receiving says nothing.
    expect(screen.queryByTestId("telegram-connection-pause")).toBeNull();

    fireEvent.click(retry);
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(pause).not.toHaveBeenCalled();
  });

  it("offers the pause control while the connection is healthy", async () => {
    // The control for the case above: same block, same buttons, and only the
    // state differs.
    const { api, resume } = makeApi(snapshotOf({
      state: "paired-unapproved",
      botUsername: "my_assistant_bot",
      pairing: { id: PAIRING_ID, accountFingerprint: "abc123def456" },
    }));
    render(<TelegramConnectionContent api={api} />);

    expect(await screen.findByTestId("telegram-connection-pause")).toBeTruthy();
    expect(screen.queryByTestId("telegram-connection-retry")).toBeNull();
    expect(resume).not.toHaveBeenCalled();
  });
});
