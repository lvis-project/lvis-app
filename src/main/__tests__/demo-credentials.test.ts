/**
 * Unit tests for demo-credentials.ts — baseUrl / model / vertex env capture
 * and the getDemoVendorConfig() accessor (#893 full-config expansion).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  captureDemoCredentials,
  getDemoActiveVendor,
  getDemoVendorConfig,
  getDemoKey,
  isDemoEnabled,
  resetDemoCredentialsForTesting,
  type DemoVendorConfig,
} from "../demo-credentials.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  resetDemoCredentialsForTesting();
  // Restore env before each test so tests are independent.
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("captureDemoCredentials — baseUrl / model env vars", () => {
  it("captures LVIS_DEMO_BASEURL_<VENDOR> and exposes it via getDemoVendorConfig", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-azure-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY = "https://my-resource.openai.azure.com/";
    captureDemoCredentials();

    const config = getDemoVendorConfig("azure-foundry");
    expect(config).not.toBeNull();
    expect(config!.apiKey).toBe("sk-azure-key");
    expect(config!.baseUrl).toBe("https://my-resource.openai.azure.com/");
  });

  it("captures LVIS_DEMO_MODEL_<VENDOR> and exposes it via getDemoVendorConfig", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-openai-key";
    process.env.LVIS_DEMO_MODEL_OPENAI = "gpt-5";
    captureDemoCredentials();

    const config = getDemoVendorConfig("openai");
    expect(config).not.toBeNull();
    expect(config!.model).toBe("gpt-5");
  });

  it("returns null from getDemoVendorConfig when apiKey is absent even if other fields are present", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY = "https://some.endpoint.com/";
    // No LVIS_DEMO_KEY_AZURE_FOUNDRY set.
    captureDemoCredentials();

    expect(getDemoVendorConfig("azure-foundry")).toBeNull();
  });

  it("omits baseUrl and model from config when env vars are absent", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-openai-only";
    captureDemoCredentials();

    const config = getDemoVendorConfig("openai");
    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBeUndefined();
    expect(config!.model).toBeUndefined();
  });
});

describe("captureDemoCredentials — vertex-ai env vars", () => {
  it("captures LVIS_DEMO_VERTEX_PROJECT and LVIS_DEMO_VERTEX_LOCATION for vertex-ai", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_KEY_VERTEX_AI = "ignored-for-vertex";
    process.env.LVIS_DEMO_VERTEX_PROJECT = "my-gcp-project";
    process.env.LVIS_DEMO_VERTEX_LOCATION = "us-central1";
    captureDemoCredentials();

    const config = getDemoVendorConfig("vertex-ai");
    expect(config).not.toBeNull();
    expect(config!.vertexProject).toBe("my-gcp-project");
    expect(config!.vertexLocation).toBe("us-central1");
  });

  it("does not expose vertexProject/vertexLocation on non-vertex-ai vendors", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-openai-key";
    process.env.LVIS_DEMO_VERTEX_PROJECT = "my-gcp-project";
    captureDemoCredentials();

    const config = getDemoVendorConfig("openai");
    expect(config).not.toBeNull();
    expect(config!.vertexProject).toBeUndefined();
    expect(config!.vertexLocation).toBeUndefined();
  });

  it("omits vertexProject and vertexLocation when env vars are absent", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_KEY_VERTEX_AI = "ignored";
    // No LVIS_DEMO_VERTEX_PROJECT or LVIS_DEMO_VERTEX_LOCATION.
    captureDemoCredentials();

    const config = getDemoVendorConfig("vertex-ai");
    expect(config).not.toBeNull();
    expect(config!.vertexProject).toBeUndefined();
    expect(config!.vertexLocation).toBeUndefined();
  });
});

describe("captureDemoCredentials — LVIS_DEMO_VENDOR (#893 top-level)", () => {
  it("captures LVIS_DEMO_VENDOR and exposes it via getDemoActiveVendor", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_VENDOR = "claude";
    captureDemoCredentials();
    expect(getDemoActiveVendor()).toBe("claude");
  });

  // Path 2 hotfix (2026-05-19): the default fallback vendor changed from
  // "openai" to "azure-foundry" so the LGE internal demo loop activates
  // by default. The two tests below assert the new default.
  it("defaults to azure-foundry when LVIS_DEMO_VENDOR is absent", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    delete process.env.LVIS_DEMO_VENDOR;
    captureDemoCredentials();
    expect(getDemoActiveVendor()).toBe("azure-foundry");
  });

  it("falls back to azure-foundry when LVIS_DEMO_VENDOR is not a known vendor", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_VENDOR = "not-a-vendor";
    captureDemoCredentials();
    expect(getDemoActiveVendor()).toBe("azure-foundry");
  });

  it("accepts every known LLM vendor", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    captureDemoCredentials();
    expect(getDemoActiveVendor()).toBe("azure-foundry");
  });
});

describe("captureDemoCredentials — idempotency and backward compat", () => {
  it("is idempotent — second call after env mutation has no effect", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_KEY_OPENAI = "first-key";
    captureDemoCredentials();

    // Mutate env — should not affect already-captured state.
    process.env.LVIS_DEMO_KEY_OPENAI = "second-key";
    captureDemoCredentials();

    expect(getDemoKey("openai")).toBe("first-key");
  });

  it("getDemoKey still works alongside getDemoVendorConfig (backward compat)", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_KEY_CLAUDE = "sk-ant-demo";
    captureDemoCredentials();

    expect(getDemoKey("claude")).toBe("sk-ant-demo");
    const config = getDemoVendorConfig("claude");
    expect(config?.apiKey).toBe("sk-ant-demo");
  });

  it("isDemoEnabled reflects LVIS_DEMO_ENABLED=1", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    captureDemoCredentials();
    expect(isDemoEnabled()).toBe(true);
  });

  it("isDemoEnabled is false when LVIS_DEMO_ENABLED is absent", () => {
    delete process.env.LVIS_DEMO_ENABLED;
    captureDemoCredentials();
    expect(isDemoEnabled()).toBe(false);
  });

  it("resetDemoCredentialsForTesting clears all captured state", () => {
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-openai-key";
    process.env.LVIS_DEMO_BASEURL_OPENAI = "https://proxy.example.com/";
    captureDemoCredentials();

    resetDemoCredentialsForTesting();

    // After reset, a fresh capture picks up current env (still set above).
    captureDemoCredentials();
    const config = getDemoVendorConfig("openai");
    expect(config?.baseUrl).toBe("https://proxy.example.com/");
  });
});
