/**
 * Unit tests for compareSemver — the version-precedence comparator used by
 * ToolRegistry.listVersions (sort) and pickLatest (reduce to newest).
 *
 * Regression focus: pre-release precedence. The previous implementation split
 * on /[.+-]/ and lumped the pre-release tag into the numeric-segment array, so
 * `1.0.0` vs `1.0.0-beta` compared "0"(default) vs "beta" lexically and wrongly
 * returned `1.0.0 < 1.0.0-beta` — i.e. "pick latest" preferred the beta over
 * the final release.
 */
import { describe, it, expect } from "vitest";
import { compareSemver } from "../registry.js";

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe("compareSemver", () => {
  it("orders plain numeric cores", () => {
    expect(sign(compareSemver("1.0.0", "2.0.0"))).toBe(-1);
    expect(sign(compareSemver("1.2.0", "1.10.0"))).toBe(-1); // numeric, not lexical
    expect(sign(compareSemver("1.0.1", "1.0.0"))).toBe(1);
    expect(sign(compareSemver("1.0.0", "1.0.0"))).toBe(0);
  });

  it("ranks a release ABOVE its own pre-release (the bug)", () => {
    expect(sign(compareSemver("1.0.0", "1.0.0-beta"))).toBe(1);
    expect(sign(compareSemver("1.0.0-beta", "1.0.0"))).toBe(-1);
    expect(sign(compareSemver("2.0.0-rc.1", "2.0.0"))).toBe(-1);
  });

  it("a pre-release of a higher core still beats a lower release", () => {
    expect(sign(compareSemver("2.0.0-alpha", "1.9.9"))).toBe(1);
  });

  it("orders pre-release identifiers per semver precedence", () => {
    expect(sign(compareSemver("1.0.0-alpha", "1.0.0-beta"))).toBe(-1); // lexical
    expect(sign(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"))).toBe(-1); // fewer fields lower
    expect(sign(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2"))).toBe(-1); // numeric
    expect(sign(compareSemver("1.0.0-rc.2", "1.0.0-rc.10"))).toBe(-1); // numeric, not lexical
    expect(sign(compareSemver("1.0.0-1", "1.0.0-alpha"))).toBe(-1); // numeric < alphanumeric
    expect(sign(compareSemver("1.0.0-beta", "1.0.0-beta"))).toBe(0);
  });

  it("ignores build metadata", () => {
    expect(sign(compareSemver("1.0.0+build.9", "1.0.0+build.1"))).toBe(0);
    expect(sign(compareSemver("1.0.0-beta+exp", "1.0.0-beta"))).toBe(0);
  });

  it("sorting a mixed list picks the final release as newest", () => {
    const versions = ["1.0.0-alpha", "1.0.0", "1.0.0-beta", "0.9.0", "1.0.0-rc.1"];
    const sorted = [...versions].sort((a, b) => compareSemver(a, b));
    expect(sorted[sorted.length - 1]).toBe("1.0.0"); // newest
    expect(sorted[0]).toBe("0.9.0"); // oldest
  });
});
