import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type {
  TailnetObserverConfigView,
  TailnetObserverSnapshot,
  TailnetServeResult,
  TailscaleEnvironmentView,
} from "../../../../shared/tailnet-observer-config.js";
import type { LvisApi } from "../../types.js";
import { TailnetObserverSection } from "../TailnetObserverSection.js";

const CAPABILITY = "lvis.example.com/cap/conversation-observer";

const OFF: TailnetObserverConfigView = {
  enabled: false,
  expectedAppCapability: "",
  port: 46_173,
  controllerEnabled: false,
  pairedSharingEnabled: false,
  webEnabled: false,
  webOrigin: "",
};

const DNS_NAME = "desk.example-tailnet.ts.net";

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
      expectedAppCapability: "unset",
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
    derivedWebOrigin: "https://" + DNS_NAME,
    serveCommand: null,
    configFileError: null,
    ...overrides,
  };
}

function makeApi(
  snapshot: TailnetObserverSnapshot,
  applyResult: { ok: true } | { ok: false; error: string } = { ok: true },
  serveResult: TailnetServeResult = { ok: true, url: "https://" + DNS_NAME + "/" },
) {
  const apply = vi.fn(async () => applyResult);
  const configureServe = vi.fn(async () => serveResult);
  const api = {
    tailnetObserver: {
      snapshot: vi.fn(async () => ({ ok: true as const, snapshot })),
      apply,
      configureServe,
    },
  } as unknown as LvisApi;
  return { api, apply, configureServe };
}

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
});

afterEach(() => {
  setLocale(localeBeforeTest);
});

describe("TailnetObserverSection", () => {
  it("offers the controls even when nothing is configured yet", async () => {
    const { api } = makeApi(snapshotOf());

    render(<TailnetObserverSection api={api} />);

    // The dead end this section removes: with sharing unavailable the tab used
    // to render only "not enabled on this desktop", with nothing to act on.
    await waitFor(() => expect(screen.getByTestId("tailnet-observer-enabled")).toBeTruthy());
    expect(screen.getByTestId("tailnet-observer-status").textContent).toContain("Not listening");
  });

  it("proposes the edited configuration as one whole", async () => {
    const { api, apply } = makeApi(snapshotOf());

    render(<TailnetObserverSection api={api} />);
    await waitFor(() => expect(screen.getByTestId("tailnet-observer-capability")).toBeTruthy());

    fireEvent.click(screen.getByTestId("tailnet-observer-enabled"));
    fireEvent.change(screen.getByTestId("tailnet-observer-capability"), {
      target: { value: CAPABILITY },
    });
    fireEvent.click(screen.getByTestId("tailnet-observer-apply"));

    await waitFor(() => expect(apply).toHaveBeenCalledWith({
      ...OFF,
      enabled: true,
      expectedAppCapability: CAPABILITY,
    }));
  });

  it("confirms a save that applied, rather than saying nothing at all", async () => {
    const { api } = makeApi(snapshotOf());

    render(<TailnetObserverSection api={api} />);
    fireEvent.click(await screen.findByTestId("tailnet-observer-apply"));

    // The refresh that follows a save clears feedback, so a confirmation set
    // before it never reached the screen.
    const feedback = await screen.findByTestId("tailnet-observer-feedback");
    expect(feedback.textContent).toContain("saved and applied");
  });

  it("renders the host's rejection code as guidance, not as a code", async () => {
    const { api } = makeApi(snapshotOf(), {
      ok: false,
      error: "tailnet-controller-requires-paired-sharing",
    });

    render(<TailnetObserverSection api={api} />);
    await waitFor(() => expect(screen.getByTestId("tailnet-observer-apply")).toBeTruthy());
    fireEvent.click(screen.getByTestId("tailnet-observer-apply"));

    const feedback = await screen.findByTestId("tailnet-observer-feedback");
    expect(feedback.textContent).toContain("paired sharing");
    expect(feedback.textContent).not.toContain("tailnet-controller");
  });

  it("says when the environment is overriding the saved configuration", async () => {
    const { api } = makeApi(snapshotOf({
      provenance: {
        ...snapshotOf().provenance,
        port: "env-override",
      },
    }));

    render(<TailnetObserverSection api={api} />);

    await waitFor(() => expect(screen.getByTestId("tailnet-observer-env-override")).toBeTruthy());
  });

  it("surfaces a boot failure the log used to be the only record of", async () => {
    const { api } = makeApi(snapshotOf({
      lastStartError: "tailnet-observer-capability-missing-or-invalid",
    }));

    render(<TailnetObserverSection api={api} />);

    const error = await screen.findByTestId("tailnet-observer-start-error");
    expect(error.textContent).toContain("capability");
  });

  it("gives a start failure its own sentence instead of the save failure's", async () => {
    const { api } = makeApi(snapshotOf({
      lastStartError: "tailnet-controller-command-port-unavailable",
    }));

    render(<TailnetObserverSection api={api} />);

    const error = await screen.findByTestId("tailnet-observer-start-error");
    // The code used to fall through to "Listener settings could not be saved",
    // a sentence about a save that had in fact succeeded.
    expect(error.textContent).toContain("Remote commands cannot start");
    expect(error.textContent).not.toContain("could not be saved");
  });

  describe("what this desktop's Tailscale says", () => {
    it("states the login and node name rather than asking for them", async () => {
      const { api } = makeApi(snapshotOf());

      render(<TailnetObserverSection api={api} />);

      const line = await screen.findByTestId("tailnet-observer-environment");
      expect(line.textContent).toContain("owner@example.com");
      expect(line.textContent).toContain(DNS_NAME);
      expect(line.textContent).toContain("example-tailnet.ts.net");
    });

    it("does not print the tailnet twice when it is named after the login", async () => {
      const { api } = makeApi(snapshotOf({
        environment: { ...READY_ENVIRONMENT, tailnetName: "owner@example.com" },
      }));

      render(<TailnetObserverSection api={api} />);

      const line = await screen.findByTestId("tailnet-observer-environment");
      expect(line.textContent?.match(/owner@example\.com/g)).toHaveLength(1);
    });

    it("says what to do when Tailscale is present but signed out", async () => {
      const { api } = makeApi(snapshotOf({
        environment: { ...READY_ENVIRONMENT, state: "logged-out", login: null, dnsName: null },
        derivedWebOrigin: null,
      }));

      render(<TailnetObserverSection api={api} />);

      const line = await screen.findByTestId("tailnet-observer-environment");
      expect(line.textContent).toContain("not signed in");
      expect(line.textContent).toContain("Sign in to Tailscale");
    });

    it("says Tailscale is absent rather than reporting an empty tailnet", async () => {
      const { api } = makeApi(snapshotOf({
        environment: {
          ...READY_ENVIRONMENT,
          state: "cli-not-found",
          login: null,
          dnsName: null,
          tailnetName: null,
        },
        derivedWebOrigin: null,
      }));

      render(<TailnetObserverSection api={api} />);

      const line = await screen.findByTestId("tailnet-observer-environment");
      expect(line.textContent).toContain("not installed");
    });

    it("shows the derived web origin and never offers a field to type one", async () => {
      const { api } = makeApi(snapshotOf());

      render(<TailnetObserverSection api={api} />);

      const origin = await screen.findByTestId("tailnet-observer-web-origin");
      expect(origin.textContent).toContain("https://" + DNS_NAME);
      expect(origin.tagName).not.toBe("INPUT");
      expect(origin.querySelector("input")).toBeNull();
    });

    it("closes the web surface off when there is no MagicDNS name to derive from", async () => {
      const { api } = makeApi(snapshotOf({
        environment: { ...READY_ENVIRONMENT, dnsName: null },
        derivedWebOrigin: null,
      }));

      render(<TailnetObserverSection api={api} />);

      const toggle = await screen.findByTestId("tailnet-observer-web");
      expect(toggle.getAttribute("disabled")).not.toBeNull();
      expect(screen.getByTestId("tailnet-observer-web-origin").textContent)
        .toContain("MagicDNS");
    });
  });

  describe("a damaged configuration file", () => {
    const damaged = () => snapshotOf({
      configFileError: "tailnet-observer-config-file-invalid",
    });

    it("keeps the form usable so Save is reachable", async () => {
      const { api } = makeApi(damaged());

      render(<TailnetObserverSection api={api} />);

      // The dead end: the snapshot used to fail outright, so no draft existed
      // and the section rendered a Refresh button and nothing else.
      await waitFor(() => expect(screen.getByTestId("tailnet-observer-apply")).toBeTruthy());
      expect(screen.getByTestId("tailnet-observer-enabled")).toBeTruthy();
      expect(screen.queryByTestId("tailnet-observer-error")).toBeNull();
    });

    it("says what is wrong and what resetting will do", async () => {
      const { api } = makeApi(damaged());

      render(<TailnetObserverSection api={api} />);

      const banner = await screen.findByTestId("tailnet-observer-config-file-error");
      expect(banner.textContent).toContain("could not be read");
      expect(banner.textContent).toContain("switched-off configuration");
    });

    it("writes a fresh switched-off configuration over the damaged bytes", async () => {
      const { api, apply } = makeApi(damaged());

      render(<TailnetObserverSection api={api} />);
      const reset = await screen.findByTestId("tailnet-observer-reset");
      fireEvent.click(reset);

      await waitFor(() => expect(apply).toHaveBeenCalledWith(OFF));
    });
  });

  describe("putting the listener on the tailnet", () => {
    const listening = (overrides: Partial<TailnetObserverSnapshot> = {}) => snapshotOf({
      listeningPort: 46_173,
      serveCommand: "tailscale serve --bg --https=443 http://127.0.0.1:46173",
      ...overrides,
    });

    it("shows the exact command before anything runs", async () => {
      const { api, configureServe } = makeApi(listening());

      render(<TailnetObserverSection api={api} />);

      const command = await screen.findByTestId("tailnet-observer-serve-command");
      expect(command.textContent)
        .toBe("tailscale serve --bg --https=443 http://127.0.0.1:46173");
      // Shown, not run: nothing executes until the owner asks for it.
      expect(configureServe).not.toHaveBeenCalled();
    });

    it("offers no command while nothing is listening", async () => {
      const { api } = makeApi(snapshotOf());

      render(<TailnetObserverSection api={api} />);
      await waitFor(() => expect(screen.getByTestId("tailnet-observer-apply")).toBeTruthy());

      expect(screen.queryByTestId("tailnet-observer-serve")).toBeNull();
    });

    it("runs it on approval and hands back the reachable URL", async () => {
      const { api, configureServe } = makeApi(listening());

      render(<TailnetObserverSection api={api} />);
      fireEvent.click(await screen.findByTestId("tailnet-observer-serve-run"));

      await waitFor(() => expect(configureServe).toHaveBeenCalledTimes(1));
      const url = await screen.findByTestId("tailnet-observer-serve-url");
      expect(url.textContent).toContain("https://" + DNS_NAME + "/");
    });

    it("shows what Tailscale printed when the command fails", async () => {
      const { api } = makeApi(listening(), { ok: true }, {
        ok: false,
        error: "tailnet-serve-command-failed",
        output: "HTTPS is not enabled on this tailnet",
      });

      render(<TailnetObserverSection api={api} />);
      fireEvent.click(await screen.findByTestId("tailnet-observer-serve-run"));

      const output = await screen.findByTestId("tailnet-observer-serve-output");
      expect(output.textContent).toBe("HTTPS is not enabled on this tailnet");
      expect((await screen.findByTestId("tailnet-observer-feedback")).textContent)
        .toContain("did not complete the Serve command");
    });
  });
});
