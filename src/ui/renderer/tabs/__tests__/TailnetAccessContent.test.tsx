import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
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

const OBSERVER_OFF = {
  enabled: false,
  authorization: { kind: "tailnet-identity" as const },
  port: 46_173,
  controllerEnabled: false,
  pairedSharingEnabled: false,
  webEnabled: false,
  webOrigin: "",
};

const OBSERVER_DNS_NAME = "desk.example-tailnet.ts.net";

/** A never-configured observer on a signed-in node — the setup flow's entry state. */
function observerSnapshot() {
  return {
    saved: OBSERVER_OFF,
    effective: OBSERVER_OFF,
    provenance: {
      enabled: "unset" as const,
      authorization: "unset" as const,
      port: "unset" as const,
      controllerEnabled: "unset" as const,
      pairedSharingEnabled: "unset" as const,
      webEnabled: "unset" as const,
      webOrigin: "unset" as const,
    },
    listeningPort: null,
    lastStartError: null,
    pairedSharingBootstrapFailed: false,
    ownDeviceAdmission: false,
    environment: {
      state: "ready" as const,
      login: "owner@example.com",
      dnsName: OBSERVER_DNS_NAME,
      tailnetName: "example-tailnet.ts.net",
      serveConfigured: false,
      serveTargetPort: null,
      detail: null,
    },
    derivedWebOrigin: "https://" + OBSERVER_DNS_NAME,
    serveCommand: null,
    configFileError: null,
  };
}

function makeApi(options: { observerUnavailable?: boolean; sharingDisabled?: boolean } = {}) {
  const snapshot = vi.fn(async () =>
    options.sharingDisabled === true
      ? { ok: false as const, error: "tailnet-sharing-disabled" as const }
      : { ok: true as const, snapshot: SAFE_SNAPSHOT },
  );
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
    // The bridge is always there — the preload exposes it unconditionally. What
    // varies is whether the host can answer, which is what the reader sees.
    tailnetObserver: {
      snapshot: vi.fn(async () =>
        options.observerUnavailable === true
          ? { ok: false as const, error: "tailnet-observer-unavailable" as const }
          : { ok: true as const, snapshot: observerSnapshot() },
      ),
      apply: vi.fn(async () => ({ ok: true as const })),
      configureServe: vi.fn(async () => ({
        ok: true as const,
        url: "https://" + OBSERVER_DNS_NAME + "/",
      })),
      guidedSetup: vi.fn(async () => ({
        ok: true as const,
        snapshot: observerSnapshot(),
        webOrigin: "https://" + OBSERVER_DNS_NAME,
        port: 46_173,
        serve: "configured" as const,
      })),
    },
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
  // This content is rendered INSIDE a `ConnectionRow` whose label is
  // `remoteSurfacesTab.tailnetSectionTitle`. A section heading equal to that
  // label names nothing the reader did not already have, one line above it —
  // and both the unavailable state and the setup card used to render exactly
  // that string.
  it("gives no section inside the row the row's own label as its heading", async () => {
    expect(t("tailnetSetup.sectionTitle")).not.toBe(t("remoteSurfacesTab.tailnetSectionTitle"));
    expect(t("tailnetAccessTab.disabledTitle")).not.toBe(t("remoteSurfacesTab.tailnetSectionTitle"));

    const { api } = makeApi({ sharingDisabled: true });
    render(<TailnetAccessContent api={api} />);

    // The unavailable state names itself, and the setup card names the step it
    // performs — neither restates the row.
    await screen.findByText(t("tailnetAccessTab.disabledTitle"));
    expect(screen.getByText(t("tailnetSetup.sectionTitle"))).toBeTruthy();
    expect(screen.queryByText(t("remoteSurfacesTab.tailnetSectionTitle"))).toBeNull();
  });

  // The setup flow owns the observer anchor now: the full listener form is
  // reachable only through it, so a deep link to the section has to land on the
  // thing a reader can actually act on.
  it("puts the guided setup surface at the observer anchor", async () => {
    const { api } = makeApi({ observerUnavailable: true });
    const { container } = render(<TailnetAccessContent api={api} />);

    await screen.findByTestId("tailnet-access-create-invitation");
    const anchor = container.querySelector("[data-settings-section='remote-tailnet-observer']");
    expect(anchor).not.toBeNull();
    // The host could not answer for the observer. The section says so in one
    // sentence at the anchor rather than taking the tab down with it.
    expect(await screen.findByTestId("tailnet-setup-error")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-settings-section='remote-tailnet-observer']"))
      .toHaveLength(1);
  });

  // The finished panel ends with "now let someone in", and the one-use code
  // that does it already has a home below. Focus moves there rather than a
  // second minting control appearing inside the flow.
  it("moves the reader to the invitation control when setup asks for a code", async () => {
    const { api } = makeApi();
    render(<TailnetAccessContent api={api} />);

    const create = await screen.findByTestId("tailnet-access-create-invitation");
    create.scrollIntoView = vi.fn();

    fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-create-invitation"));

    expect(create).toHaveFocus();
  });

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
