/**
 * The 원격 연결 tab, as one list of connection rows.
 *
 * Three readings are asserted, because they are the three ways the
 * re-composition could quietly lose something a reader depends on: every
 * vendor is on the page exactly once (a duplicate row means a surface got
 * rendered by two owners), a row opens onto the controls that vendor already
 * had (a collapsed row that opens onto nothing is a capability deleted), and a
 * deep link into a section that now lives inside a collapsed row still lands on
 * it (arrival looks the anchor up in the DOM, and a folded row has no anchor).
 */
// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MarketplaceInstalledMessagingConnection } from "../../../../shared/marketplace-package-assets.js";
import type { LvisApi } from "../../types.js";
import { RemoteSurfacesTab } from "../RemoteSurfacesTab.js";

// The local-API gates read the window-scoped client rather than the `api` this
// tab threads down, so the row that opens onto them needs it stood up too.
vi.mock("../../api-client.js", () => ({
  getApi: () => ({
    getSettings: async () => ({ system: {}, features: {} }),
    updateSettings: async () => ({}),
    envForcedSettings: async () => [],
  }),
}));

const TELEGRAM: MarketplaceInstalledMessagingConnection = {
  connectionId: "telegram",
  label: "Telegram",
  summary: "Reach one LVIS conversation from Telegram.",
  pairing: "one-time-code",
  credentials: [{ key: "botToken", label: "Bot token", secret: true }],
  egress: ["api.telegram.org"],
  docsUrl: "https://core.telegram.org/bots/api",
};

const OBSERVER_CONFIG = {
  enabled: false,
  authorization: { kind: "tailnet-identity" as const },
  port: 46_173,
  controllerEnabled: false,
  pairedSharingEnabled: false,
  webEnabled: false,
  webOrigin: "",
};

const UNSET = {
  enabled: "unset" as const,
  authorization: "unset" as const,
  port: "unset" as const,
  controllerEnabled: "unset" as const,
  pairedSharingEnabled: "unset" as const,
  webEnabled: "unset" as const,
  webOrigin: "unset" as const,
};

const DNS_NAME = "desk.example-tailnet.ts.net";

function observerSnapshot() {
  return {
    saved: OBSERVER_CONFIG,
    effective: OBSERVER_CONFIG,
    provenance: UNSET,
    listeningPort: null,
    lastStartError: null,
    pairedSharingBootstrapFailed: false,
    ownDeviceAdmission: false,
    environment: {
      state: "ready" as const,
      login: "owner@example.com",
      dnsName: DNS_NAME,
      tailnetName: "example-tailnet.ts.net",
      serveConfigured: false,
      serveTargetPort: null,
      detail: null,
    },
    derivedWebOrigin: `https://${DNS_NAME}`,
    serveCommand: null,
    configFileError: null,
  };
}

function makeApi() {
  return {
    getSettings: vi.fn(async () => ({
      marketplace: { installedMessagingConnections: [TELEGRAM] },
      system: {},
      features: {},
    })),
    updateSettings: vi.fn(async () => ({ ok: true })),
    openExternalUrl: vi.fn(async () => undefined),
    tailnetObserver: {
      snapshot: vi.fn(async () => ({ ok: true as const, snapshot: observerSnapshot() })),
      apply: vi.fn(async () => ({ ok: true as const })),
      configureServe: vi.fn(async () => ({ ok: true as const, url: `https://${DNS_NAME}/` })),
      guidedSetup: vi.fn(async () => ({
        ok: true as const,
        snapshot: observerSnapshot(),
        webOrigin: `https://${DNS_NAME}`,
        port: 46_173,
        serve: "configured" as const,
      })),
      setOwnDeviceAdmission: vi.fn(async () => ({ ok: true as const })),
    },
    tailnetSharing: {
      snapshot: vi.fn(async () => ({
        ok: true as const,
        snapshot: { invitations: [], pairings: [], shares: [] },
      })),
      createInvitation: vi.fn(async () => ({ ok: false as const, error: "unauthorized" as const })),
      activatePairing: vi.fn(async () => ({ ok: true as const })),
      createCurrentConversationShare: vi.fn(async () => ({ ok: true as const })),
      revokeShare: vi.fn(async () => ({ ok: true as const })),
      revokePairing: vi.fn(async () => ({ ok: true as const })),
      onChanged: vi.fn(() => () => undefined),
    },
    telegramConnection: {
      snapshot: vi.fn(async () => ({
        ok: true as const,
        snapshot: {
          state: "disconnected" as const,
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
}

describe("RemoteSurfacesTab", () => {
  it("puts every connection vendor on the page as exactly one row", async () => {
    const api = makeApi();
    const { container } = render(<RemoteSurfacesTab api={api} chatGroupId="main" />);

    await screen.findByTestId("messaging-connection:telegram");
    const rows = [...container.querySelectorAll("[data-connection-row]")]
      .map((row) => row.getAttribute("data-connection-row"));
    expect(rows).toEqual([
      "connection:tailnet",
      "messaging-connection:telegram",
      "connection:local-api",
    ]);
  });

  it("keeps every row's detail folded away until it is opened", async () => {
    const api = makeApi();
    render(<RemoteSurfacesTab api={api} chatGroupId="main" />);

    await screen.findByTestId("messaging-connection:telegram");
    expect(screen.queryByTestId("connection:tailnet:detail")).toBeNull();
    expect(screen.queryByTestId("connection:local-api:detail")).toBeNull();
    expect(screen.queryByTestId("messaging-connection:telegram:detail")).toBeNull();
  });

  it("opens a row onto the controls that vendor already had", async () => {
    const api = makeApi();
    render(<RemoteSurfacesTab api={api} chatGroupId="main" />);

    fireEvent.click(await screen.findByTestId("connection:local-api:toggle"));
    expect(await screen.findByTestId("local-api-surfaces-local-api")).toBeTruthy();
    expect(screen.getByTestId("local-api-surfaces-a2a-remote-receiver")).toBeTruthy();

    // One row at a time: opening the next one closes the last.
    fireEvent.click(screen.getByTestId("connection:tailnet:toggle"));
    expect(await screen.findByTestId("tailnet-access-content")).toBeTruthy();
    expect(screen.queryByTestId("local-api-surfaces-local-api")).toBeNull();
  });

  it("opens the row that holds the section a deep link named", async () => {
    const api = makeApi();
    // The observer anchor lives inside the Tailnet card, which is inside the
    // Tailnet row — folded, it is not in the DOM for arrival to find.
    const { container } = render(
      <RemoteSurfacesTab api={api} chatGroupId="main" sectionTarget="remote-tailnet-observer" />,
    );

    await waitFor(() => {
      expect(container.querySelector("[data-settings-section='remote-tailnet-observer']"))
        .not.toBeNull();
    });
  });

  it("opens the messaging row a deep link into that connection named", async () => {
    const api = makeApi();
    const { container } = render(
      <RemoteSurfacesTab api={api} chatGroupId="main" sectionTarget="remote-telegram" />,
    );

    await waitFor(() => {
      expect(container.querySelector("[data-settings-section='remote-telegram']"))
        .not.toBeNull();
    });
  });

  it("keeps the messaging group anchor reachable with every row folded", async () => {
    const api = makeApi();
    const { container } = render(<RemoteSurfacesTab api={api} chatGroupId="main" />);

    await screen.findByTestId("messaging-connection:telegram");
    expect(container.querySelector("[data-settings-section='remote-messaging-connections']"))
      .not.toBeNull();
    expect(screen.queryByTestId("messaging-connection:telegram:detail")).toBeNull();
  });

  it("reads a listener that was never set up as setup-needed", async () => {
    const api = makeApi();
    render(<RemoteSurfacesTab api={api} chatGroupId="main" />);

    await waitFor(() => {
      expect(screen.getByTestId("connection:tailnet:state").textContent).toBe("설정 필요");
    });
    expect(screen.getByTestId("connection:tailnet:endpoint").textContent)
      .toBe(`https://${DNS_NAME}`);
  });
});
