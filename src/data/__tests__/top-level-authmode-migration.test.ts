/**
 * #893 — Top-level authMode migration tests.
 *
 * Legacy installs persisted `authMode` per vendor at
 * `llm.vendors.<v>.authMode`. The new architecture promotes it to a
 * top-level `llm.authMode`. On load:
 *
 *   - If any vendor block carried `authMode: "login"`, the top-level
 *     switch flips to `"login"` and that vendor becomes the active
 *     provider so the user lands on the now-authenticated vendor.
 *   - Per-vendor `authMode` keys are stripped from the in-memory model so
 *     the next write produces a clean on-disk shape.
 *   - When an explicit top-level `authMode` already exists, it wins —
 *     legacy keys are still scrubbed but do not override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockedElectron = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  safeStorage: mockedElectron.safeStorage,
}));

import { SettingsService } from "../settings-store.js";

describe("SettingsService — #893 top-level authMode migration", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-authmode-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  function writeLegacySettings(payload: unknown): void {
    writeFileSync(join(userDataPath, "lvis-settings.json"), JSON.stringify(payload), "utf-8");
  }

  it("defaults llm.authMode to 'manual' when no settings.json exists", () => {
    const service = new SettingsService({ userDataPath });
    expect(service.get("llm").authMode).toBe("manual");
  });

  it("promotes legacy per-vendor authMode=login to top-level authMode + provider", () => {
    writeLegacySettings({
      llm: {
        provider: "openai",
        vendors: {
          openai: {
            model: "gpt-4o",
            enableThinking: false,
            thinkingBudgetTokens: 10_000,
          },
          claude: {
            model: "claude-sonnet-4-6",
            enableThinking: true,
            thinkingBudgetTokens: 10_000,
            authMode: "login",
          },
        },
      },
    });
    const service = new SettingsService({ userDataPath });
    const llm = service.get("llm");
    expect(llm.authMode).toBe("login");
    expect(llm.provider).toBe("claude");
    // Per-vendor `authMode` keys are stripped from the in-memory model.
    expect("authMode" in llm.vendors.claude).toBe(false);
    expect("authMode" in llm.vendors.openai).toBe(false);
  });

  it("keeps existing provider when legacy login vendor matches current provider", () => {
    writeLegacySettings({
      llm: {
        provider: "claude",
        vendors: {
          claude: {
            model: "claude-sonnet-4-6",
            enableThinking: true,
            thinkingBudgetTokens: 10_000,
            authMode: "login",
          },
        },
      },
    });
    const service = new SettingsService({ userDataPath });
    const llm = service.get("llm");
    expect(llm.authMode).toBe("login");
    expect(llm.provider).toBe("claude");
  });

  it("leaves provider unchanged when no vendor has authMode='login'", () => {
    writeLegacySettings({
      llm: {
        provider: "openai",
        vendors: {
          openai: {
            model: "gpt-4o",
            enableThinking: false,
            thinkingBudgetTokens: 10_000,
            authMode: "manual",
          },
        },
      },
    });
    const service = new SettingsService({ userDataPath });
    const llm = service.get("llm");
    expect(llm.authMode).toBe("manual");
    expect(llm.provider).toBe("openai");
    expect("authMode" in llm.vendors.openai).toBe(false);
  });

  it("honours an explicit top-level authMode even when legacy per-vendor keys exist", () => {
    writeLegacySettings({
      llm: {
        authMode: "manual",
        provider: "openai",
        vendors: {
          openai: {
            model: "gpt-4o",
            enableThinking: false,
            thinkingBudgetTokens: 10_000,
          },
          claude: {
            model: "claude-sonnet-4-6",
            enableThinking: true,
            thinkingBudgetTokens: 10_000,
            authMode: "login",
          },
        },
      },
    });
    const service = new SettingsService({ userDataPath });
    const llm = service.get("llm");
    // Top-level explicit wins; legacy per-vendor key is still scrubbed.
    expect(llm.authMode).toBe("manual");
    expect(llm.provider).toBe("openai");
    expect("authMode" in llm.vendors.claude).toBe(false);
  });

  it("ignores legacy authMode='login' on a since-removed/unknown vendor", () => {
    writeLegacySettings({
      llm: {
        provider: "openai",
        vendors: {
          openai: {
            model: "gpt-4o",
            enableThinking: false,
            thinkingBudgetTokens: 10_000,
          },
          "not-a-vendor": {
            model: "x",
            enableThinking: false,
            thinkingBudgetTokens: 10_000,
            authMode: "login",
          },
        },
      },
    });
    const service = new SettingsService({ userDataPath });
    const llm = service.get("llm");
    // Unknown vendor can't be promoted to provider — falls back to manual.
    expect(llm.authMode).toBe("manual");
    expect(llm.provider).toBe("openai");
  });

  it("survives a completely empty llm block (no crash, manual default)", () => {
    writeLegacySettings({ llm: {} });
    const service = new SettingsService({ userDataPath });
    expect(service.get("llm").authMode).toBe("manual");
  });

  it("accepts an explicit top-level authMode='login' on a fresh schema", () => {
    writeLegacySettings({
      llm: {
        authMode: "login",
        provider: "gemini",
        vendors: {
          gemini: {
            model: "gemini-2.0-flash",
            enableThinking: false,
            thinkingBudgetTokens: 10_000,
          },
        },
      },
    });
    const service = new SettingsService({ userDataPath });
    const llm = service.get("llm");
    expect(llm.authMode).toBe("login");
    expect(llm.provider).toBe("gemini");
  });
});
