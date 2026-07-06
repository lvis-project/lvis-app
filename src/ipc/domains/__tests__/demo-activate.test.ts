/**
 * Demo activation IPC handler tests.
 *
 * Verifies the full round-trip:
 *   1. Renderer paste of a valid activation string → decrypt → persist →
 *      env inject → recapture of demo credentials.
 *   2. Invalid code / tampered ciphertext → `invalid-code` error.
 *   3. Payload missing `LVIS_DEMO_VENDOR` → `no-vendor` error.
 *   4. Unknown vendor / missing vendor key / invalid Azure Foundry endpoint
 *      → fail closed before persistence or env mutation.
 *   5. Filesystem write failure → `persist-failed` error.
 *   6. Empty/whitespace input → `invalid-code` (renderer-friendly).
 *
 * The codec module is used as-is — round-tripping through the real
 * encrypt/decrypt path catches any drift between the two sides without
 * mocking the cipher (and without baking a fragile golden string into
 * the test fixture).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE } from "../../../../scripts/lib/dev-electron-exit.mjs";
import { makeAppIpcInvoker, makeAuthLoginMockupDeps } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const relaunchMock = vi.fn();
const exitMock = vi.fn();
let appIsPackaged = true;

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  // v0.2.1 hotfix — demo activation now triggers `app.relaunch()` +
  // `app.exit(0)` on first-activation to heal the host-resolver-rules
  // race. The mocks prevent the test runner from actually exiting.
  app: {
    get isPackaged() {
      return appIsPackaged;
    },
    relaunch: relaunchMock,
    exit: exitMock,
  },
}));

const invoke = makeAppIpcInvoker(handlers);

function invokeWithEvent(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(fn(event, ...args));
}

function makeDeps() {
  return {
    auditLogger: { log: vi.fn() },
  };
}

const SAMPLE_ENV = [
  "LVIS_DEMO_VENDOR=azure-foundry",
  "LVIS_DEMO_KEY_AZURE_FOUNDRY=sk-activated-key",
  "LVIS_DEMO_BASEURL_AZURE_FOUNDRY=https://example.openai.azure.com/openai/v1/",
  "LVIS_DEMO_HOST_MAP=example.openai.azure.com=10.182.192.10",
  "",
].join("\n");

const SAMPLE_ENV_ENDPOINT_ALIAS = [
  "LVIS_DEMO_VENDOR=azure-foundry",
  "LVIS_DEMO_KEY_AZURE_FOUNDRY=sk-activated-key",
  "LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY=https://endpoint.openai.azure.com/openai/v1/",
  "LVIS_DEMO_HOST_MAP=endpoint.openai.azure.com=10.182.192.11",
  "",
].join("\n");

const SAMPLE_ENV_INVALID_ENDPOINT_ALIAS = [
  "LVIS_DEMO_VENDOR=azure-foundry",
  "LVIS_DEMO_KEY_AZURE_FOUNDRY=sk-activated-key",
  "LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY=https://endpoint.example/openai/v1/",
  "",
].join("\n");

const ORIGINAL_ENV = { ...process.env };
let tempHome: string;

beforeEach(() => {
  handlers.clear();
  relaunchMock.mockReset();
  exitMock.mockReset();
  tempHome = mkdtempSync(join(tmpdir(), "lvis-demo-activate-test-"));
  process.env.LVIS_HOME = tempHome;
  // Wipe inherited LVIS_DEMO_* so tests are isolated.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("LVIS_DEMO_")) delete process.env[k];
  }
  delete process.env.LVIS_DEV;
  appIsPackaged = true;
  vi.resetModules();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

async function loadDemoModule() {
  const codec = await import("../../../main/demo-activation-codec.js");
  const credsMod = await import("../../../main/demo-credentials.js");
  credsMod.resetDemoCredentialsForTesting();
  const demoMod = await import("../demo.js");
  // #1498 — `lvis:demo:status` now probes local Ollama over the network.
  // These tests are about the demo-activation stack, not Ollama, so pin
  // the probe to `false` via its test seam (mirrors the embedded-key
  // seam pattern) rather than exercising a real network call per test.
  const ollamaProbeMod = await import("../../../main/ollama-probe.js");
  ollamaProbeMod._setOllamaAvailableOverrideForTest(false);
  return { codec, credsMod, demoMod, ollamaProbeMod };
}

describe("lvis:demo:activate — happy path", () => {
  it("decrypts a valid code, persists the file, and injects the env", async () => {
    const { codec, credsMod, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(SAMPLE_ENV);

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = (await invoke("lvis:demo:activate", { code })) as {
      ok: true;
      vendor: string;
      requiresRelaunch?: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.vendor).toBe("azure-foundry");

    // First activation is armed for relaunch, but the renderer owns the
    // 5s onboarding dwell before it calls the explicit relaunch IPC.
    expect(result.requiresRelaunch).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();

    const relaunch = await invoke("lvis:demo:relaunch-after-activation");
    expect(relaunch).toEqual({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relaunchMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(0);

    // File persisted under ~/.lvis/secrets/.env.demo (via LVIS_HOME override).
    const persisted = readFileSync(
      join(tempHome, "secrets", ".env.demo"),
      "utf8",
    );
    expect(persisted).toBe(SAMPLE_ENV);

    // process.env got injected.
    expect(process.env.LVIS_DEMO_VENDOR).toBe("azure-foundry");
    expect(process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY).toBe("sk-activated-key");

    // demo-credentials recapture observed the new keys.
    expect(credsMod.isDemoEnabled()).toBe(true);
    expect(credsMod.getDemoActiveVendor()).toBe("azure-foundry");
    const cfg = credsMod.getDemoVendorConfig("azure-foundry");
    expect(cfg?.apiKey).toBe("sk-activated-key");
    expect(cfg?.baseUrl).toBe("https://example.openai.azure.com/openai/v1/");

    // Audit row written.
    expect(deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining("[demo-activation] activated"),
      }),
    );
  });

  it("recaptures endpoint alias payloads into azure-foundry baseUrl", async () => {
    const { codec, credsMod, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(SAMPLE_ENV_ENDPOINT_ALIAS);

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = (await invoke("lvis:demo:activate", { code })) as {
      ok: true;
      vendor: string;
      requiresRelaunch?: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.vendor).toBe("azure-foundry");

    const persisted = readFileSync(
      join(tempHome, "secrets", ".env.demo"),
      "utf8",
    );
    expect(persisted).toBe(SAMPLE_ENV_ENDPOINT_ALIAS);
    expect(process.env.LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY).toBe(
      "https://endpoint.openai.azure.com/openai/v1/",
    );

    const cfg = credsMod.getDemoVendorConfig("azure-foundry");
    expect(cfg?.apiKey).toBe("sk-activated-key");
    expect(cfg?.baseUrl).toBe("https://endpoint.openai.azure.com/openai/v1/");
  });
});

describe("lvis:demo:status", () => {
  it("reports boot-effective demo activation even after LVIS_DEMO env is scrubbed", async () => {
    const { credsMod, demoMod } = await loadDemoModule();
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-activated-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY =
      "https://example.openai.azure.com/openai/v1/";
    process.env.LVIS_DEMO_HOST_MAP = "example.openai.azure.com=10.182.192.20";
    credsMod.captureDemoCredentials();
    delete process.env.LVIS_DEMO_VENDOR;
    delete process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY;
    delete process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY;
    delete process.env.LVIS_DEMO_HOST_MAP;

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:status");
    expect(result).toEqual({
      ok: true,
      activated: true,
      vendor: "azure-foundry",
      autoActivatable: false,
      ollamaAvailable: false,
    });
  });

  it("reports inactive when captured Azure Foundry credentials were not effective at boot", async () => {
    const { credsMod, demoMod } = await loadDemoModule();
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-stale-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY =
      "https://example.openai.azure.com/openai/v1/";
    credsMod.captureDemoCredentials();
    expect(credsMod.isDemoEnabled()).toBe(true);

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:status");
    expect(result).toEqual({ ok: true, activated: false, vendor: null, autoActivatable: false, ollamaAvailable: false });
  });

  it("reports inactive when no demo credentials were captured at boot", async () => {
    const { demoMod } = await loadDemoModule();
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:status");
    expect(result).toEqual({ ok: true, activated: false, vendor: null, autoActivatable: false, ollamaAvailable: false });
  });

  it("rejects an untrusted sender frame without leaking activation state", async () => {
    const { credsMod, demoMod } = await loadDemoModule();
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-activated-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY =
      "https://example.openai.azure.com/openai/v1/";
    credsMod.captureDemoCredentials();

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invokeWithEvent(
      "lvis:demo:status",
      { senderFrame: { url: "https://evil.example/app" } },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("lvis:demo:activate — first-activation relaunch (v0.2.1 hotfix)", () => {
  it("uses the dev-runner managed relaunch exit code under bun run dev", async () => {
    process.env.LVIS_DEV = "1";
    appIsPackaged = false;
    const { codec, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(SAMPLE_ENV);
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = (await invoke("lvis:demo:activate", { code })) as {
      ok: true;
      vendor: string;
      requiresRelaunch?: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.requiresRelaunch).toBe(true);
    expect(exitMock).not.toHaveBeenCalled();
    const relaunch = await invoke("lvis:demo:relaunch-after-activation");
    expect(relaunch).toEqual({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE);
  });

  it("omits requiresRelaunch and skips app.relaunch when demo was already effective at boot", async () => {
    // Simulate the second-boot path: `.env.demo` already on disk →
    // `captureDemoCredentials` ran with the right env → `isDemoEnabled()`
    // returns true → activation handler captures `demoWasEffectiveAtBoot=true`.
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-boot-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY = "https://example.openai.azure.com/openai/v1/";
    process.env.LVIS_DEMO_HOST_MAP = "example.openai.azure.com=10.182.192.10";
    const { codec, credsMod, demoMod } = await loadDemoModule();
    // captureDemoCredentials before registerDemoHandlers — mirrors the
    // real boot order in main.ts.
    credsMod.captureDemoCredentials();
    expect(credsMod.isDemoEnabled()).toBe(true);

    const code = codec.encryptActivationPayload(SAMPLE_ENV);
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = (await invoke("lvis:demo:activate", { code })) as {
      ok: true;
      vendor: string;
      requiresRelaunch?: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.requiresRelaunch).toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
    const relaunch = await invoke("lvis:demo:relaunch-after-activation");
    expect(relaunch).toEqual({ ok: false, error: "not-armed" });
  });

  it("requires relaunch when a new activation changes the boot-applied endpoint host map", async () => {
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-boot-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY = "https://example.openai.azure.com/openai/v1/";
    process.env.LVIS_DEMO_HOST_MAP = "example.openai.azure.com=10.182.192.10";
    const { codec, credsMod, demoMod } = await loadDemoModule();
    credsMod.captureDemoCredentials();
    expect(credsMod.isDemoEnabled()).toBe(true);

    const code = codec.encryptActivationPayload(SAMPLE_ENV_ENDPOINT_ALIAS);
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = (await invoke("lvis:demo:activate", { code })) as {
      ok: true;
      vendor: string;
      requiresRelaunch?: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.requiresRelaunch).toBe(true);
  });

  it("requires relaunch when the existing boot capture had an invalid Azure Foundry endpoint", async () => {
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-old-boot-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY = "not-a-url";
    process.env.LVIS_DEMO_HOST_MAP = "example.openai.azure.com=10.182.192.10";
    const { codec, credsMod, demoMod } = await loadDemoModule();
    credsMod.captureDemoCredentials();
    expect(credsMod.isDemoEnabled()).toBe(true);

    const code = codec.encryptActivationPayload(SAMPLE_ENV);
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = (await invoke("lvis:demo:activate", { code })) as {
      ok: true;
      vendor: string;
      requiresRelaunch?: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.requiresRelaunch).toBe(true);
  });

  it("requires relaunch when the existing boot capture lacked the Azure Foundry host map", async () => {
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-old-boot-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY = "https://example.openai.azure.com/openai/v1/";
    const { codec, credsMod, demoMod } = await loadDemoModule();
    credsMod.captureDemoCredentials();
    expect(credsMod.isDemoEnabled()).toBe(true);

    const code = codec.encryptActivationPayload(SAMPLE_ENV);
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = (await invoke("lvis:demo:activate", { code })) as {
      ok: true;
      vendor: string;
      requiresRelaunch?: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.requiresRelaunch).toBe(true);

    const relaunch = await invoke("lvis:demo:relaunch-after-activation");
    expect(relaunch).toEqual({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relaunchMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(0);
  });
});

describe("lvis:demo:activate — invalid-code", () => {
  it("rejects an untrusted sender frame", async () => {
    const { codec, demoMod } = await loadDemoModule();
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);
    const code = codec.encryptActivationPayload(SAMPLE_ENV);
    const result = await invokeWithEvent(
      "lvis:demo:activate",
      { senderFrame: { url: "https://evil.example/app" } },
      { code },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("rejects an empty string", async () => {
    const { demoMod } = await loadDemoModule();
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);
    const result = await invoke("lvis:demo:activate", { code: "" });
    expect(result).toEqual({ ok: false, error: "invalid-code" });
  });

  it("rejects a non-string payload", async () => {
    const { demoMod } = await loadDemoModule();
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);
    const result = await invoke("lvis:demo:activate", { code: 42 });
    expect(result).toEqual({ ok: false, error: "invalid-code" });
  });

  it("rejects a code without the LVIS-DEMO:v1: prefix", async () => {
    const { demoMod } = await loadDemoModule();
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);
    const result = await invoke("lvis:demo:activate", {
      code: "not-a-valid-activation-string",
    });
    expect(result).toEqual({ ok: false, error: "invalid-code" });
  });

  it("rejects a tampered ciphertext", async () => {
    const { codec, demoMod } = await loadDemoModule();
    const original = codec.encryptActivationPayload(SAMPLE_ENV);
    const idx = original.length - 5;
    const tampered =
      original.slice(0, idx) +
      (original[idx] === "a" ? "b" : "a") +
      original.slice(idx + 1);
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);
    const result = await invoke("lvis:demo:activate", { code: tampered });
    expect(result).toEqual({ ok: false, error: "invalid-code" });
    // File MUST NOT be persisted on tamper.
    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
  });

  it("emits a warn audit row for invalid codes", async () => {
    const { demoMod } = await loadDemoModule();
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);
    await invoke("lvis:demo:activate", { code: "garbage" });
    expect(deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warn",
        input: expect.stringContaining("invalid-code"),
      }),
    );
  });
});

describe("lvis:demo:relaunch-after-activation — sender guard", () => {
  it("rejects an untrusted sender frame before checking armed state", async () => {
    const { demoMod } = await loadDemoModule();
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);
    const result = await invokeWithEvent(
      "lvis:demo:relaunch-after-activation",
      { senderFrame: { url: "https://evil.example/app" } },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });
});

describe("lvis:demo:activate — no-vendor", () => {
  it("rejects a payload missing LVIS_DEMO_VENDOR", async () => {
    const { codec, demoMod } = await loadDemoModule();
    const payloadWithoutVendor = "LVIS_DEMO_KEY_OPENAI=k\n";
    const code = codec.encryptActivationPayload(payloadWithoutVendor);

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate", { code });
    expect(result).toEqual({ ok: false, error: "no-vendor" });
    // No persistence on validation failure.
    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
  });

  it("rejects a payload with an unknown LVIS_DEMO_VENDOR", async () => {
    const { codec, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(
      "LVIS_DEMO_VENDOR=not-a-vendor\nLVIS_DEMO_KEY_AZURE_FOUNDRY=sk-key\n",
    );

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate", { code });
    expect(result).toEqual({ ok: false, error: "invalid-vendor" });
    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });
});

describe("lvis:demo:activate — invalid endpoint", () => {
  it("rejects missing active vendor key before persistence, env injection, or relaunch arming", async () => {
    const { codec, credsMod, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(
      [
        "LVIS_DEMO_VENDOR=azure-foundry",
        "LVIS_DEMO_BASEURL_AZURE_FOUNDRY=https://example.openai.azure.com/openai/v1/",
        "",
      ].join("\n"),
    );

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate", { code });
    expect(result).toEqual({ ok: false, error: "no-demo-key" });
    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
    expect(process.env.LVIS_DEMO_VENDOR).toBeUndefined();
    expect(process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY).toBeUndefined();
    expect(credsMod.isDemoEnabled()).toBe(false);
    expect(credsMod.getDemoVendorConfig("azure-foundry")).toBeNull();

    const relaunch = await invoke("lvis:demo:relaunch-after-activation");
    expect(relaunch).toEqual({ ok: false, error: "not-armed" });
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("rejects missing Azure Foundry endpoint before persistence, env injection, or relaunch arming", async () => {
    const { codec, credsMod, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(
      "LVIS_DEMO_VENDOR=azure-foundry\nLVIS_DEMO_KEY_AZURE_FOUNDRY=sk-key\n",
    );

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate", { code });
    expect(result).toEqual({ ok: false, error: "missing-foundry-endpoint" });
    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
    expect(process.env.LVIS_DEMO_VENDOR).toBeUndefined();
    expect(process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY).toBeUndefined();
    expect(credsMod.isDemoEnabled()).toBe(false);
    expect(credsMod.getDemoVendorConfig("azure-foundry")).toBeNull();

    const relaunch = await invoke("lvis:demo:relaunch-after-activation");
    expect(relaunch).toEqual({ ok: false, error: "not-armed" });
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("rejects missing Azure Foundry host map before persistence, env injection, or relaunch arming", async () => {
    const { codec, credsMod, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(
      [
        "LVIS_DEMO_VENDOR=azure-foundry",
        "LVIS_DEMO_KEY_AZURE_FOUNDRY=sk-key",
        "LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY=https://endpoint.openai.azure.com/openai/v1/",
        "",
      ].join("\n"),
    );

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate", { code });
    expect(result).toEqual({ ok: false, error: "missing-foundry-host-map" });
    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
    expect(process.env.LVIS_DEMO_VENDOR).toBeUndefined();
    expect(process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY).toBeUndefined();
    expect(credsMod.isDemoEnabled()).toBe(false);

    const relaunch = await invoke("lvis:demo:relaunch-after-activation");
    expect(relaunch).toEqual({ ok: false, error: "not-armed" });
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("rejects Azure Foundry host maps that do not cover the endpoint host", async () => {
    const { codec, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(
      [
        "LVIS_DEMO_VENDOR=azure-foundry",
        "LVIS_DEMO_KEY_AZURE_FOUNDRY=sk-key",
        "LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY=https://endpoint.openai.azure.com/openai/v1/",
        "LVIS_DEMO_HOST_MAP=other.openai.azure.com=10.182.192.12",
        "",
      ].join("\n"),
    );

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate", { code });
    expect(result).toEqual({ ok: false, error: "foundry-host-map-mismatch" });
    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
  });

  it("rejects Azure Foundry host maps that target local or arbitrary private IPs", async () => {
    const { codec, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(
      [
        "LVIS_DEMO_VENDOR=azure-foundry",
        "LVIS_DEMO_KEY_AZURE_FOUNDRY=sk-key",
        "LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY=https://endpoint.openai.azure.com/openai/v1/",
        "LVIS_DEMO_HOST_MAP=endpoint.openai.azure.com=127.0.0.1",
        "",
      ].join("\n"),
    );

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate", { code });
    expect(result).toEqual({ ok: false, error: "invalid-foundry-host-map-target" });
    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
  });

  it("rejects invalid Azure Foundry endpoint before persistence, env injection, or relaunch arming", async () => {
    const { codec, credsMod, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(SAMPLE_ENV_INVALID_ENDPOINT_ALIAS);

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate", { code });
    expect(result).toEqual({ ok: false, error: "invalid-foundry-endpoint" });
    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
    expect(process.env.LVIS_DEMO_VENDOR).toBeUndefined();
    expect(process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY).toBeUndefined();
    expect(process.env.LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY).toBeUndefined();
    expect(credsMod.isDemoEnabled()).toBe(false);
    expect(credsMod.getDemoVendorConfig("azure-foundry")).toBeNull();

    const relaunch = await invoke("lvis:demo:relaunch-after-activation");
    expect(relaunch).toEqual({ ok: false, error: "not-armed" });
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });
});

describe("lvis:demo:clear", () => {
  it("removes .env.demo, scrubs LVIS_DEMO_* env vars, and resets the captured demo state", async () => {
    // 2026-05-20 — Settings 의 로그아웃 path. activate → clear 의 한 round-trip
    // 으로 .env.demo 파일이 사라지고, process.env 의 LVIS_DEMO_* 가 모두
    // 비워지며, main 의 captured demo state 가 inactive 로 회귀하는지 검증.
    const { codec, credsMod, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(SAMPLE_ENV);

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const activateResult = (await invoke("lvis:demo:activate", { code })) as {
      ok: true;
    };
    expect(activateResult.ok).toBe(true);
    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(true);
    expect(process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY).toBe("sk-activated-key");
    expect(credsMod.isDemoEnabled()).toBe(true);

    const clearResult = await invoke("lvis:demo:clear");
    expect(clearResult).toEqual({ ok: true });

    expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
    for (const k of Object.keys(process.env)) {
      expect(k.startsWith("LVIS_DEMO_")).toBe(false);
    }
    expect(credsMod.isDemoEnabled()).toBe(false);
    expect(credsMod.getDemoVendorConfig("azure-foundry")).toBeNull();

    const inactiveStatus = await invoke("lvis:demo:status");
    expect(inactiveStatus).toEqual({
      ok: true,
      activated: false,
      vendor: null,
      autoActivatable: false,
      ollamaAvailable: false,
    });

    // Audit row for the clear event.
    expect(deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining("[demo-activation] cleared"),
      }),
    );

    // Subsequent relaunch IPC should be unarmed.
    const relaunch = await invoke("lvis:demo:relaunch-after-activation");
    expect(relaunch).toEqual({ ok: false, error: "not-armed" });
  });

  it("makes status inactive after clearing a boot-effective demo", async () => {
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-boot-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY =
      "https://example.openai.azure.com/openai/v1/";
    process.env.LVIS_DEMO_HOST_MAP =
      "example.openai.azure.com=10.182.192.10";
    const { credsMod, demoMod } = await loadDemoModule();
    credsMod.captureDemoCredentials();
    expect(credsMod.isDemoEnabled()).toBe(true);

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    expect(await invoke("lvis:demo:status")).toEqual({
      ok: true,
      activated: true,
      vendor: "azure-foundry",
      autoActivatable: false,
      ollamaAvailable: false,
    });

    expect(await invoke("lvis:demo:clear")).toEqual({ ok: true });
    expect(await invoke("lvis:demo:status")).toEqual({
      ok: true,
      activated: false,
      vendor: null,
      autoActivatable: false,
      ollamaAvailable: false,
    });
  });

  it("is idempotent — clearing twice without an active demo still returns ok:true", async () => {
    const { demoMod } = await loadDemoModule();
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const first = await invoke("lvis:demo:clear");
    expect(first).toEqual({ ok: true });
    const second = await invoke("lvis:demo:clear");
    expect(second).toEqual({ ok: true });
  });

  it("rejects an untrusted sender frame", async () => {
    const { demoMod } = await loadDemoModule();
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);
    const result = await invokeWithEvent(
      "lvis:demo:clear",
      { senderFrame: { url: "https://evil.example/app" } },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("lvis:demo:activate — persist-failed audit", () => {
  it("emits a warn audit row when disk persistence fails (M3)", async () => {
    // critic MAJOR M3 (2026-05-19): persist-failed branch previously
    // returned the error without writing an audit row, leaving partial-
    // state activations invisible to forensic timelines. This regression
    // guard asserts symmetry with the invalid-code audit row.
    const { codec, demoMod } = await loadDemoModule();
    const code = codec.encryptActivationPayload(SAMPLE_ENV);

    // Force the persist path to fail by pointing LVIS_HOME at a regular file
    // so mkdir(<LVIS_HOME>/secrets, {recursive:true}) inside writeEnvDemoFile
    // raises ENOTDIR. lvisHome() reads LVIS_HOME and returns it verbatim;
    // the handler then resolves <LVIS_HOME>/secrets/.env.demo.
    const { writeFileSync } = await import("node:fs");
    const blockingFile = join(tempHome, "blocked-lvis-home");
    writeFileSync(blockingFile, "not-a-dir");
    process.env.LVIS_HOME = blockingFile;

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate", { code });
    expect(result).toEqual({ ok: false, error: "persist-failed" });
    expect(deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warn",
        input: expect.stringContaining("persist-failed"),
      }),
    );
  });
});

describe("lvis:demo:activate-embedded — build-embedded activation key", () => {
  async function loadWithEmbedded(code: string | null) {
    const loaded = await loadDemoModule();
    const embeddedMod = await import("../../../main/demo-embedded-activation.js");
    embeddedMod._setEmbeddedActivationCodeForTest(code);
    return { ...loaded, embeddedMod };
  }

  it("activates with the embedded code through the same validation chain", async () => {
    const { codec, credsMod, demoMod, embeddedMod } = await loadWithEmbedded(null);
    embeddedMod._setEmbeddedActivationCodeForTest(
      codec.encryptActivationPayload(SAMPLE_ENV),
    );
    try {
      const deps = makeDeps();
      demoMod.registerDemoHandlers(deps as never);

      const result = (await invoke("lvis:demo:activate-embedded")) as {
        ok: true;
        vendor: string;
        requiresRelaunch?: boolean;
      };
      expect(result.ok).toBe(true);
      expect(result.vendor).toBe("azure-foundry");
      // First activation arms the relaunch exactly like the manual path.
      expect(result.requiresRelaunch).toBe(true);

      const persisted = readFileSync(
        join(tempHome, "secrets", ".env.demo"),
        "utf8",
      );
      expect(persisted).toBe(SAMPLE_ENV);
      expect(credsMod.isDemoEnabled()).toBe(true);
      expect(credsMod.getDemoActiveVendor()).toBe("azure-foundry");

      // Audit row records the embedded source so support can tell a
      // build-embedded activation apart from a pasted one.
      expect(deps.auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "info",
          input: expect.stringContaining("source=embedded"),
        }),
      );
    } finally {
      embeddedMod._setEmbeddedActivationCodeForTest(undefined);
    }
  });

  it("returns no-embedded-code when the build carries no embedded key", async () => {
    const { demoMod, embeddedMod } = await loadWithEmbedded(null);
    try {
      demoMod.registerDemoHandlers(makeDeps() as never);
      const result = await invoke("lvis:demo:activate-embedded");
      expect(result).toEqual({ ok: false, error: "no-embedded-code" });
      expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
    } finally {
      embeddedMod._setEmbeddedActivationCodeForTest(undefined);
    }
  });

  it("surfaces invalid-code when the embedded payload cannot be decrypted", async () => {
    const { demoMod, embeddedMod } = await loadWithEmbedded(
      "LVIS-DEMO:v1:not-a-real-blob",
    );
    try {
      const deps = makeDeps();
      demoMod.registerDemoHandlers(deps as never);
      const result = await invoke("lvis:demo:activate-embedded");
      expect(result).toEqual({ ok: false, error: "invalid-code" });
      expect(deps.auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warn",
          input: expect.stringContaining("source=embedded"),
        }),
      );
    } finally {
      embeddedMod._setEmbeddedActivationCodeForTest(undefined);
    }
  });

  it("rejects an untrusted sender frame", async () => {
    const { codec, demoMod, embeddedMod } = await loadWithEmbedded(null);
    embeddedMod._setEmbeddedActivationCodeForTest(
      codec.encryptActivationPayload(SAMPLE_ENV),
    );
    try {
      demoMod.registerDemoHandlers(makeDeps() as never);
      const result = await invokeWithEvent(
        "lvis:demo:activate-embedded",
        { senderFrame: { url: "https://evil.example/app" } },
      );
      expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
      expect(existsSync(join(tempHome, "secrets", ".env.demo"))).toBe(false);
    } finally {
      embeddedMod._setEmbeddedActivationCodeForTest(undefined);
    }
  });
});

describe("lvis:demo:status — autoActivatable", () => {
  it("advertises autoActivatable when the build embeds an activation key", async () => {
    const loaded = await loadDemoModule();
    const embeddedMod = await import("../../../main/demo-embedded-activation.js");
    embeddedMod._setEmbeddedActivationCodeForTest(
      loaded.codec.encryptActivationPayload(SAMPLE_ENV),
    );
    try {
      loaded.demoMod.registerDemoHandlers(makeDeps() as never);
      const status = (await invoke("lvis:demo:status")) as {
        ok: true;
        activated: boolean;
        autoActivatable: boolean;
      };
      expect(status.ok).toBe(true);
      expect(status.activated).toBe(false);
      expect(status.autoActivatable).toBe(true);
    } finally {
      embeddedMod._setEmbeddedActivationCodeForTest(undefined);
    }
  });

  it("reports autoActivatable=false on builds without an embedded key", async () => {
    const loaded = await loadDemoModule();
    const embeddedMod = await import("../../../main/demo-embedded-activation.js");
    embeddedMod._setEmbeddedActivationCodeForTest(null);
    try {
      loaded.demoMod.registerDemoHandlers(makeDeps() as never);
      const status = (await invoke("lvis:demo:status")) as {
        ok: true;
        autoActivatable: boolean;
      };
      expect(status.autoActivatable).toBe(false);
    } finally {
      embeddedMod._setEmbeddedActivationCodeForTest(undefined);
    }
  });
});

describe("lvis:demo:status — ollamaAvailable (#1498)", () => {
  it("reports ollamaAvailable=true when the local probe succeeds", async () => {
    const { demoMod, ollamaProbeMod } = await loadDemoModule();
    ollamaProbeMod._setOllamaAvailableOverrideForTest(true);
    demoMod.registerDemoHandlers(makeDeps() as never);
    const status = (await invoke("lvis:demo:status")) as {
      ok: true;
      ollamaAvailable: boolean;
    };
    expect(status.ollamaAvailable).toBe(true);
  });

  it("reports ollamaAvailable=false when the local probe fails", async () => {
    const { demoMod, ollamaProbeMod } = await loadDemoModule();
    ollamaProbeMod._setOllamaAvailableOverrideForTest(false);
    demoMod.registerDemoHandlers(makeDeps() as never);
    const status = (await invoke("lvis:demo:status")) as {
      ok: true;
      ollamaAvailable: boolean;
    };
    expect(status.ollamaAvailable).toBe(false);
  });
});

describe("lvis:demo:status — ollama probe cache (#1498 security-MINOR)", () => {
  it("collapses a burst of status calls within the TTL into a single probe", async () => {
    const { demoMod, ollamaProbeMod } = await loadDemoModule();
    // Spy on the underlying probe so we can count real invocations. The seam
    // override alone would answer without letting us assert the coalescing.
    const probeSpy = vi
      .spyOn(ollamaProbeMod, "probeOllamaAvailable")
      .mockResolvedValue(true);
    demoMod.registerDemoHandlers(makeDeps() as never);

    // Three back-to-back status calls (mimics the modal open + re-renders).
    const [a, b, c] = await Promise.all([
      invoke("lvis:demo:status"),
      invoke("lvis:demo:status"),
      invoke("lvis:demo:status"),
    ]);
    for (const r of [a, b, c]) {
      expect((r as { ollamaAvailable: boolean }).ollamaAvailable).toBe(true);
    }
    // In-flight coalescing + short TTL means at most one real probe fired.
    expect(probeSpy).toHaveBeenCalledOnce();

    probeSpy.mockRestore();
  });
});

describe("lvis:demo:activate-ollama (#1498)", () => {
  it("configures the ollama vendor and returns ok when the probe finds a local server", async () => {
    const { demoMod, ollamaProbeMod } = await loadDemoModule();
    ollamaProbeMod._setOllamaAvailableOverrideForTest(true);
    const deps = makeAuthLoginMockupDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate-ollama");
    expect(result).toEqual({ ok: true, vendor: "ollama" });

    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.ollama",
      "ollama",
    );
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      marketplace: { installedProviderIds: ["ollama"] },
      llm: {
        authMode: "login",
        provider: "ollama",
        vendors: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            model: "llama3.3",
          },
        },
      },
    });
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalledOnce();
    expect(deps.rewireReviewerAgent).toHaveBeenCalledOnce();
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalledOnce();
    // MAJOR — the patch set the ollama vendor baseUrl, and the ASRT shared
    // network union is derived from ALL vendor baseUrls (settings.ts invariant).
    // Any vendor baseUrl change must live-refresh the sandbox network config,
    // matching the settings:update / login-mockup choke points. A missing call
    // here would leave the sandbox denying egress to the just-configured local
    // Ollama endpoint until the next full restart.
    expect(deps.refreshSandboxNetworkConfig).toHaveBeenCalledOnce();
    expect(deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining("vendor=ollama"),
      }),
    );
  });

  it("leaves the ollama api-key gate satisfied so the login modal does not re-appear next boot", async () => {
    // critic MINOR — the `settings:has-api-key` gate that decides whether the
    // login modal re-mounts is exactly `getSecret("llm.apiKey.<vendor>") !==
    // null`. Locking it here guards the regression where activate-ollama
    // configured the vendor but never seeded the presence sentinel, so a
    // subsequent boot would re-prompt for login despite a working local model.
    const { demoMod, ollamaProbeMod } = await loadDemoModule();
    ollamaProbeMod._setOllamaAvailableOverrideForTest(true);
    const deps = makeAuthLoginMockupDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate-ollama");
    expect(result).toEqual({ ok: true, vendor: "ollama" });

    // Same predicate as the lvis:settings:has-api-key handler.
    expect(deps.settingsService.getSecret("llm.apiKey.ollama")).not.toBeNull();
  });

  it("rolls back secret, marketplace, and LLM state when activation persistence fails", async () => {
    const { demoMod, ollamaProbeMod } = await loadDemoModule();
    ollamaProbeMod._setOllamaAvailableOverrideForTest(true);
    const deps = makeAuthLoginMockupDeps();
    const prevLlm = {
      provider: "openai",
      vendors: { openai: { model: "gpt-4o" } },
      fallbackChain: [],
    };
    const prevMarketplace = {
      backend: "real-cloud",
      cloudBaseUrl: "https://marketplace.lvisai.xyz",
      cloudAllowPrivateNetwork: false,
      installedProviderIds: ["groq"],
      installedThemeBundleIds: [],
      installedLanguagePacks: [],
    };
    deps.settingsService.get.mockImplementation((key?: string) => {
      if (key === "marketplace") return prevMarketplace;
      return prevLlm;
    });
    deps.settingsService.patch.mockRejectedValueOnce(new Error("disk full"));
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate-ollama");

    expect(result).toEqual({ ok: false, error: "persist-failed" });
    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith("llm.apiKey.ollama");
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      marketplace: prevMarketplace,
    });
    expect(deps.settingsService.replaceLlm).toHaveBeenCalledWith(prevLlm);
    expect(deps.conversationLoop.refreshProvider).not.toHaveBeenCalled();
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("skips the sandbox network refresh when the probe fails closed", async () => {
    const { demoMod, ollamaProbeMod } = await loadDemoModule();
    ollamaProbeMod._setOllamaAvailableOverrideForTest(false);
    const deps = makeAuthLoginMockupDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate-ollama");
    expect(result).toEqual({ ok: false, error: "no-ollama" });
    expect(deps.refreshSandboxNetworkConfig).not.toHaveBeenCalled();
  });

  it("fails closed with no-ollama when the server disappeared since the status check", async () => {
    const { demoMod, ollamaProbeMod } = await loadDemoModule();
    // Simulates: renderer called status() when a server WAS there, then
    // the user stopped it before clicking the chip — the handler must
    // re-probe rather than trust the earlier status.
    ollamaProbeMod._setOllamaAvailableOverrideForTest(false);
    const deps = makeAuthLoginMockupDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:activate-ollama");
    expect(result).toEqual({ ok: false, error: "no-ollama" });
    expect(deps.settingsService.setSecret).not.toHaveBeenCalled();
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("rejects an untrusted sender frame without configuring anything", async () => {
    const { demoMod, ollamaProbeMod } = await loadDemoModule();
    ollamaProbeMod._setOllamaAvailableOverrideForTest(true);
    const deps = makeAuthLoginMockupDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invokeWithEvent(
      "lvis:demo:activate-ollama",
      { senderFrame: { url: "https://evil.example/app" } },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(deps.settingsService.setSecret).not.toHaveBeenCalled();
  });
});
