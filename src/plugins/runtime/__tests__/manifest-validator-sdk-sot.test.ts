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
    // #885 v6.1.0 — the accept-probes must PASS (return true) and the three
    // negative-strictness fixtures must be REJECTED (return false), else
    // buildManifestValidator fails closed as "too permissive".
    const sdkValidator = vi.fn(
      (manifest: { id?: string }) =>
        manifest.id !== "removed-field-plugin"
        && manifest.id !== "empty-visibility-plugin"
        && manifest.id !== "ui-action-kind-plugin",
    );
    const compileManifestValidator = vi.fn(() => sdkValidator);

    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator,
    }));

    const { buildManifestValidator } = await import("../manifest-validation.js");
    const validator = await buildManifestValidator();

    expect(compileManifestValidator).toHaveBeenCalledTimes(1);
    expect(validator).toBe(sdkValidator);
    // #885 Phase R — the workerId/category-less legacy toolSchemas accept-probes
    // were removed; now 3 accept-probes (networkAccess.allowPrivateNetworks,
    // marketplace-provider secret, pure MCP Tool[]) + 3 negative-strictness guards
    // (removed field / empty visibility / removed ui[].kind="action", added v6.1.0).
    expect(sdkValidator).toHaveBeenCalledTimes(6);
  });

  it("#885 v6.1.0 — fails closed on a v6.0.0-style permissive validator (still accepts ui[].kind=\"action\") and passes once the SDK closes the gap", async () => {
    // Interim-permissiveness window (cluster-review MINOR #1): a v6.0.0-style
    // SDK schema already rejects the older two strictness fixtures but has not
    // yet closed the ui[].kind="action" gap — buildManifestValidator must still
    // fail closed as "too permissive" until the SDK schema catches up.
    const permissiveValidator = vi.fn(
      (manifest: { id?: string }) =>
        manifest.id !== "removed-field-plugin" && manifest.id !== "empty-visibility-plugin",
    );
    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator: () => permissiveValidator,
    }));

    const { buildManifestValidator: buildWithPermissiveSdk } = await import("../manifest-validation.js");
    await expect(buildWithPermissiveSdk()).rejects.toThrow(
      /a ui extension declaring the removed kind:"action" must be rejected/,
    );

    vi.resetModules();
    vi.doUnmock("@lvis/plugin-sdk");

    // The real v6.1.0-strict SDK closes the gap: all three strictness fixtures
    // are rejected, so buildManifestValidator returns the SDK validator unchanged.
    const strictValidator = vi.fn(
      (manifest: { id?: string }) =>
        manifest.id !== "removed-field-plugin"
        && manifest.id !== "empty-visibility-plugin"
        && manifest.id !== "ui-action-kind-plugin",
    );
    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator: () => strictValidator,
    }));

    const { buildManifestValidator: buildWithStrictSdk } = await import("../manifest-validation.js");
    const validator = await buildWithStrictSdk();
    expect(validator).toBe(strictValidator);
  });

  it("#885 v6 — fails closed when the SDK helper rejects the pure MCP Tool[] object", async () => {
    const sdkValidator = vi.fn((manifest: { id?: string }) => manifest.id !== "pure-tool-plugin");
    const compileManifestValidator = vi.fn(() => sdkValidator);

    vi.doMock("@lvis/plugin-sdk", () => ({ compileManifestValidator }));

    const { buildManifestValidator } = await import("../manifest-validation.js");
    await expect(buildManifestValidator()).rejects.toThrow(/pure MCP Tool\[\] object/);
  });

  it("#885 v6 — fails closed when the SDK helper is too permissive (accepts a removed field / empty visibility)", async () => {
    // Accepts EVERYTHING, including the two negative-strictness fixtures →
    // the strictness guards must trip and reject with a 'too permissive' error.
    const sdkValidator = vi.fn(() => true);
    const compileManifestValidator = vi.fn(() => sdkValidator);

    vi.doMock("@lvis/plugin-sdk", () => ({ compileManifestValidator }));

    const { buildManifestValidator } = await import("../manifest-validation.js");
    await expect(buildManifestValidator()).rejects.toThrow(/too permissive/);
  });

  // NOTE (#885 Phase R): the "rejects toolSchema worker bindings" and
  // "rejects category-less tool schemas" probes were removed — those legacy
  // `toolSchemas`-map fields no longer exist, so buildManifestValidator no longer
  // probes for them. Their tests were removed with the probes.

  it("fails closed when the SDK helper rejects private-network manifests", async () => {
    const sdkValidator = vi.fn((manifest: { id?: string }) => manifest.id !== "private-network-plugin");
    const compileManifestValidator = vi.fn(() => sdkValidator);

    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator,
    }));

    const { buildManifestValidator } = await import("../manifest-validation.js");

    await expect(buildManifestValidator()).rejects.toThrow(/networkAccess\.allowPrivateNetworks/);
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
