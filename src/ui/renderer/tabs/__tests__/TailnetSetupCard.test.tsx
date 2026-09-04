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
import { TailnetSetupCard } from "../TailnetSetupCard.js";

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

describe("TailnetSetupCard", () => {
  describe("when Tailscale is ready and nothing is set up yet", () => {
    // Every value guided setup writes is one the host decides for itself, so
    // there is nothing to ask: the section reads as a provider row does — a
    // state, the probe's facts, one button.
    it("collapses to a card that states the connection is ready", async () => {
      const { api } = makeApi();
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      const card = await screen.findByTestId("tailnet-setup-ready");
      expect(screen.getByTestId("tailnet-setup-ready-state")).toHaveTextContent("Ready to connect");
      expect(screen.getByTestId("tailnet-setup-ready-facts")).toHaveTextContent(
        "Tailscale is running as owner@example.com",
      );
      expect(card).toHaveTextContent(DNS_NAME);
      expect(screen.getByTestId("tailnet-setup-connect")).toBeEnabled();
    });

    it("offers no step counter, because there are no steps left to count", async () => {
      const { api } = makeApi();
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      await screen.findByTestId("tailnet-setup-ready");
      expect(screen.queryByTestId("tailnet-setup-step-indicator")).toBeNull();
      expect(screen.queryByTestId("tailnet-setup-next")).toBeNull();
      expect(screen.queryByTestId("tailnet-setup-back")).toBeNull();
    });

    it("runs the whole setup from the connect press and ends on the address", async () => {
      const { api, guidedSetup } = makeApi();
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));

      await waitFor(() => expect(guidedSetup).toHaveBeenCalledTimes(1));
      expect(guidedSetup).toHaveBeenCalledWith();
      expect(await screen.findByTestId("tailnet-setup-done-url")).toHaveTextContent(WEB_ORIGIN);
      expect(screen.getByTestId("tailnet-setup-done")).toHaveTextContent(
        "signed in to the same Tailscale account",
      );
    });

    it("holds the button disabled and labelled in progress for the whole call", async () => {
      let release = (): void => undefined;
      const inFlight = new Promise<void>((resolve) => { release = () => resolve(); });
      const { api } = makeApi();
      const bridge = (api as unknown as { tailnetObserver: { guidedSetup: unknown } }).tailnetObserver;
      bridge.guidedSetup = vi.fn(async () => {
        await inFlight;
        return {
          ok: true as const,
          snapshot: configuredSnapshot(),
          webOrigin: WEB_ORIGIN,
          port: 46_173,
          serve: "configured" as const,
        };
      });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));

      await waitFor(() => expect(screen.getByTestId("tailnet-setup-connect")).toBeDisabled());
      expect(screen.getByTestId("tailnet-setup-connect")).toHaveTextContent("Connecting…");
      release();
      expect(await screen.findByTestId("tailnet-setup-done")).toBeInTheDocument();
    });

    // Nothing asks the reader to verify the environment before pressing, so the
    // press itself has to be the read: a "ready" that went stale since mount
    // must not be what guided setup runs on.
    it("re-reads the environment before it runs anything", async () => {
      const { api, snapshot, guidedSetup } = makeApi();
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));

      await waitFor(() => expect(guidedSetup).toHaveBeenCalledTimes(1));
      expect(snapshot).toHaveBeenCalledTimes(2);
    });

    it("hands the invitation code back to the control that already mints one", async () => {
      const onCreateInvitation = vi.fn();
      const { api } = makeApi();
      render(<TailnetSetupCard api={api} onCreateInvitation={onCreateInvitation} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));
      fireEvent.click(await screen.findByTestId("tailnet-setup-create-invitation"));

      expect(onCreateInvitation).toHaveBeenCalledTimes(1);
    });

    it("returns to the status card once the finished panel is closed", async () => {
      const { api } = makeApi({ snapshots: [snapshotOf(), configuredSnapshot()] });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));
      fireEvent.click(await screen.findByTestId("tailnet-setup-close"));

      expect(await screen.findByTestId("tailnet-setup-status")).toBeInTheDocument();
    });
  });

  describe("when the connect press is refused", () => {
    it("falls back to the guidance card when Tailscale stopped being usable", async () => {
      const { api } = makeApi({
        snapshots: [snapshotOf(), snapshotOf({ environment: { ...READY_ENVIRONMENT, state: "stopped" } })],
        guidedSetup: { ok: false, error: "tailnet-guided-setup-not-ready", output: null },
      });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));

      expect(await screen.findByTestId("tailnet-setup-not-ready")).toHaveTextContent("not running");
      expect(screen.queryByTestId("tailnet-setup-ready")).toBeNull();
      await waitFor(() => expect(screen.getByTestId("tailnet-setup-connect")).toBeEnabled());
    });

    it("keeps the manual escape hatch beside the sentence when no port can be opened", async () => {
      const { api } = makeApi({
        guidedSetup: { ok: false, error: "tailnet-guided-setup-port-unavailable", output: null },
      });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));

      expect(await screen.findByTestId("tailnet-setup-error")).toHaveTextContent(
        "No local port could be opened",
      );
      fireEvent.click(screen.getByTestId("tailnet-setup-manual-toggle"));
      expect(await screen.findByTestId("tailnet-observer-apply")).toBeInTheDocument();
    });

    // The sentence for a failed Serve says its output is below. Dropping what
    // Tailscale printed leaves that promise with nothing under it, and the
    // certificate case is the one nobody can act on without those words.
    it("shows what Tailscale printed when the Serve step failed", async () => {
      const { api } = makeApi({
        guidedSetup: {
          ok: false,
          error: "tailnet-serve-command-failed",
          output: "HTTPS is not enabled on this tailnet",
        },
      });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));

      expect(await screen.findByTestId("tailnet-setup-error")).toHaveTextContent(
        "did not complete the Serve command",
      );
      expect(screen.getByTestId("tailnet-setup-error-output")).toHaveTextContent(
        "HTTPS is not enabled on this tailnet",
      );
    });

    it("renders the host's own sentence for any other refusal", async () => {
      const { api } = makeApi({
        guidedSetup: { ok: false, error: "tailnet-web-origin-underivable", output: null },
      });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));

      expect(await screen.findByTestId("tailnet-setup-error")).toHaveTextContent(
        "needs a MagicDNS name for this computer",
      );
    });
  });

  describe("when Tailscale is not ready", () => {
    it.each([
      ["logged-out", "not signed in"],
      ["stopped", "not running"],
      ["cli-not-found", "not installed"],
      ["cli-failed", "did not report its status"],
    ] as const)("says which way Tailscale is unusable for %s", async (state, sentence) => {
      const { api } = makeApi({
        snapshot: snapshotOf({ environment: { ...READY_ENVIRONMENT, state } }),
      });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      expect(await screen.findByTestId("tailnet-setup-environment")).toHaveTextContent(sentence);
      expect(screen.queryByTestId("tailnet-setup-ready")).toBeNull();
      expect(screen.getByTestId("tailnet-setup-connect")).toBeEnabled();
    });

    it("carries what the CLI printed rather than a classification of it", async () => {
      const { api } = makeApi({
        snapshot: snapshotOf({
          environment: { ...READY_ENVIRONMENT, state: "cli-failed", detail: "socket: permission denied" },
        }),
      });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      expect(await screen.findByTestId("tailnet-setup-environment-detail")).toHaveTextContent(
        "socket: permission denied",
      );
    });

    it("re-probes on the press and stops there while Tailscale stays unusable", async () => {
      const { api, snapshot, guidedSetup } = makeApi({
        snapshot: snapshotOf({ environment: { ...READY_ENVIRONMENT, state: "stopped" } }),
      });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));

      await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
      expect(guidedSetup).not.toHaveBeenCalled();
      expect(screen.getByTestId("tailnet-setup-environment")).toHaveTextContent("not running");
      await waitFor(() => expect(screen.getByTestId("tailnet-setup-connect")).toBeEnabled());
    });

    it("goes on to connect the moment the same press finds Tailscale usable", async () => {
      const { api, guidedSetup } = makeApi({
        snapshots: [
          snapshotOf({ environment: { ...READY_ENVIRONMENT, state: "stopped" } }),
          snapshotOf(),
        ],
      });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-connect"));

      await waitFor(() => expect(guidedSetup).toHaveBeenCalledTimes(1));
      expect(await screen.findByTestId("tailnet-setup-done-url")).toHaveTextContent(WEB_ORIGIN);
    });
  });

  // A control that only re-reads asked the reader to verify an environment they
  // cannot change from here, and left a stale "ready" as the thing setup ran on.
  it("carries no re-check affordance anywhere in the section", async () => {
    const { api } = makeApi();
    const { container } = render(
      <TailnetSetupCard api={api} onCreateInvitation={() => undefined} />,
    );

    await screen.findByTestId("tailnet-setup-ready");
    expect(screen.queryByTestId("tailnet-setup-recheck")).toBeNull();
    expect(container.textContent).not.toContain("Check again");
  });

  describe("the manual branch", () => {
    it("reveals the full listener form inline, without calling guided setup", async () => {
      const { api, guidedSetup } = makeApi();
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      const toggle = await screen.findByTestId("tailnet-setup-manual-toggle");
      expect(screen.queryByTestId("tailnet-setup-manual-form")).toBeNull();

      fireEvent.click(toggle);
      expect(await screen.findByTestId("tailnet-observer-apply")).toBeInTheDocument();
      expect(guidedSetup).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("tailnet-setup-manual-toggle"));
      await waitFor(() => expect(screen.queryByTestId("tailnet-observer-apply")).toBeNull());
    });

    it("collapses to the status card once the listener the form asked for is up", async () => {
      const { api } = makeApi({ snapshots: [snapshotOf(), configuredSnapshot()] });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-manual-toggle"));
      fireEvent.click(await screen.findByTestId("tailnet-observer-apply"));

      expect(await screen.findByTestId("tailnet-setup-status")).toBeInTheDocument();
    });
  });

  describe("once setup is finished", () => {
    it("shows the facts as a status card instead of the setup card", async () => {
      const { api } = makeApi({ snapshot: configuredSnapshot() });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      const status = await screen.findByTestId("tailnet-setup-status");
      expect(status).toHaveTextContent("Tailscale is running as owner@example.com");
      expect(screen.getByTestId("tailnet-setup-status-url")).toHaveTextContent(WEB_ORIGIN);
      expect(screen.getByTestId("tailnet-setup-status-serve")).toHaveTextContent(
        "Serve forwards your tailnet to this listener",
      );
      expect(screen.queryByTestId("tailnet-setup-ready")).toBeNull();
      expect(screen.queryByTestId("tailnet-setup-not-ready")).toBeNull();
    });

    it("says a port nobody named was chosen for them", async () => {
      const { api } = makeApi({ snapshot: configuredSnapshot() });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

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
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      const port = await screen.findByTestId("tailnet-setup-status-port");
      expect(port).toHaveTextContent("46500");
      expect(port).not.toHaveTextContent("chosen automatically");
    });

    it("re-runs the same one-press setup from the status card", async () => {
      const { api, guidedSetup } = makeApi({ snapshot: configuredSnapshot() });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      fireEvent.click(await screen.findByTestId("tailnet-setup-reconfigure"));

      await waitFor(() => expect(guidedSetup).toHaveBeenCalledTimes(1));
      expect(await screen.findByTestId("tailnet-setup-done-url")).toHaveTextContent(WEB_ORIGIN);
    });

    it("keeps the full form behind an explicit request for it", async () => {
      const { api } = makeApi({ snapshot: configuredSnapshot() });
      render(<TailnetSetupCard api={api} onCreateInvitation={() => undefined} />);

      const toggle = await screen.findByTestId("tailnet-setup-manual-toggle");
      expect(screen.queryByTestId("tailnet-observer-apply")).toBeNull();

      fireEvent.click(toggle);
      expect(await screen.findByTestId("tailnet-observer-apply")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("tailnet-setup-manual-toggle"));
      await waitFor(() => expect(screen.queryByTestId("tailnet-observer-apply")).toBeNull());
    });
  });

  // Setup is settings content, not an overlay. A flow that opened a
  // window-modal dialog would freeze the rest of settings for a decision about
  // one listener, which is the shape this deliberately does not take.
  it("draws every state in the settings flow, never in an overlay", async () => {
    const { api } = makeApi();
    const { container } = render(
      <TailnetSetupCard api={api} onCreateInvitation={() => undefined} />,
    );

    const ready = await screen.findByTestId("tailnet-setup-ready");
    expect(container.contains(ready)).toBe(true);
    expect(ready.closest("[data-settings-section='remote-tailnet-observer']")).not.toBeNull();
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(document.querySelector("[role='alertdialog']")).toBeNull();

    fireEvent.click(screen.getByTestId("tailnet-setup-connect"));

    const done = await screen.findByTestId("tailnet-setup-done");
    expect(container.contains(done)).toBe(true);
    expect(done.closest("[data-settings-section='remote-tailnet-observer']")).not.toBeNull();
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
  });
});
