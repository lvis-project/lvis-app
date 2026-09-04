import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type {
  TailnetGuidedSetupResult,
  TailnetObserverConfigView,
  TailnetObserverSnapshot,
  TailscaleEnvironmentView,
} from "../../../../shared/tailnet-observer-config.js";
import type { LvisApi } from "../../types.js";
import { TailnetSetupWizard } from "../TailnetSetupWizard.js";

const DNS_NAME = "desk.example-tailnet.ts.net";
const WEB_ORIGIN = "https://" + DNS_NAME;

const OFF: TailnetObserverConfigView = {
  enabled: false,
  authorization: { kind: "tailnet-identity" },
  port: 46_173,
  controllerEnabled: false,
  pairedSharingEnabled: false,
  webEnabled: false,
  webOrigin: "",
};

const ON: TailnetObserverConfigView = {
  ...OFF,
  enabled: true,
  pairedSharingEnabled: true,
  webEnabled: true,
  webOrigin: WEB_ORIGIN,
};

const READY_ENVIRONMENT: TailscaleEnvironmentView = {
  state: "ready",
  login: "owner@example.com",
  dnsName: DNS_NAME,
  tailnetName: "example-tailnet.ts.net",
  serveConfigured: false,
  serveTargetPort: null,
  detail: null,
};

function snapshotOf(overrides: Partial<TailnetObserverSnapshot> = {}): TailnetObserverSnapshot {
  return {
    saved: OFF,
    effective: OFF,
    provenance: {
      enabled: "unset",
      authorization: "unset",
      port: "unset",
      controllerEnabled: "unset",
      pairedSharingEnabled: "unset",
      webEnabled: "unset",
      webOrigin: "unset",
    },
    listeningPort: null,
    lastStartError: null,
    pairedSharingBootstrapFailed: false,
    environment: READY_ENVIRONMENT,
    derivedWebOrigin: WEB_ORIGIN,
    serveCommand: null,
    configFileError: null,
    ...overrides,
  };
}

/** The snapshot a finished setup produces: enabled, and actually bound. */
function configuredSnapshot(overrides: Partial<TailnetObserverSnapshot> = {}): TailnetObserverSnapshot {
  return snapshotOf({
    saved: ON,
    effective: ON,
    listeningPort: 46_173,
    serveCommand: "tailscale serve --bg --https=443 http://127.0.0.1:46173",
    environment: { ...READY_ENVIRONMENT, serveConfigured: true, serveTargetPort: 46_173 },
    ...overrides,
  });
}

function makeApi(options: {
  snapshots?: TailnetObserverSnapshot[];
  snapshot?: TailnetObserverSnapshot;
  guidedSetup?: TailnetGuidedSetupResult;
} = {}) {
  const queue = options.snapshots ? [...options.snapshots] : null;
  const snapshot = vi.fn(async () => ({
    ok: true as const,
    // A queue that has run out keeps answering with its last entry: the
    // component re-reads freely, and a test should pin what changes, not how
    // many reads happen to occur.
    snapshot: queue === null
      ? options.snapshot ?? snapshotOf()
      : (queue.length > 1 ? queue.shift()! : queue[0]!),
  }));
  const guidedSetup = vi.fn(async () => options.guidedSetup ?? ({
    ok: true as const,
    snapshot: configuredSnapshot(),
    webOrigin: WEB_ORIGIN,
    port: 46_173,
    serve: "configured" as const,
  }));
  const apply = vi.fn(async () => ({ ok: true as const }));
  const configureServe = vi.fn(async () => ({ ok: true as const, url: WEB_ORIGIN + "/" }));
  const api = {
    tailnetObserver: { snapshot, apply, configureServe, guidedSetup },
  } as unknown as LvisApi;
  return { api, snapshot, guidedSetup, apply };
}

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
});

afterEach(() => {
  setLocale(localeBeforeTest);
});

describe("TailnetSetupWizard", () => {
  it("opens on the environment step and reports what Tailscale said", async () => {
    const { api, snapshot } = makeApi();
    render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

    expect(await screen.findByTestId("tailnet-setup-step-environment")).toHaveTextContent(
      "Tailscale is running as owner@example.com",
    );
    expect(snapshot).toHaveBeenCalled();
    expect(screen.getByTestId("tailnet-setup-step-indicator")).toHaveTextContent("Step 1 of 4");
  });

  it.each([
    ["logged-out", "not signed in"],
    ["stopped", "not running"],
    ["cli-not-found", "not installed"],
    ["cli-failed", "did not report its status"],
  ] as const)("blocks Next and keeps the guidance for %s", async (state, sentence) => {
    const { api } = makeApi({
      snapshot: snapshotOf({ environment: { ...READY_ENVIRONMENT, state } }),
    });
    render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

    expect(await screen.findByTestId("tailnet-setup-environment")).toHaveTextContent(sentence);
    expect(screen.getByTestId("tailnet-setup-next")).toBeDisabled();
    expect(screen.getByTestId("tailnet-setup-recheck")).toBeEnabled();
  });

  it("re-reads the environment when asked to check again", async () => {
    const { api, snapshot } = makeApi({
      snapshots: [
        snapshotOf({ environment: { ...READY_ENVIRONMENT, state: "stopped" } }),
        snapshotOf(),
      ],
    });
    render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

    expect(await screen.findByTestId("tailnet-setup-next")).toBeDisabled();
    fireEvent.click(screen.getByTestId("tailnet-setup-recheck"));

    await waitFor(() => expect(screen.getByTestId("tailnet-setup-next")).toBeEnabled());
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("runs the whole setup from one press and ends on the address", async () => {
    const { api, guidedSetup } = makeApi();
    render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    // Automatic is the default choice, so the next press is the last one.
    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-apply"));

    await waitFor(() => expect(guidedSetup).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("tailnet-setup-done-url")).toHaveTextContent(WEB_ORIGIN);
    expect(screen.getByTestId("tailnet-setup-step-done")).toHaveTextContent(
      "signed in to the same Tailscale account",
    );
  });

  it("hands the invitation code back to the control that already mints one", async () => {
    const onCreateInvitation = vi.fn();
    const { api } = makeApi();
    render(<TailnetSetupWizard api={api} onCreateInvitation={onCreateInvitation} />);

    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-apply"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-create-invitation"));

    expect(onCreateInvitation).toHaveBeenCalledTimes(1);
  });

  it("shows the full listener form when the manual method is chosen", async () => {
    const { api, guidedSetup } = makeApi();
    render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-mode-manual"));
    fireEvent.click(screen.getByTestId("tailnet-setup-next"));

    expect(await screen.findByTestId("tailnet-observer-apply")).toBeInTheDocument();
    expect(screen.getByTestId("tailnet-setup-step-indicator")).toHaveTextContent("Step 3 of 3");
    expect(guidedSetup).not.toHaveBeenCalled();
  });

  it("goes back to the environment step when Tailscale stopped being usable", async () => {
    const { api } = makeApi({
      guidedSetup: { ok: false, error: "tailnet-guided-setup-not-ready" },
    });
    render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-apply"));

    expect(await screen.findByTestId("tailnet-setup-step-environment")).toBeInTheDocument();
  });

  it("offers the manual form rather than a dead end when no port can be opened", async () => {
    const { api } = makeApi({
      guidedSetup: { ok: false, error: "tailnet-guided-setup-port-unavailable" },
    });
    render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-apply"));

    expect(await screen.findByTestId("tailnet-setup-error")).toHaveTextContent(
      "No local port could be opened",
    );
    fireEvent.click(screen.getByTestId("tailnet-setup-apply-manual"));
    expect(await screen.findByTestId("tailnet-observer-apply")).toBeInTheDocument();
  });

  it("renders the host's own sentence for any other refusal", async () => {
    const { api } = makeApi({
      guidedSetup: { ok: false, error: "tailnet-web-origin-underivable" },
    });
    render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-next"));
    fireEvent.click(await screen.findByTestId("tailnet-setup-apply"));

    expect(await screen.findByTestId("tailnet-setup-error")).toHaveTextContent(
      "needs a MagicDNS name for this computer",
    );
  });

  describe("once setup is finished", () => {
    it("shows the facts as a status card instead of the wizard", async () => {
      const { api } = makeApi({ snapshot: configuredSnapshot() });
      render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

      const status = await screen.findByTestId("tailnet-setup-status");
      expect(status).toHaveTextContent("Tailscale is running as owner@example.com");
      expect(screen.getByTestId("tailnet-setup-status-url")).toHaveTextContent(WEB_ORIGIN);
      expect(screen.getByTestId("tailnet-setup-status-serve")).toHaveTextContent(
        "Serve forwards your tailnet to this listener",
      );
      expect(screen.queryByTestId("tailnet-setup-wizard")).toBeNull();
    });

    it("says a port nobody named was chosen for them", async () => {
      const { api } = makeApi({ snapshot: configuredSnapshot() });
      render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

      expect(await screen.findByTestId("tailnet-setup-status-port")).toHaveTextContent(
        "46173 (chosen automatically)",
      );
    });

    it("shows a hand-set port plainly", async () => {
      const { api } = makeApi({
        snapshot: configuredSnapshot({
          provenance: { ...configuredSnapshot().provenance, port: "file" },
          listeningPort: 46_500,
        }),
      });
      render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

      const port = await screen.findByTestId("tailnet-setup-status-port");
      expect(port).toHaveTextContent("46500");
      expect(port).not.toHaveTextContent("chosen automatically");
    });

    it("re-runs the same one-press setup from the status card", async () => {
      const { api, guidedSetup } = makeApi({ snapshot: configuredSnapshot() });
      render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-reconfigure"));

      await waitFor(() => expect(guidedSetup).toHaveBeenCalledTimes(1));
      expect(await screen.findByTestId("tailnet-setup-done-url")).toHaveTextContent(WEB_ORIGIN);
    });

    it("keeps the full form behind an explicit request for it", async () => {
      const { api } = makeApi({ snapshot: configuredSnapshot() });
      render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

      const toggle = await screen.findByTestId("tailnet-setup-manual-toggle");
      expect(screen.queryByTestId("tailnet-observer-apply")).toBeNull();

      fireEvent.click(toggle);
      expect(await screen.findByTestId("tailnet-observer-apply")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("tailnet-setup-manual-toggle"));
      await waitFor(() => expect(screen.queryByTestId("tailnet-observer-apply")).toBeNull());
    });
  });

  describe("keyboard", () => {
    it("advances on Enter only where Next is enabled", async () => {
      const { api } = makeApi({
        snapshot: snapshotOf({ environment: { ...READY_ENVIRONMENT, state: "stopped" } }),
      });
      render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

      const wizard = await screen.findByTestId("tailnet-setup-wizard");
      fireEvent.keyDown(wizard, { key: "Enter" });

      expect(screen.getByTestId("tailnet-setup-step-environment")).toBeInTheDocument();
      expect(screen.queryByTestId("tailnet-setup-step-mode")).toBeNull();
    });

    it("advances on Enter when Next is enabled", async () => {
      const { api } = makeApi();
      render(<TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />);

      const wizard = await screen.findByTestId("tailnet-setup-wizard");
      fireEvent.keyDown(wizard, { key: "Enter" });

      expect(await screen.findByTestId("tailnet-setup-step-mode")).toBeInTheDocument();
    });
  });

  // Every step is settings-pane content, not an overlay. A wizard that opened a
  // window-modal dialog would freeze the rest of settings for a decision about
  // one listener, which is the shape this deliberately does not take.
  it("draws every step in the settings flow, never in an overlay", async () => {
    const { api } = makeApi();
    const { container } = render(
      <TailnetSetupWizard api={api} onCreateInvitation={() => undefined} />,
    );

    const stages = ["tailnet-setup-step-environment", "tailnet-setup-step-mode"];
    for (const stage of stages) {
      const node = await screen.findByTestId(stage);
      expect(container.contains(node)).toBe(true);
      expect(node.closest("[data-settings-section='remote-tailnet-observer']")).not.toBeNull();
      expect(document.querySelector("[role='dialog']")).toBeNull();
      expect(document.querySelector("[role='alertdialog']")).toBeNull();
      if (stage === "tailnet-setup-step-environment") {
        fireEvent.click(screen.getByTestId("tailnet-setup-next"));
      }
    }

    fireEvent.click(screen.getByTestId("tailnet-setup-next"));
    const apply = await screen.findByTestId("tailnet-setup-step-apply");
    expect(container.contains(apply)).toBe(true);
    fireEvent.click(screen.getByTestId("tailnet-setup-apply"));

    const done = await screen.findByTestId("tailnet-setup-step-done");
    expect(container.contains(done)).toBe(true);
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });
});
