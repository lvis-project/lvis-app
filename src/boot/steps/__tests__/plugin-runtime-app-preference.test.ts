/**
 * §B3 — buildAppPreferenceReader unit tests.
 *
 * Verifies the explicit allowlist (HOST_PUBLIC_PREFERENCE_KEYS) gate, the
 * undefined-on-reject contract (no throw), the per-(plugin, key) warn dedupe,
 * and live read-through to settingsService.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildAppPreferenceReader,
  HOST_PUBLIC_PREFERENCE_KEYS,
} from "../plugin-runtime.js";
import type { SettingsService } from "../../../data/settings-store.js";

function makeStubSettings(initial: { preferredFlow: "in-app" | "system-browser" } = { preferredFlow: "in-app" }) {
  let webView = initial;
  const stub = {
    get: vi.fn((section: string) => {
      if (section === "webView") return webView;
      return undefined;
    }),
  } as unknown as SettingsService;
  return {
    stub,
    setPreferredFlow(next: "in-app" | "system-browser") {
      webView = { preferredFlow: next };
    },
  };
}

describe("HOST_PUBLIC_PREFERENCE_KEYS allowlist (§B3)", () => {
  it("currently exposes only webView.preferredFlow", () => {
    // Adding a new entry is a deliberate API surface change — this test pins
    // it so a reviewer must update the snapshot consciously.
    expect([...HOST_PUBLIC_PREFERENCE_KEYS]).toEqual(["webView.preferredFlow"]);
  });
});

describe("buildAppPreferenceReader (§B3)", () => {
  it("returns the live setting value for an allowlisted key", () => {
    const { stub } = makeStubSettings({ preferredFlow: "system-browser" });
    const warn = { warn: vi.fn() };
    const read = buildAppPreferenceReader(stub, warn);

    expect(read("plugin-a", "webView.preferredFlow")).toBe("system-browser");
    expect(warn.warn).not.toHaveBeenCalled();
  });

  it("reflects live updates — settings change is visible on next call", () => {
    const { stub, setPreferredFlow } = makeStubSettings({ preferredFlow: "in-app" });
    const warn = { warn: vi.fn() };
    const read = buildAppPreferenceReader(stub, warn);

    expect(read("plugin-a", "webView.preferredFlow")).toBe("in-app");
    setPreferredFlow("system-browser");
    expect(read("plugin-a", "webView.preferredFlow")).toBe("system-browser");
  });

  it("returns undefined for plugin-private keys (pluginConfigs.*)", () => {
    const { stub } = makeStubSettings();
    const warn = { warn: vi.fn() };
    const read = buildAppPreferenceReader(stub, warn);

    expect(read("plugin-a", "pluginConfigs.foo.secret")).toBeUndefined();
    expect(warn.warn).toHaveBeenCalledOnce();
    expect(warn.warn.mock.calls[0][0]).toContain("plugin:plugin-a");
    expect(warn.warn.mock.calls[0][0]).toContain("pluginConfigs.foo.secret");
  });

  it("returns undefined for secret keys (llm.apiKey)", () => {
    const { stub } = makeStubSettings();
    const warn = { warn: vi.fn() };
    const read = buildAppPreferenceReader(stub, warn);

    expect(read("plugin-a", "llm.apiKey")).toBeUndefined();
    expect(warn.warn).toHaveBeenCalledOnce();
  });

  it("returns undefined for prototype-pollution probes (__proto__)", () => {
    const { stub } = makeStubSettings();
    const warn = { warn: vi.fn() };
    const read = buildAppPreferenceReader(stub, warn);

    expect(read("plugin-a", "__proto__")).toBeUndefined();
    expect(read("plugin-a", "constructor")).toBeUndefined();
  });

  it("returns undefined for arbitrary chat/private keys (chat.draftMessage)", () => {
    const { stub } = makeStubSettings();
    const warn = { warn: vi.fn() };
    const read = buildAppPreferenceReader(stub, warn);

    expect(read("plugin-a", "chat.draftMessage")).toBeUndefined();
  });

  it("dedupes warns per (pluginId, key) — same plugin probing same key twice → one warn", () => {
    const { stub } = makeStubSettings();
    const warn = { warn: vi.fn() };
    const read = buildAppPreferenceReader(stub, warn);

    read("plugin-a", "llm.apiKey");
    read("plugin-a", "llm.apiKey");
    read("plugin-a", "llm.apiKey");

    expect(warn.warn).toHaveBeenCalledOnce();
  });

  it("warns once per distinct denied key for the same plugin", () => {
    const { stub } = makeStubSettings();
    const warn = { warn: vi.fn() };
    const read = buildAppPreferenceReader(stub, warn);

    read("plugin-a", "llm.apiKey");
    read("plugin-a", "pluginConfigs.foo.secret");
    read("plugin-a", "llm.apiKey"); // duped — no extra warn
    read("plugin-a", "pluginConfigs.foo.secret"); // duped — no extra warn

    expect(warn.warn).toHaveBeenCalledTimes(2);
  });

  it("warns separately per plugin even on the same key", () => {
    const { stub } = makeStubSettings();
    const warn = { warn: vi.fn() };
    const read = buildAppPreferenceReader(stub, warn);

    read("plugin-a", "llm.apiKey");
    read("plugin-b", "llm.apiKey");

    expect(warn.warn).toHaveBeenCalledTimes(2);
  });

  it("never throws — denied keys, empty keys, and non-string keys all return undefined", () => {
    const { stub } = makeStubSettings();
    const warn = { warn: vi.fn() };
    const read = buildAppPreferenceReader(stub, warn);

    expect(() => read("plugin-a", "")).not.toThrow();
    expect(read("plugin-a", "")).toBeUndefined();
    // Cast to string to simulate runtime input from JS plugin code.
    expect(() => read("plugin-a", null as unknown as string)).not.toThrow();
    expect(read("plugin-a", undefined as unknown as string)).toBeUndefined();
  });
});
