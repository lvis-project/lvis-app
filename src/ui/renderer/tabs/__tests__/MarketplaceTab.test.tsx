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
import { fireEvent, render, waitFor } from "@testing-library/react";
import { MarketplaceTab } from "../MarketplaceTab.js";
import type { LvisApi } from "../../types.js";

function makeApi(overrides: Partial<LvisApi> = {}): LvisApi {
  const base = {
    listMarketplacePlugins: vi.fn().mockResolvedValue([]),
    pingMarketplace: vi.fn().mockResolvedValue({ configured: true, online: true }),
    openExternalUrl: vi.fn().mockResolvedValue({ ok: true }),
    deleteMarketplaceApiKey: vi.fn().mockResolvedValue({ ok: true }),
    installMcpFromMarketplace: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  return base as unknown as LvisApi;
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
    const api = makeApi();
    const { findByTestId, getByText } = render(<MarketplaceTab {...defaultProps(api)} />);
    const cta = await findByTestId("marketplace:cta:open");
    expect(cta.textContent).toContain("마켓플레이스 열기");
    getByText("플러그인 · MCP · 에이전트 · 스킬을 둘러보세요");
  });

  it("reflects the pingMarketplace status in the CTA status pill", async () => {
    const api = makeApi();
    const { findByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);
    const status = await findByTestId("marketplace:cta:status");
    await waitFor(() => expect(status.textContent).toContain("정상"));
  });

  it("shows 응답 없음 when configured but offline", async () => {
    const api = makeApi({
      pingMarketplace: vi.fn().mockResolvedValue({ configured: true, online: false }),
    });
    const { findByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);
    const status = await findByTestId("marketplace:cta:status");
    await waitFor(() => expect(status.textContent).toContain("응답 없음"));
  });

  it("calls openExternalUrl(baseUrl) when the CTA is clicked", async () => {
    const api = makeApi();
    const { findByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);
    const cta = await findByTestId("marketplace:cta:open");
    fireEvent.click(cta);
    expect(api.openExternalUrl).toHaveBeenCalledWith("https://marketplace.example.com");
  });

  it("hides the 서버 연결 controls behind 고급 옵션 by default", async () => {
    const api = makeApi();
    const { findByTestId, queryByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);
    // toggle button is always present; body (and url save button) only when expanded
    await findByTestId("marketplace:advanced:toggle");
    expect(queryByTestId("marketplace:advanced:body")).toBeNull();
    expect(queryByTestId("marketplace:url:save")).toBeNull();
  });

  it("expands 고급 옵션 body when the toggle is clicked", async () => {
    const api = makeApi();
    const { findByTestId } = render(<MarketplaceTab {...defaultProps(api)} />);
    const toggle = await findByTestId("marketplace:advanced:toggle");
    fireEvent.click(toggle);
    // After expanding, the URL save button + body marker become visible.
    await findByTestId("marketplace:advanced:body");
    await findByTestId("marketplace:url:save");
  });
});
