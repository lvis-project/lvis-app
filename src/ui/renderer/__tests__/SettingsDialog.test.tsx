/**
 * SettingsDialog smoke tests.
 *
 * SettingsDialog receives a LvisApi instance and open/close state.
 * These are smoke tests: mount + basic prop behaviour only (J1 wave owns
 * the full decomposition).
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { SettingsDialog } from "../SettingsDialog.js";
import { makeMockLvisApi } from "../../../../test/renderer/mock-lvis-api.js";

function makeApi() {
  const { api } = makeMockLvisApi();
  return api;
}

describe("SettingsDialog (smoke)", () => {
  it("renders without crashing when open=false", () => {
    vi.stubGlobal("lvisApi", makeApi());
    const { container } = render(
      <SettingsDialog
        open={false}
        onOpenChange={vi.fn()}
        api={makeApi() as never}
        onSaved={vi.fn()}
      />,
    );
    expect(container).toBeTruthy();
  });

  it("renders dialog content to document.body when open=true", async () => {
    const api = makeApi();
    vi.stubGlobal("lvisApi", api);
    render(
      <SettingsDialog
        open={true}
        onOpenChange={vi.fn()}
        api={api as never}
        onSaved={vi.fn()}
      />,
    );
    // Radix Dialog portals content to document.body, not the render container
    await waitFor(() => {
      expect(document.body.textContent?.length).toBeGreaterThan(0);
    });
  });

  it("calls getSettings when dialog opens", async () => {
    const api = makeApi();
    vi.stubGlobal("lvisApi", api);
    render(
      <SettingsDialog
        open={true}
        onOpenChange={vi.fn()}
        api={api as never}
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(api.getSettings).toHaveBeenCalled();
    });
  });

  it("does not call getSettings when dialog is closed", async () => {
    const api = makeApi();
    vi.stubGlobal("lvisApi", api);
    render(
      <SettingsDialog
        open={false}
        onOpenChange={vi.fn()}
        api={api as never}
        onSaved={vi.fn()}
      />,
    );
    // Give a tick for any async effects
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getSettings).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
