// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { PluginUpdatesPill } from "../PluginUpdatesPill.js";
import type { PluginUpdatesPillProps } from "../PluginUpdatesPill.js";
import type { PluginUpdateInfo } from "../../hooks/use-marketplace-updates.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

describe("PluginUpdatesPill", () => {
  afterEach(() => cleanup());

  it("renders nothing when no update is pending", () => {
    renderPill({ updates: [] });
    expect(screen.queryByTestId("marketplace-update-action")).toBeNull();
  });

  it("shows the count in the band and the full list in the hover text", () => {
    renderPill({
      updates: [
        update("meeting", "LVIS Meeting", "2.0.0"),
        update("calendar", "LVIS Calendar", "1.4.0"),
        update("email", "LVIS Email", "3.1.0"),
      ],
    });

    const pill = screen.getByTestId("marketplace-update-action");
    expect(pill.textContent).toContain("플러그인 업데이트 3개");
    const title = pill.getAttribute("title") ?? "";
    expect(title).toContain("3개 플러그인 업데이트 가능");
    expect(title).toContain("LVIS Meeting (meeting) → 2.0.0");
    expect(title).toContain("LVIS Calendar (calendar) → 1.4.0");
    expect(title).toContain("LVIS Email (email) → 3.1.0");
  });

  it("passes the expected latest version to the update action", async () => {
    const onUpdate = vi.fn(async () => undefined);
    renderPill({ updates: [update("meeting", "LVIS Meeting", "0.5.24")], onUpdate });

    screen.getByTestId("marketplace-update-action").click();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith("meeting", "0.5.24", undefined));
  });

  it("requires networkAccess disclosure before updating a network-enabled plugin", async () => {
    const onUpdate = vi.fn(async () => undefined);
    renderPill({
      updates: [{
        ...update("network-plug", "Network Plug", "2.0.0"),
        networkAccess: {
          allowedDomains: ["api.example.com"],
          reasoning: "Needs API access to sync user data.",
        },
      }],
      onUpdate,
    });

    screen.getByTestId("marketplace-update-action").click();
    await vi.waitFor(() => expect(screen.getByTestId(TEST_IDS.pluginInstallNetworkAccess).textContent).toContain("Needs API access"));
    expect(onUpdate).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "설치" }).click();

    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
      "network-plug",
      "2.0.0",
      { networkAccessAcknowledgement: { allowedDomains: ["api.example.com"] } },
    ));
  });

  it("falls back to plugin id when a display name is missing", () => {
    renderPill({ updates: [{ pluginId: "local-indexer", installedVersion: "1.0.0", latestVersion: "1.1.0" }] });

    expect(screen.getByTestId("marketplace-update-action").getAttribute("title")).toContain(
      "local-indexer → 1.1.0",
    );
  });

  it("dismisses the pill when every update in the batch succeeds", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const onDismiss = vi.fn();
    const onResolved = vi.fn();
    renderPill({
      updates: [update("meeting", "LVIS Meeting", "2.0.0"), update("calendar", "LVIS Calendar", "1.4.0")],
      onUpdate,
      onDismiss,
      onResolved,
    });

    screen.getByTestId("marketplace-update-action").click();

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("keeps failed updates for retry and reports succeeded ids on partial failure", async () => {
    const onUpdate = vi.fn(async (pluginId: string) => {
      if (pluginId === "calendar") throw new Error("download failed");
    });
    const onDismiss = vi.fn();
    const onResolved = vi.fn();
    renderPill({
      updates: [
        update("meeting", "LVIS Meeting", "2.0.0"),
        update("calendar", "LVIS Calendar", "1.4.0"),
      ],
      onUpdate,
      onDismiss,
      onResolved,
    });

    screen.getByTestId("marketplace-update-action").click();

    // "성공 1 · 실패 1 (LVIS Calendar (calendar))" plus each failure's own
    // message — the band shows the retry, the hover text shows why.
    const pill = screen.getByTestId("marketplace-update-action");
    await vi.waitFor(() => expect(pill.getAttribute("title")).toContain("성공 1"));
    expect(pill.getAttribute("title")).toContain("실패 1");
    expect(pill.getAttribute("title")).toContain("LVIS Calendar (calendar)");
    expect(pill.getAttribute("title")).toContain("download failed");
    // Succeeded rows are pruned from the visible list; the pill stays for retry.
    expect(onResolved).toHaveBeenCalledWith(["meeting"]);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(pill.textContent).toContain("재시도");
  });

  it("uses the close control as a skip-until-next-version action", () => {
    const onSkip = vi.fn();
    const onDismiss = vi.fn();
    renderPill({ updates: [update("meeting", "LVIS Meeting", "0.5.24")], onSkip, onDismiss });

    screen.getByLabelText("이 플러그인 업데이트를 다음 버전까지 건너뛰기").click();

    expect(onSkip).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

function renderPill(overrides: Partial<PluginUpdatesPillProps> & { updates: PluginUpdateInfo[] }) {
  const props: PluginUpdatesPillProps = {
    onDismiss: vi.fn(),
    onSkip: vi.fn(),
    onUpdate: vi.fn(async () => undefined),
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <PluginUpdatesPill {...props} />
    </TooltipProvider>,
  );
}

function update(pluginId: string, pluginName: string, latestVersion: string): PluginUpdateInfo {
  return {
    pluginId,
    pluginName,
    installedVersion: "1.0.0",
    latestVersion,
  };
}
