/**
 * §B3 — routeExternalUrl unit tests.
 *
 * Verifies live-policy lookup, scheme validation, audit logging, and the
 * branch between in-app viewer vs system browser.
 */
import { describe, it, expect, vi } from "vitest";
import { routeExternalUrl } from "../plugin-runtime.js";
import type { SettingsService } from "../../../data/settings-store.js";

function makeStub(initial: "in-app" | "system-browser" = "in-app") {
  let webView: { preferredFlow: "in-app" | "system-browser" } = { preferredFlow: initial };
  const settingsService = {
    get: vi.fn((section: string) => (section === "webView" ? webView : undefined)),
  } as unknown as SettingsService;
  const bootAuditLogger = { log: vi.fn() };
  const openLinkWindowService = vi.fn(async () => {});
  const shellOpenExternal = vi.fn(async () => {});
  return {
    settingsService,
    bootAuditLogger,
    openLinkWindowService,
    shellOpenExternal,
    setFlow(next: "in-app" | "system-browser") {
      webView = { preferredFlow: next };
    },
  };
}

describe("routeExternalUrl (§B3)", () => {
  it("routes to in-app viewer when preferredFlow is 'in-app'", async () => {
    const stub = makeStub("in-app");
    await routeExternalUrl({
      url: "https://example.com/foo",
      pluginId: "p-a",
      ...stub,
    });

    expect(stub.openLinkWindowService).toHaveBeenCalledOnce();
    expect(stub.openLinkWindowService.mock.calls[0][0]).toMatchObject({
      url: "https://example.com/foo",
    });
    expect(stub.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("routes to shell.openExternal when preferredFlow is 'system-browser'", async () => {
    const stub = makeStub("system-browser");
    await routeExternalUrl({
      url: "https://example.com/foo",
      pluginId: "p-a",
      ...stub,
    });

    expect(stub.shellOpenExternal).toHaveBeenCalledOnce();
    expect(stub.shellOpenExternal.mock.calls[0][0]).toBe("https://example.com/foo");
    expect(stub.openLinkWindowService).not.toHaveBeenCalled();
  });

  it("LIVE-reads policy on every call — toggle takes effect on next call", async () => {
    const stub = makeStub("in-app");
    await routeExternalUrl({
      url: "https://example.com/a",
      pluginId: "p",
      ...stub,
    });
    expect(stub.openLinkWindowService).toHaveBeenCalledOnce();
    expect(stub.shellOpenExternal).not.toHaveBeenCalled();

    // User flips the toggle.
    stub.setFlow("system-browser");

    await routeExternalUrl({
      url: "https://example.com/b",
      pluginId: "p",
      ...stub,
    });
    expect(stub.shellOpenExternal).toHaveBeenCalledOnce();
    // openLinkWindowService total still 1 — the second call did NOT use it.
    expect(stub.openLinkWindowService).toHaveBeenCalledOnce();
  });

  it("falls back to in-app when settings has no webView block", async () => {
    const settingsService = { get: vi.fn(() => undefined) } as unknown as SettingsService;
    const bootAuditLogger = { log: vi.fn() };
    const openLinkWindowService = vi.fn(async () => {});
    const shellOpenExternal = vi.fn(async () => {});

    await routeExternalUrl({
      url: "https://example.com",
      pluginId: "p",
      settingsService,
      bootAuditLogger,
      openLinkWindowService,
      shellOpenExternal,
    });

    expect(openLinkWindowService).toHaveBeenCalledOnce();
  });

  it("rejects empty URL", async () => {
    const stub = makeStub();
    await expect(
      routeExternalUrl({ url: "", pluginId: "p", ...stub }),
    ).rejects.toThrow(/non-empty string/);
  });

  it("rejects malformed URL", async () => {
    const stub = makeStub();
    await expect(
      routeExternalUrl({ url: "not a url", pluginId: "p", ...stub }),
    ).rejects.toThrow(/invalid URL/);
  });

  it("rejects non-http(s) schemes (file:, javascript:)", async () => {
    const stub = makeStub();
    await expect(
      routeExternalUrl({ url: "file:///etc/passwd", pluginId: "p", ...stub }),
    ).rejects.toThrow(/only http\(s\)/);
    await expect(
      routeExternalUrl({
        url: "javascript:alert(1)",
        pluginId: "p",
        ...stub,
      }),
    ).rejects.toThrow(/only http\(s\)/);
  });

  it("audit log records origin+path but NOT query/hash (secret-bearing)", async () => {
    const stub = makeStub("in-app");
    await routeExternalUrl({
      url: "https://example.com/path?token=secret&code=abcdef#frag",
      pluginId: "p-x",
      ...stub,
    });

    expect(stub.bootAuditLogger.log).toHaveBeenCalledOnce();
    const entry = stub.bootAuditLogger.log.mock.calls[0][0] as { input: string };
    expect(entry.input).toContain("https://example.com/path");
    expect(entry.input).not.toContain("token=secret");
    expect(entry.input).not.toContain("code=abcdef");
    expect(entry.input).not.toContain("frag");
    expect(entry.input).toContain("flow=in-app");
    expect(entry.input).toContain("plugin:p-x");
  });

  it("survives audit-logger crash (audit must not break host)", async () => {
    const stub = makeStub("system-browser");
    stub.bootAuditLogger.log.mockImplementation(() => {
      throw new Error("audit broken");
    });

    await expect(
      routeExternalUrl({ url: "https://example.com", pluginId: "p", ...stub }),
    ).resolves.toBeUndefined();
    expect(stub.shellOpenExternal).toHaveBeenCalledOnce();
  });
});
