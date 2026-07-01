// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PluginInstallDialog } from "../PluginInstallDialog.js";
import type { MarketplaceItem } from "../../types.js";

// Renderer suite runs under the `ko` locale (vitest-locale-ko setup), so the
// admin-consent strings assert against the Korean catalog values.
function item(over: Partial<MarketplaceItem> = {}): MarketplaceItem {
  return {
    id: "meeting",
    name: "Meeting",
    description: "d",
    packageSpec: "s",
    installed: false,
    enabled: false,
    ...over,
  };
}

describe("PluginInstallDialog — admin consent gate (#1098)", () => {
  it("gates an admin-policy install behind an acknowledgment checkbox", () => {
    const onConfirm = vi.fn();
    render(
      <PluginInstallDialog
        target={item({ installPolicy: "admin" })}
        working={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    // Explicit privilege warning is shown.
    expect(screen.getByRole("alert").textContent).toContain("관리자");

    // The admin install button is disabled until the user acknowledges.
    const installBtn = screen.getByRole("button", { name: "관리자 권한으로 설치" }) as HTMLButtonElement;
    expect(installBtn.disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();

    // Acknowledge → enabled → confirm passes the plugin id.
    fireEvent.click(screen.getByRole("checkbox"));
    expect(installBtn.disabled).toBe(false);
    fireEvent.click(installBtn);
    expect(onConfirm).toHaveBeenCalledWith("meeting");
  });

  it("does not gate a user-policy install (no warning, install enabled immediately)", () => {
    const onConfirm = vi.fn();
    render(
      <PluginInstallDialog
        target={item({ installPolicy: "user" })}
        working={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    const installBtn = screen.getByRole("button", { name: "설치" }) as HTMLButtonElement;
    expect(installBtn.disabled).toBe(false);
    fireEvent.click(installBtn);
    expect(onConfirm).toHaveBeenCalledWith("meeting");
  });

  it("shows networkAccess reasoning and allowed domains before install", () => {
    const onConfirm = vi.fn();
    render(
      <PluginInstallDialog
        target={item({
          installPolicy: "user",
          networkAccess: {
            allowedDomains: ["graph.microsoft.com", "login.microsoftonline.com"],
            reasoning: "Calendar sync needs Microsoft Graph access.",
          },
        })}
        working={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const disclosure = screen.getByTestId("plugin-install-network-access");
    expect(disclosure.textContent).toContain("네트워크 접근 요청");
    expect(disclosure.textContent).toContain("Calendar sync needs Microsoft Graph access.");
    expect(disclosure.textContent).toContain("graph.microsoft.com");
    expect(disclosure.textContent).toContain("login.microsoftonline.com");
    const installBtn = screen.getByRole("button", { name: "설치" }) as HTMLButtonElement;
    expect(installBtn.disabled).toBe(false);
    fireEvent.click(installBtn);
    expect(onConfirm).toHaveBeenCalledWith("meeting");
  });

  it("re-arms consent when reopened for a different admin plugin", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <PluginInstallDialog
        target={item({ id: "a", name: "A", installPolicy: "admin" })}
        working={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("button", { name: "관리자 권한으로 설치" }) as HTMLButtonElement).disabled).toBe(false);

    // Open for a different admin plugin — consent must reset (button re-disabled).
    rerender(
      <PluginInstallDialog
        target={item({ id: "b", name: "B", installPolicy: "admin" })}
        working={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    expect((screen.getByRole("button", { name: "관리자 권한으로 설치" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
