/**
 * #955 follow-up — `runTier3Then4` admin-install bypass.
 *
 * `installPolicy: "admin"` MUST skip the Tier-3 signed whitelist registry
 * ACL (admin install already represents an explicit elevated grant) while
 * still enforcing Tier-4 active-vendor cross-check. Plain `"user"` installs
 * keep the original behaviour — both Tier-3 and Tier-4 apply in order.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { runTier3Then4 } from "../tier-order.js";
import { whitelistRegistry } from "../whitelist-registry.js";

describe("runTier3Then4 — admin-install bypass (#955)", () => {
  beforeEach(() => {
    // Leave the registry uninitialized — its default state is
    // `no-cache`, which makes `isAllowed` return a deny with reason
    // `not-whitelisted`. That is the exact production failure mode
    // admin-install is meant to bypass.
    whitelistRegistry.resetForTesting();
  });

  it("denies a user-install plugin when registry has no grant", () => {
    const outcome = runTier3Then4({
      pluginId: "meeting",
      key: "llm.apiKey.openai",
      manifestSha256: "a".repeat(64),
      vendor: "openai",
      activeProvider: "openai",
      installPolicy: "user",
    });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind === "deny") {
      expect(outcome.tier).toBe("tier-3");
    }
  });

  it("denies a user-install plugin with no installPolicy field (back-compat)", () => {
    const outcome = runTier3Then4({
      pluginId: "meeting",
      key: "llm.apiKey.openai",
      manifestSha256: "a".repeat(64),
      vendor: "openai",
      activeProvider: "openai",
    });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind === "deny") {
      expect(outcome.tier).toBe("tier-3");
    }
  });

  it("allows an admin-install plugin even when registry would deny", () => {
    const outcome = runTier3Then4({
      pluginId: "meeting",
      key: "llm.apiKey.openai",
      manifestSha256: "a".repeat(64),
      vendor: "openai",
      activeProvider: "openai",
      installPolicy: "admin",
    });
    expect(outcome).toEqual({ kind: "allow" });
  });

  it("denies an admin-install plugin on vendor mismatch (Tier-4 preserved)", () => {
    const outcome = runTier3Then4({
      pluginId: "meeting",
      key: "llm.apiKey.openai",
      manifestSha256: "a".repeat(64),
      vendor: "openai",
      activeProvider: "claude",
      installPolicy: "admin",
    });
    expect(outcome.kind).toBe("deny");
    if (outcome.kind === "deny") {
      expect(outcome.tier).toBe("tier-4");
      expect(outcome.reason).toBe("vendor-mismatch");
    }
  });
});
