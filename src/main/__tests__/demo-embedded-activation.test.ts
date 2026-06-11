import { describe, it, expect, afterEach } from "vitest";
import {
  getEmbeddedActivationCode,
  _setEmbeddedActivationCodeForTest,
} from "../demo-embedded-activation.js";

afterEach(() => {
  _setEmbeddedActivationCodeForTest(undefined);
});

describe("getEmbeddedActivationCode", () => {
  it("returns null when the bundle define is absent (vitest/tsc context)", () => {
    // This test file runs the TypeScript source without the esbuild
    // define, so the compile-time constant is unresolved — the typeof
    // probe must land on null instead of throwing a ReferenceError.
    expect(getEmbeddedActivationCode()).toBe(null);
  });

  it("returns the override string when a build embeds a key", () => {
    _setEmbeddedActivationCodeForTest("LVIS-DEMO:v1:abc");
    expect(getEmbeddedActivationCode()).toBe("LVIS-DEMO:v1:abc");
  });

  it("treats a null override as a build without an embedded key", () => {
    _setEmbeddedActivationCodeForTest(null);
    expect(getEmbeddedActivationCode()).toBe(null);
  });

  it("normalizes empty and whitespace-only codes to null", () => {
    _setEmbeddedActivationCodeForTest("");
    expect(getEmbeddedActivationCode()).toBe(null);
    _setEmbeddedActivationCodeForTest("   \n");
    expect(getEmbeddedActivationCode()).toBe(null);
  });

  it("trims surrounding whitespace from an embedded code", () => {
    _setEmbeddedActivationCodeForTest("  LVIS-DEMO:v1:abc\n");
    expect(getEmbeddedActivationCode()).toBe("LVIS-DEMO:v1:abc");
  });
});
