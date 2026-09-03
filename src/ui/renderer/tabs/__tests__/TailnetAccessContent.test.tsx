import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type { TailnetSharingSnapshot } from "../../../../shared/tailnet-sharing.js";
import type { LvisApi } from "../../types.js";
import { TailnetAccessContent } from "../TailnetAccessContent.js";

const PAIRING_ID = "11111111-1111-4111-8111-111111111111";
const INVITATION_ID = "22222222-2222-4222-8222-222222222222";

const SAFE_SNAPSHOT: TailnetSharingSnapshot = {
  invitations: [{ id: INVITATION_ID, expiresAt: 1_800_000_000_000 }],
  pairings: [{
    id: PAIRING_ID,
    actorFingerprint: "a1b2c3d4e5f6",
    state: "active",
    expiresAt: null,
  }],
  shares: [],
};

function makeApi() {
  const snapshot = vi.fn(async () => ({ ok: true as const, snapshot: SAFE_SNAPSHOT }));
  const createInvitation = vi.fn(async () => ({
    ok: true as const,
    invitation: {
      id: INVITATION_ID,
      code: `lvis-pair-v1.${"A".repeat(43)}`,
      expiresAt: 1_800_000_000_000,
    },
  }));
  const createCurrentConversationShare = vi.fn(async () => ({ ok: true as const }));
  const api = {
    tailnetSharing: {
      snapshot,
      createInvitation,
      activatePairing: vi.fn(async () => ({ ok: true as const })),
      createCurrentConversationShare,
      revokeShare: vi.fn(async () => ({ ok: true as const })),
      revokePairing: vi.fn(async () => ({ ok: true as const })),
      onChanged: vi.fn(() => () => undefined),
    },
  } as unknown as LvisApi;

  return { api, createInvitation, createCurrentConversationShare };
}

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
});

afterEach(() => {
  setLocale(localeBeforeTest);
});

describe("TailnetAccessContent", () => {
  it("shows a raw invitation code only after the local owner creates it", async () => {
    const { api, createInvitation } = makeApi();
    render(<TailnetAccessContent api={api} />);

    const create = await screen.findByTestId("tailnet-access-create-invitation");
    expect(screen.queryByTestId("tailnet-access-invitation-code")).toBeNull();

    fireEvent.click(create);

    await waitFor(() => expect(createInvitation).toHaveBeenCalledWith("10m"));
    expect(await screen.findByTestId("tailnet-access-issued-invitation")).toHaveTextContent(
      `lvis-pair-v1.${"A".repeat(43)}`,
    );
  });

  it("shares only the current conversation through the selected active pairing", async () => {
    const { api, createCurrentConversationShare } = makeApi();
    render(<TailnetAccessContent api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Share current conversation" }));

    await waitFor(() => {
      expect(createCurrentConversationShare).toHaveBeenCalledWith(PAIRING_ID, "observe", "8h");
    });
  });

  // Handing over control is the one grant here that revoking cannot take back —
  // whatever the other side drove has already run — so it is asked twice. The
  // question is drawn in the row rather than by a window-modal browser dialog
  // that would freeze the whole app for one pairing.
  it("asks again in the row before granting control, and grants on confirm", async () => {
    const { api, createCurrentConversationShare } = makeApi();
    render(<TailnetAccessContent api={api} />);

    fireEvent.change(await screen.findByTestId("tailnet-access-share-permission"), {
      target: { value: "control" },
    });
    fireEvent.click(screen.getByTestId("tailnet-access-create-share"));

    expect(await screen.findByTestId("tailnet-access-control-confirm")).toHaveTextContent(
      "Allow this paired account to send messages",
    );
    expect(createCurrentConversationShare).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("tailnet-access-control-confirm-accept"));

    await waitFor(() => {
      expect(createCurrentConversationShare).toHaveBeenCalledWith(PAIRING_ID, "control", "8h");
    });
  });

  it("cancelling the control question grants nothing", async () => {
    const { api, createCurrentConversationShare } = makeApi();
    render(<TailnetAccessContent api={api} />);

    fireEvent.change(await screen.findByTestId("tailnet-access-share-permission"), {
      target: { value: "control" },
    });
    fireEvent.click(screen.getByTestId("tailnet-access-create-share"));
    fireEvent.click(await screen.findByTestId("tailnet-access-control-confirm-cancel"));

    expect(screen.queryByTestId("tailnet-access-control-confirm")).toBeNull();
    expect(createCurrentConversationShare).not.toHaveBeenCalled();
  });
});
