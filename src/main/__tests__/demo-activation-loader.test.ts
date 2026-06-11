/**
 * Boot-time demo activation loader tests — focused on the embedded-key
 * hydrate path (no-relaunch fix) and the demo-disabled sentinel.
 *
 * The persisted-file loader path is exercised indirectly here too: the
 * embedded hydrate must defer to an existing `.env.demo` on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptActivationPayload } from "../demo-activation-codec.js";
import {
  loadEmbeddedDemoActivationSync,
  loadPersistedDemoActivationSync,
  persistedEnvDemoPath,
  demoDisabledSentinelPath,
} from "../demo-activation-loader.js";
import { _setEmbeddedActivationCodeForTest } from "../demo-embedded-activation.js";

const SAMPLE_ENV = [
  "LVIS_DEMO_VENDOR=azure-foundry",
  "LVIS_DEMO_KEY_AZURE_FOUNDRY=sk-embedded-hydrate-test",
  "LVIS_DEMO_BASEURL_AZURE_FOUNDRY=https://example.openai.azure.com/openai/v1/",
  "LVIS_DEMO_HOST_MAP=example.openai.azure.com=10.0.0.10",
  "",
].join("\n");

const ORIGINAL_ENV = { ...process.env };
let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "lvis-loader-test-"));
  process.env.LVIS_HOME = tempHome;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("LVIS_DEMO_")) delete process.env[k];
  }
  _setEmbeddedActivationCodeForTest(undefined);
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
  _setEmbeddedActivationCodeForTest(undefined);
});

function seedSecretsDir(): string {
  const dir = join(tempHome, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

describe("loadEmbeddedDemoActivationSync", () => {
  it("hydrates process.env from the embedded key on a fresh install", () => {
    _setEmbeddedActivationCodeForTest(encryptActivationPayload(SAMPLE_ENV));
    const parsed = loadEmbeddedDemoActivationSync();
    expect(parsed.LVIS_DEMO_VENDOR).toBe("azure-foundry");
    expect(process.env.LVIS_DEMO_VENDOR).toBe("azure-foundry");
    expect(process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY).toBe(
      "sk-embedded-hydrate-test",
    );
  });

  it("is a no-op when a persisted .env.demo already exists (disk wins)", () => {
    seedSecretsDir();
    writeFileSync(persistedEnvDemoPath(), "LVIS_DEMO_VENDOR=openai\n", {
      mode: 0o600,
    });
    _setEmbeddedActivationCodeForTest(encryptActivationPayload(SAMPLE_ENV));
    const parsed = loadEmbeddedDemoActivationSync();
    expect(parsed).toEqual({});
    // The persisted loader (not this one) owns hydration in that case.
    expect(process.env.LVIS_DEMO_VENDOR).toBeUndefined();
  });

  it("is a no-op when the demo-disabled sentinel exists (user logged out)", () => {
    seedSecretsDir();
    writeFileSync(demoDisabledSentinelPath(), "", { mode: 0o600 });
    _setEmbeddedActivationCodeForTest(encryptActivationPayload(SAMPLE_ENV));
    const parsed = loadEmbeddedDemoActivationSync();
    expect(parsed).toEqual({});
    expect(process.env.LVIS_DEMO_VENDOR).toBeUndefined();
  });

  it("is a no-op on builds without an embedded key", () => {
    _setEmbeddedActivationCodeForTest(null);
    expect(loadEmbeddedDemoActivationSync()).toEqual({});
    expect(process.env.LVIS_DEMO_VENDOR).toBeUndefined();
  });

  it("falls through (no crash, no hydrate) on a malformed embedded ciphertext", () => {
    _setEmbeddedActivationCodeForTest("LVIS-DEMO:v1:not-a-valid-blob");
    expect(loadEmbeddedDemoActivationSync()).toEqual({});
    expect(process.env.LVIS_DEMO_VENDOR).toBeUndefined();
  });

  it("does not overwrite an existing process.env key (shell wins)", () => {
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-shell-override";
    _setEmbeddedActivationCodeForTest(encryptActivationPayload(SAMPLE_ENV));
    loadEmbeddedDemoActivationSync();
    expect(process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY).toBe("sk-shell-override");
    // Other keys still hydrate.
    expect(process.env.LVIS_DEMO_VENDOR).toBe("azure-foundry");
  });

  it("does NOT write .env.demo to disk (in-memory hydrate only)", () => {
    _setEmbeddedActivationCodeForTest(encryptActivationPayload(SAMPLE_ENV));
    loadEmbeddedDemoActivationSync();
    expect(existsSync(persistedEnvDemoPath())).toBe(false);
  });
});

describe("loadPersistedDemoActivationSync — sentinel symmetry", () => {
  it("hydrates from a persisted .env.demo when no sentinel exists", () => {
    seedSecretsDir();
    writeFileSync(
      persistedEnvDemoPath(),
      "LVIS_DEMO_VENDOR=azure-foundry\n",
      { mode: 0o600 },
    );
    const parsed = loadPersistedDemoActivationSync();
    expect(parsed.LVIS_DEMO_VENDOR).toBe("azure-foundry");
    expect(process.env.LVIS_DEMO_VENDOR).toBe("azure-foundry");
  });

  it("ignores a leftover .env.demo when the demo-disabled sentinel exists", () => {
    // Fail-safe: if `lvis:demo:clear` wrote the sentinel but the subsequent
    // `.env.demo` removal failed, the persisted loader must NOT re-activate
    // the demo the user logged out of (symmetric with the embedded loader).
    seedSecretsDir();
    writeFileSync(
      persistedEnvDemoPath(),
      "LVIS_DEMO_VENDOR=azure-foundry\n",
      { mode: 0o600 },
    );
    writeFileSync(demoDisabledSentinelPath(), "", { mode: 0o600 });
    const parsed = loadPersistedDemoActivationSync();
    expect(parsed).toEqual({});
    expect(process.env.LVIS_DEMO_VENDOR).toBeUndefined();
  });
});
