/**
 * Manifest validator SOT guard.
 *
 * The host must use the SDK's `compileManifestValidator()` directly. App-local
 * schema mutation is not allowed: if the SDK helper is absent or rejects fields
 * the host requires, plugin loading fails closed until the SDK pin is fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("buildManifestValidator — SDK schema SOT", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@lvis/plugin-sdk");
  });

  it("fails closed when the SDK does not export compileManifestValidator", async () => {
    vi.doMock("@lvis/plugin-sdk", () => ({ compileManifestValidator: undefined }));

    const { buildManifestValidator } = await import("../manifest-validation.js");

    await expect(buildManifestValidator()).rejects.toThrow(
      /does not export compileManifestValidator/,
    );
  });

  it("preserves non-Error SDK import failure messages", async () => {
    const { formatUnknownErrorMessage } = await import("../manifest-validation.js");

    expect(formatUnknownErrorMessage(new Error("sdk boom"))).toBe("sdk boom");
    expect(formatUnknownErrorMessage("sdk import failed")).toBe("sdk import failed");
    expect(formatUnknownErrorMessage({ code: "ERR_MODULE_NOT_FOUND", module: "@lvis/plugin-sdk" })).toBe(
      '{"code":"ERR_MODULE_NOT_FOUND","module":"@lvis/plugin-sdk"}',
    );
    expect(formatUnknownErrorMessage(null)).toBe("null");
  });

  it("wraps SDK helper compile failures with manifest-validator context", async () => {
    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator: () => {
        throw { code: "AJV_SCHEMA_ERROR" };
      },
    }));

    const { buildManifestValidator } = await import("../manifest-validation.js");

    await expect(buildManifestValidator()).rejects.toThrow(
      /SDK plugin manifest validator failed to compile: \{"code":"AJV_SCHEMA_ERROR"\}/,
    );
  });

  it("uses the SDK helper unchanged when native host-required probes pass", async () => {
    const sdkValidator = vi.fn(() => true);
    const compileManifestValidator = vi.fn(() => sdkValidator);

    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator,
    }));

    const { buildManifestValidator } = await import("../manifest-validation.js");
    const validator = await buildManifestValidator();

    expect(compileManifestValidator).toHaveBeenCalledTimes(1);
    expect(validator).toBe(sdkValidator);
    expect(sdkValidator).toHaveBeenCalledTimes(4);
  });

  it("fails closed when the SDK helper rejects toolSchema worker bindings", async () => {
    const sdkValidator = vi.fn((manifest: { id?: string }) => manifest.id !== "worker-plugin");
    const compileManifestValidator = vi.fn(() => sdkValidator);

    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator,
    }));

    const { buildManifestValidator } = await import("../manifest-validation.js");

    await expect(buildManifestValidator()).rejects.toThrow(/toolSchemas\.\*\.workerId/);
  });

  it("fails closed when the SDK helper rejects private-network manifests", async () => {
    const sdkValidator = vi.fn((manifest: { id?: string }) => manifest.id !== "private-network-plugin");
    const compileManifestValidator = vi.fn(() => sdkValidator);

    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator,
    }));

    const { buildManifestValidator } = await import("../manifest-validation.js");

    await expect(buildManifestValidator()).rejects.toThrow(/networkAccess\.allowPrivateNetworks/);
  });

  it("fails closed when the SDK helper rejects category-less tool schemas", async () => {
    const sdkValidator = vi.fn((manifest: { id?: string }) => manifest.id !== "categoryless-tool-plugin");
    const compileManifestValidator = vi.fn(() => sdkValidator);

    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator,
    }));

    const { buildManifestValidator } = await import("../manifest-validation.js");

    await expect(buildManifestValidator()).rejects.toThrow(/category-less toolSchemas/);
  });

  it("fails closed when the SDK helper rejects marketplace-provider host secrets", async () => {
    const sdkValidator = vi.fn((manifest: { id?: string }) => manifest.id !== "marketplace-provider-secret");
    const compileManifestValidator = vi.fn(() => sdkValidator);

    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator,
    }));

    const { buildManifestValidator } = await import("../manifest-validation.js");

    await expect(buildManifestValidator()).rejects.toThrow(/llm\.marketplaceProvider\.<presetId>\.apiKey/);
  });
});
