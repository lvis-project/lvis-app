/**
 * Unit test for the SDK → host-local AJV fallback in
 * `buildManifestValidator()` (PR #894 review B5).
 *
 * The SDK may or may not export `compileManifestValidator()` depending on
 * its version. When the helper IS exported, the host MUST delegate so
 * AJV options stay in lockstep. When it is NOT exported, the host MUST:
 *   1. emit a single warn explaining the drift so operators can update,
 *   2. fall back to the local AJV compile path against the SDK schema
 *      shipped under `node_modules/@lvis/plugin-sdk/schemas/...`,
 *   3. still return a working `ValidateFunction` so plugin loading isn't
 *      blocked on an SDK packaging quirk.
 *
 * The fallback path is the production reality for every SDK version that
 * shipped before the `compileManifestValidator` helper. Cycle 3 promotes
 * the drift signal from "silent" to "explicit warn", so this test pins
 * both the warn AND the working-validator return shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("buildManifestValidator — SDK fallback (PR #894 B5)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@lvis/plugin-sdk");
  });

  it("emits a warn AND returns a working validator when the SDK does not export compileManifestValidator", async () => {
    // Mock the SDK without `compileManifestValidator` to mirror every
    // SDK build pre-helper. The schemas/ JSON file is loaded via
    // `createRequire(import.meta.url).resolve(...)` from the real
    // installed SDK directory, so we DO NOT need to mock that.
    vi.doMock("@lvis/plugin-sdk", () => ({
      // empty — no compileManifestValidator() export
    }));

    const warnSpy = vi.fn();
    vi.doMock("../../../lib/logger.js", () => ({
      createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnSpy,
        error: vi.fn(),
      }),
    }));

    const { buildManifestValidator } = await import("../manifest-validation.js");
    const validator = await buildManifestValidator();
    expect(typeof validator).toBe("function");

    // The fallback path warns once with the drift signal naming the
    // missing helper. Subsequent SDK migrations should keep this exact
    // substring so operator log greps survive.
    const warnedWithDriftSignal = warnSpy.mock.calls.some((call) =>
      typeof call[0] === "string" && call[0].includes("compileManifestValidator"),
    );
    expect(warnedWithDriftSignal).toBe(true);

    // Smoke-test the returned validator on a minimal valid manifest so a
    // future schema-load regression cannot pass this test on a broken
    // AJV compile. The SDK id pattern is kebab-case (`^[a-z][a-z0-9-]*$`)
    // so `com.test.b5` would be rejected — use the canonical sample
    // shape published in the SDK manifest description.
    const validManifest = {
      id: "b5-fallback-plugin",
      name: "B5",
      version: "1.0.0",
      entry: "dist/index.js",
      tools: ["b5_ping"],
      description: "B5 fallback test plugin",
      publisher: "Test",
    };
    expect(validator(validManifest)).toBe(true);

  });

  it("uses the SDK helper when it IS exported and already accepts host compatibility probes", async () => {
    // Build a minimal AJV-shaped helper so the host's `typeof === 'function'`
    // gate accepts it. The returned function is the production code path
    // — we assert the helper was invoked, not the warn.
    const sdkValidator = vi.fn(() => true);
    const compileManifestValidator = vi.fn(() => sdkValidator);

    vi.doMock("@lvis/plugin-sdk", () => ({
      compileManifestValidator,
    }));

    const warnSpy = vi.fn();
    vi.doMock("../../../lib/logger.js", () => ({
      createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnSpy,
        error: vi.fn(),
      }),
    }));

    const { buildManifestValidator } = await import("../manifest-validation.js");
    const validator = await buildManifestValidator();

    expect(compileManifestValidator).toHaveBeenCalledTimes(1);
    expect(validator({})).toBe(true);
    // Two calls are capability probes (workerId + marketplace preset host
    // secret), and the third is this smoke call.
    expect(sdkValidator).toHaveBeenCalledTimes(3);
    // No missing-helper fallback warn — SDK helper is present.
    const warnedWithMissingHelperSignal = warnSpy.mock.calls.some((call) =>
      typeof call[0] === "string" && call[0].includes("does not export compileManifestValidator"),
    );
    expect(warnedWithMissingHelperSignal).toBe(false);
    const warnedWithWorkerCompatSignal = warnSpy.mock.calls.some((call) =>
      typeof call[0] === "string" && call[0].includes("toolSchemas.*.workerId"),
    );
    expect(warnedWithWorkerCompatSignal).toBe(false);
  });
});
