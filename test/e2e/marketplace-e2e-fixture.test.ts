import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvePendingPlugin,
  EXACT_LOOPBACK_MARKETPLACE_ORIGIN,
  postMarketplace,
  publishPlugin,
  requireExactLoopbackMarketplaceOrigin,
} from "./marketplace-e2e-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Marketplace E2E mutation containment", () => {
  it("accepts only the canonical ephemeral Marketplace origin", () => {
    expect(requireExactLoopbackMarketplaceOrigin(EXACT_LOOPBACK_MARKETPLACE_ORIGIN))
      .toBe(EXACT_LOOPBACK_MARKETPLACE_ORIGIN);
    expect(requireExactLoopbackMarketplaceOrigin(`${EXACT_LOOPBACK_MARKETPLACE_ORIGIN}/`))
      .toBe(EXACT_LOOPBACK_MARKETPLACE_ORIGIN);
  });

  it.each([
    "http://127.0.0.1:8766",
    "https://127.0.0.1:8765",
    "http://localhost:8765",
    "http://[::1]:8765",
    "http://marketplace.example:8765",
    "http://127.0.0.1:8765/api/v1",
    "http://127.0.0.1:8765/?target=production",
  ])("rejects non-canonical mutation target %s", (target) => {
    expect(() => requireExactLoopbackMarketplaceOrigin(target))
      .toThrow(/expected exact loopback origin/);
  });

  it("rejects publish and approval before any network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(publishPlugin(
      "https://marketplace.example",
      "publisher-key",
      "fixture-plugin",
      "1.0.0",
      Buffer.from("fixture"),
    )).rejects.toThrow(/refuses target/);
    await expect(approvePendingPlugin(
      "http://127.0.0.1:8000",
      "admin-key",
      "fixture-plugin",
      "1.0.0",
    )).rejects.toThrow(/refuses target/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and non-root-relative POST paths before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(postMarketplace(
      EXACT_LOOPBACK_MARKETPLACE_ORIGIN,
      "admin-key",
      "//marketplace.example/api/v1/admin/plugins/fixture/yank",
    )).rejects.toThrow(/non-root-relative POST path/);
    await expect(postMarketplace(
      EXACT_LOOPBACK_MARKETPLACE_ORIGIN,
      "admin-key",
      "api/v1/admin/plugins/fixture/yank",
    )).rejects.toThrow(/non-root-relative POST path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
