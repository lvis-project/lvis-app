/**
 * Track A pre-Phase-2 — `MockMarketplaceFetcher` packaged-build gate.
 *
 * Locks in security-reviewer H-1: the local `plugins/marketplace.json` is
 * user-writable and cannot serve as a trust anchor. Packaged builds must
 * fail closed when any code path tries to instantiate the mock fetcher.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { MockMarketplaceFetcher } from "../marketplace.js";

describe("MockMarketplaceFetcher — packaged-build gate", () => {
  beforeEach(() => {
    _resetForTest();
  });
  afterEach(() => {
    _resetForTest();
  });

  it("constructor throws when boot has marked the build as packaged", () => {
    setIsPackaged(true);
    expect(() => new MockMarketplaceFetcher("/tmp/marketplace.json")).toThrow(
      /MockMarketplaceFetcher is dev-only/,
    );
  });

  it("constructor throws by default before boot configures the gate", () => {
    // Default state is fail-closed (isPackagedCached = true). Any module that
    // instantiates the mock before boot wiring also fails — by design.
    expect(() => new MockMarketplaceFetcher("/tmp/marketplace.json")).toThrow(
      /MockMarketplaceFetcher is dev-only/,
    );
  });

  it("constructor succeeds in unpackaged dev/test builds", () => {
    setIsPackaged(false);
    expect(() => new MockMarketplaceFetcher("/tmp/marketplace.json")).not.toThrow();
  });

  it("error message does not leak the marketplace path or other secrets", () => {
    setIsPackaged(true);
    let caught: Error | null = null;
    try {
      new MockMarketplaceFetcher("/secret/path/marketplace.json");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).not.toContain("/secret/path");
  });
});
