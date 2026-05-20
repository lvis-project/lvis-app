/**
 * Demo activation IPC handler tests.
 *
 * Verifies the full round-trip:
 *   1. Renderer paste of a valid activation string → decrypt → persist →
 *      env inject → recapture of demo credentials.
 *   2. Invalid code / tampered ciphertext → `invalid-code` error.
 *   3. Payload missing `LVIS_DEMO_VENDOR` → `no-vendor` error.
 *   4. Unknown vendor / invalid Azure Foundry endpoint → fail closed before
 *      persistence or env mutation.
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

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(
    fn(
      { frameId: 0, processId: 0, frame: { url: "lvis://app" } } as never,
      ...args,
    ),
  );
}

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
  "",
].join("\n");

const SAMPLE_ENV_ENDPOINT_ALIAS = [
  "LVIS_DEMO_VENDOR=azure-foundry",
  "LVIS_DEMO_KEY_AZURE_FOUNDRY=sk-activated-key",
  "LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY=https://endpoint.openai.azure.com/openai/v1/",
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
  return { codec, credsMod, demoMod };
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
  it("reports captured demo activation even after LVIS_DEMO env is scrubbed", async () => {
    const { credsMod, demoMod } = await loadDemoModule();
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-activated-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY =
      "https://example.openai.azure.com/openai/v1/";
    credsMod.captureDemoCredentials();
    delete process.env.LVIS_DEMO_VENDOR;
    delete process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY;
    delete process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY;

    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:status");
    expect(result).toEqual({
      ok: true,
      activated: true,
      vendor: "azure-foundry",
    });
  });

  it("reports inactive when no demo credentials were captured at boot", async () => {
    const { demoMod } = await loadDemoModule();
    const deps = makeDeps();
    demoMod.registerDemoHandlers(deps as never);

    const result = await invoke("lvis:demo:status");
    expect(result).toEqual({ ok: true, activated: false, vendor: null });
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
