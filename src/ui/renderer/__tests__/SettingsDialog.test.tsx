/**
 * SettingsDialog smoke tests.
 *
 * SettingsDialog receives a LvisApi instance and open/close state.
 * These are smoke tests: mount + basic prop behaviour only (J1 wave owns
 * the full decomposition).
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("loads settings once and batches key presence checks when dialog opens", async () => {
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
      expect(api.getSettings).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(api.hasApiKey).toHaveBeenCalledTimes(1);
      expect(api.hasWebApiKey).toHaveBeenCalledTimes(1);
      expect(api.hasMarketplaceApiKey).toHaveBeenCalledTimes(1);
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

  it("opens directly on the requested initial tab", async () => {
    const api = makeApi();
    vi.stubGlobal("lvisApi", api);
    render(
      <SettingsDialog
        open={true}
        onOpenChange={vi.fn()}
        api={api as never}
        onSaved={vi.fn()}
        initialTab="permissions"
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /권한/ }).getAttribute("data-state")).toBe("active");
    });
  });

  it("keeps idle preference refresh opt-in and persists it immediately", async () => {
    const api = makeApi();
    const onSaved = vi.fn();
    vi.stubGlobal("lvisApi", api);

    render(
      <SettingsDialog
        open={true}
        onOpenChange={vi.fn()}
        api={api as never}
        onSaved={onSaved}
        initialTab="chat"
      />,
    );

    await waitFor(() => {
      expect(api.getSettings).toHaveBeenCalledTimes(1);
    });
    const toggle = screen.getByTestId("idle-preference-refresh-toggle");
    await waitFor(() => {
      expect(toggle).not.toBeDisabled();
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        features: { idlePreferenceRefresh: true },
      });
    });
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite live feature flags from the bulk save payload", async () => {
    const api = makeApi();
    const baseSettings = await api.getSettings();
    api.getSettings.mockClear();
    api.getSettings.mockResolvedValue({
      ...(baseSettings as object),
      features: { idlePreferenceRefresh: true },
    });
    const onOpenChange = vi.fn();
    vi.stubGlobal("lvisApi", api);

    render(
      <SettingsDialog
        open={true}
        onOpenChange={onOpenChange}
        api={api as never}
        onSaved={vi.fn()}
        initialTab="llm"
      />,
    );

    await waitFor(() => {
      expect(api.onSettingsUpdated).toHaveBeenCalled();
    });
    const saveButton = await screen.findByRole("button", { name: "저장" });
    await waitFor(() => {
      expect(saveButton).toBeEnabled();
    });
    const onSettingsUpdated = api.onSettingsUpdated.mock.calls[0][0] as (settings: unknown) => void;
    onSettingsUpdated({
      ...(baseSettings as object),
      features: { idlePreferenceRefresh: false },
    });
    api.updateSettings.mockClear();

    // The bulk-save payload assertion is tab-agnostic: any explicit save
    // must NOT echo `features` from local state (live updates own that
    // slice). LlmTab still has a TabSaveBar Save button after the PR #780
    // UX overhaul — ChatTab went fully immediate-apply, so the original
    // initialTab="chat" no longer has a Save button to click.
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalled();
    });
    expect(api.updateSettings.mock.calls[0][0]).not.toHaveProperty("features");
  });

  it("uses pending entry count for the permissions badge", async () => {
    const api = makeApi() as ReturnType<typeof makeApi> & {
      permission: {
        deferredList: ReturnType<typeof vi.fn>;
        onDeferredPending: ReturnType<typeof vi.fn>;
      };
    };
    api.permission.deferredList = vi.fn(async () => ({
      ok: true,
      total: 7,
      pending: [
        {
          id: "pending-1",
          ts: "2026-05-10T00:00:00.000Z",
          toolName: "write_file",
          source: "builtin",
          category: "write",
          inputSummary: "{}",
          verdict: { level: "high", reason: "test" },
          status: "pending",
        },
      ],
    }));
    api.permission.onDeferredPending = vi.fn(() => () => {});
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
      const permissionsTrigger = Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("권한"));
      expect(permissionsTrigger?.textContent).toContain("1");
      expect(permissionsTrigger?.textContent).not.toContain("7");
    });
  });

  it("does not close the dialog after a successful TabSaveBar Save click", async () => {
    const api = makeApi();
    const onOpenChange = vi.fn();
    vi.stubGlobal("lvisApi", api);

    render(
      <SettingsDialog
        open={true}
        onOpenChange={onOpenChange}
        api={api as never}
        onSaved={vi.fn()}
        initialTab="llm"
      />,
    );

    await waitFor(() => {
      expect(api.getSettings).toHaveBeenCalledTimes(1);
    });
    api.updateSettings.mockClear();
    onOpenChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalled();
    });
    // PR #780 design: save() never closes the dialog. Close lives on
    // Dialog X / Esc, same as every other modal.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("surfaces an error banner when save fails, and clears it on reopen", async () => {
    const api = makeApi();
    api.updateSettings.mockRejectedValueOnce(new Error("disk full"));
    vi.stubGlobal("lvisApi", api);

    const { rerender } = render(
      <SettingsDialog
        open={true}
        onOpenChange={vi.fn()}
        api={api as never}
        onSaved={vi.fn()}
        initialTab="llm"
      />,
    );

    await waitFor(() => {
      expect(api.getSettings).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(screen.getByTestId("settings-save-error")).toHaveTextContent("disk full");
    });

    // Close + reopen → banner should be cleared by the open-transition effect.
    rerender(
      <SettingsDialog
        open={false}
        onOpenChange={vi.fn()}
        api={api as never}
        onSaved={vi.fn()}
        initialTab="llm"
      />,
    );
    rerender(
      <SettingsDialog
        open={true}
        onOpenChange={vi.fn()}
        api={api as never}
        onSaved={vi.fn()}
        initialTab="llm"
      />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("settings-save-error")).toBeNull();
    });
  });

  it("error banner can be dismissed via the 닫기 link", async () => {
    const api = makeApi();
    api.updateSettings.mockRejectedValueOnce(new Error("perms denied"));
    vi.stubGlobal("lvisApi", api);

    render(
      <SettingsDialog
        open={true}
        onOpenChange={vi.fn()}
        api={api as never}
        onSaved={vi.fn()}
        initialTab="llm"
      />,
    );
    await waitFor(() => {
      expect(api.getSettings).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    const banner = await screen.findByTestId("settings-save-error");
    expect(banner).toHaveTextContent("perms denied");

    fireEvent.click(within(banner).getByRole("button", { name: "닫기" }));
    await waitFor(() => {
      expect(screen.queryByTestId("settings-save-error")).toBeNull();
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
