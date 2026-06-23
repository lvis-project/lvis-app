/**
 * Unit tests for the shared semver comparator + the plugin↔app minimum-version
 * gate predicate (`appVersionSatisfiesMin`).
 */
import { describe, it, expect } from "vitest";
import { compareSemver, appVersionSatisfiesMin } from "../semver-compare.js";

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe("compareSemver", () => {
  it("orders plain numeric cores numerically (not lexically)", () => {
    expect(sign(compareSemver("1.0.0", "2.0.0"))).toBe(-1);
    expect(sign(compareSemver("1.2.0", "1.10.0"))).toBe(-1);
    expect(sign(compareSemver("1.0.1", "1.0.0"))).toBe(1);
    expect(sign(compareSemver("1.0.0", "1.0.0"))).toBe(0);
  });

  it("ranks a release above its own pre-release", () => {
    expect(sign(compareSemver("1.0.0", "1.0.0-beta"))).toBe(1);
    expect(sign(compareSemver("2.0.0-rc.1", "2.0.0"))).toBe(-1);
  });
});

describe("appVersionSatisfiesMin — plugin↔app gate", () => {
  it("allows when app version > min", () => {
    expect(appVersionSatisfiesMin("1.5.0", "1.4.0")).toBe(true);
    expect(appVersionSatisfiesMin("2.0.0", "1.9.9")).toBe(true);
    expect(appVersionSatisfiesMin("1.4.10", "1.4.2")).toBe(true);
  });

  it("allows when app version == min (>= semantics)", () => {
    expect(appVersionSatisfiesMin("1.4.0", "1.4.0")).toBe(true);
  });

  it("blocks when app version < min", () => {
    expect(appVersionSatisfiesMin("1.3.0", "1.4.0")).toBe(false);
    expect(appVersionSatisfiesMin("1.4.1", "1.4.2")).toBe(false);
    expect(appVersionSatisfiesMin("0.9.0", "1.0.0")).toBe(false);
  });

  it("fails closed on an unresolvable app version (the 'unknown' sentinel)", () => {
    expect(appVersionSatisfiesMin("unknown", "1.0.0")).toBe(false);
    expect(appVersionSatisfiesMin("", "1.0.0")).toBe(false);
  });

  it("fails closed when min is missing/empty", () => {
    expect(appVersionSatisfiesMin("1.0.0", "")).toBe(false);
  });
});
