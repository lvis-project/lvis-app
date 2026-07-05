/**
 * MarketplaceTab — primary CTA + collapsed advanced surface.
 *
 * The tab was restructured so the marketplace web launcher (large CTA
 * button + status dot) is the primary surface; the "서버 연결" knobs
 * (URL editor, API key, private-network toggle) sit behind a top-level
 * "고급 옵션" collapse. These tests assert:
 *   1. the primary CTA renders with the open button + 1-line caption
 *   2. the connection-status dot reflects the resolved pingMarketplace state
 *   3. clicking the CTA calls openExternalUrl(baseUrl)
 *   4. 고급 옵션 body (URL save button) is hidden by default and
 *      revealed only after clicking the toggle
 */
// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MarketplaceTab } from "../MarketplaceTab.js";
import type { MarketplaceItem } from "../../types.js";
import type { LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

function marketplaceTabApi(overrides: Partial<LvisApi> = {}): LvisApi {
  const { api } = makeMockLvisApi();
  Object.assign(api, overrides);
  return api as unknown as LvisApi;
}

function defaultProps(api: LvisApi) {
  return {
    api,
    baseUrl: "https://marketplace.example.com",
    setBaseUrl: vi.fn(),
    allowPrivateNetwork: false,
    setAllowPrivateNetwork: vi.fn(),
    hasApiKey: false,
    setHasApiKey: vi.fn(),
    apiKeyInput: "",
    setApiKeyInput: vi.fn(),
    onSaved: vi.fn(),
    onImmediateChange: vi.fn(),
  };
}

describe("MarketplaceTab", () => {
  it("renders the primary CTA (open button + caption)", async () => {
    const api = marketplaceTabApi();
    const { findByTestId, getByText } = render(<MarketplaceTab {...defaultProps(api)} />);
    const cta = await findByTestId("marketplace:cta:open");
    expect(cta.textContent).toContain("마켓플레이스 열기");
    getByText("플러그인 · MCP · 에이전트 · 스킬 · 프로바이더 · 테마 · 언어를 둘러보세요");
  });

  it("reflects the pingMarketplace status in the CTA status pill", async () => {
    const api = marketplaceTabApi();
    const { findByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);
    const status = await findByTestId("marketplace:cta:status");
    await waitFor(() => expect(status.textContent).toContain("정상"));
  });

  it("shows 응답 없음 when configured but offline", async () => {
    const api = marketplaceTabApi({
      pingMarketplace: vi.fn().mockResolvedValue({ configured: true, online: false }),
    });
    const { findByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);
    const status = await findByTestId("marketplace:cta:status");
    await waitFor(() => expect(status.textContent).toContain("응답 없음"));
  });

  it("calls openExternalUrl(baseUrl) when the CTA is clicked", async () => {
    const api = marketplaceTabApi();
    const { findByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);
    const cta = await findByTestId("marketplace:cta:open");
    fireEvent.click(cta);
    expect(api.openExternalUrl).toHaveBeenCalledWith("https://marketplace.example.com");
  });

  it("hides the 서버 연결 controls behind 고급 옵션 by default", async () => {
    const api = marketplaceTabApi();
    const { findByTestId, queryByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);
    // toggle button is always present; body (and url save button) only when expanded
    await findByTestId("marketplace:advanced:toggle");
    expect(queryByTestId("marketplace:advanced:body")).toBeNull();
    expect(queryByTestId("marketplace:url:save")).toBeNull();
  });

  it("expands 고급 옵션 body when the toggle is clicked", async () => {
    const api = marketplaceTabApi();
    const { findByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);
    const toggle = await findByTestId("marketplace:advanced:toggle");
    fireEvent.click(toggle);
    // After expanding, the URL save button + body marker become visible.
    await findByTestId("marketplace:advanced:body");
    await findByTestId("marketplace:url:save");
  });

  it("routes an admin-policy plugin install through the consent dialog (#1098)", async () => {
    const adminPlugin: MarketplaceItem = {
      id: "admin-plug",
      name: "Admin Plug",
      description: "d",
      packageSpec: "s",
      installed: false,
      enabled: false,
      pluginType: "plugin",
      installPolicy: "admin",
    };
    const api = marketplaceTabApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([adminPlugin]),
    });
    const { findByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);

    fireEvent.click(await findByTestId("marketplace:action:admin-plug"));

    // Clicking install on an admin plugin opens the consent dialog (privilege
    // warning) rather than installing immediately — the actual install only
    // runs from the dialog's acknowledged confirm button.
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("관리자"));
    expect(screen.getByRole("button", { name: "관리자 권한으로 설치" })).toBeTruthy();
  });

  it("routes networkAccess plugin installs through the disclosure dialog (#1279)", async () => {
    const networkPlugin: MarketplaceItem = {
      id: "network-plug",
      name: "Network Plug",
      description: "d",
      packageSpec: "s",
      installed: false,
      enabled: false,
      pluginType: "plugin",
      installPolicy: "user",
      networkAccess: {
        allowedDomains: ["api.example.com"],
        reasoning: "Needs API access to sync user data.",
      },
    };
    const api = marketplaceTabApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([networkPlugin]),
    });
    const { findByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);

    fireEvent.click(await findByTestId("marketplace:action:network-plug"));

    await waitFor(() => expect(screen.getByTestId("plugin-install-network-access").textContent).toContain("Needs API access"));
    expect(screen.getByTestId("plugin-install-network-access").textContent).toContain("api.example.com");
    expect(screen.getByRole("button", { name: "설치" })).toBeTruthy();
  });

  it("shows provider/theme/language filters without routing them through plugin install", async () => {
    const packages: MarketplaceItem[] = [
      {
        id: "openrouter-provider",
        name: "OpenRouter Provider",
        description: "Provider package",
        packageSpec: "provider:openrouter",
        installed: false,
        enabled: false,
        pluginType: "provider",
      },
      {
        id: "moonstone-theme",
        name: "Moonstone Theme",
        description: "Theme package",
        packageSpec: "theme:moonstone",
        installed: false,
        enabled: false,
        pluginType: "theme",
      },
      {
        id: "ko-language-pack",
        name: "Korean Language Pack",
        description: "Language package",
        packageSpec: "language-pack:ko",
        installed: false,
        enabled: false,
        pluginType: "language-pack",
      },
    ];
    const api = marketplaceTabApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue(packages),
    });
    render(<MarketplaceTab {...defaultProps(api)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Providers" }));

    expect(await screen.findByText("OpenRouter Provider")).toBeTruthy();
    expect(screen.queryByText("Moonstone Theme")).toBeNull();
    const action = await screen.findByTestId("marketplace:action:openrouter-provider");
    expect(action.textContent).toContain("준비 중");
    expect((action as HTMLButtonElement).disabled).toBe(true);
    expect(api.listMarketplacePlugins).toHaveBeenCalledOnce();
  });
});
