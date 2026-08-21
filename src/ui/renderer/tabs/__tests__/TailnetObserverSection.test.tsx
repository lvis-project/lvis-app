import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type {
  TailnetObserverConfigView,
  TailnetObserverSnapshot,
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
    restartRequired: false,
    pairedSharingBootstrapFailed: false,
    ...overrides,
  };
}

function makeApi(snapshot: TailnetObserverSnapshot, applyResult: { ok: true } | { ok: false; error: string } = { ok: true }) {
  const apply = vi.fn(async () => applyResult);
  const api = {
    tailnetObserver: {
      snapshot: vi.fn(async () => ({ ok: true as const, snapshot })),
      apply,
    },
  } as unknown as LvisApi;
  return { api, apply };
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

  it("says a saved change waits for the next launch", async () => {
    const { api } = makeApi(snapshotOf({ restartRequired: true }));

    render(<TailnetObserverSection api={api} />);

    await waitFor(() =>
      expect(screen.getByTestId("tailnet-observer-restart-required")).toBeTruthy());
  });

  it("surfaces a boot failure the log used to be the only record of", async () => {
    const { api } = makeApi(snapshotOf({
      lastStartError: "tailnet-observer-capability-missing-or-invalid",
    }));

    render(<TailnetObserverSection api={api} />);

    const error = await screen.findByTestId("tailnet-observer-start-error");
    expect(error.textContent).toContain("capability");
  });
});
