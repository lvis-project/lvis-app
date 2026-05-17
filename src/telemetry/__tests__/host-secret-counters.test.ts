/**
 * #893 — Host-secret counter unit tests.
 *
 * Covers monotonic increment, per-(plugin, keyPrefix) isolation, and the
 * test-only reset helper.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  incrementHostSecretCounter,
  getHostSecretCounter,
  resetHostSecretCountersForTesting,
  sanitizeKeyPrefix,
} from "../host-secret-counters.js";

describe("host-secret-counters (#893)", () => {
  beforeEach(() => {
    resetHostSecretCountersForTesting();
  });

  it("starts every counter at zero", () => {
    expect(getHostSecretCounter("hostSecret_read", "p", "llm")).toBe(0);
    expect(getHostSecretCounter("hostSecret_denied", "p", "llm")).toBe(0);
  });

  it("increments the specific (event, pluginId, keyPrefix) tuple", () => {
    incrementHostSecretCounter("hostSecret_read", "plugin.a", "llm");
    incrementHostSecretCounter("hostSecret_read", "plugin.a", "llm");
    incrementHostSecretCounter("hostSecret_read", "plugin.a", "llm");
    expect(getHostSecretCounter("hostSecret_read", "plugin.a", "llm")).toBe(3);
  });

  it("isolates (event, pluginId, keyPrefix) tuples from each other", () => {
    incrementHostSecretCounter("hostSecret_read", "plugin.a", "llm");
    incrementHostSecretCounter("hostSecret_denied", "plugin.a", "llm");
    incrementHostSecretCounter("hostSecret_read", "plugin.b", "llm");
    incrementHostSecretCounter("hostSecret_read", "plugin.a", "marketplace");
    expect(getHostSecretCounter("hostSecret_read", "plugin.a", "llm")).toBe(1);
    expect(getHostSecretCounter("hostSecret_denied", "plugin.a", "llm")).toBe(1);
    expect(getHostSecretCounter("hostSecret_read", "plugin.b", "llm")).toBe(1);
    expect(getHostSecretCounter("hostSecret_read", "plugin.a", "marketplace")).toBe(1);
  });

  it("the test-only reset clears every counter", () => {
    incrementHostSecretCounter("hostSecret_read", "plugin.a", "llm");
    incrementHostSecretCounter("hostSecret_denied", "plugin.b", "marketplace");
    resetHostSecretCountersForTesting();
    expect(getHostSecretCounter("hostSecret_read", "plugin.a", "llm")).toBe(0);
    expect(getHostSecretCounter("hostSecret_denied", "plugin.b", "marketplace")).toBe(0);
  });

  // PR #894 review B7 — sanitizeKeyPrefix DoS guard
  describe("sanitizeKeyPrefix (B7 DoS guard)", () => {
    it("returns the bare prefix for known namespaces", () => {
      expect(sanitizeKeyPrefix("llm.apiKey.openai")).toBe("llm");
      expect(sanitizeKeyPrefix("plugin.foo.bar")).toBe("plugin");
      expect(sanitizeKeyPrefix("marketplace.apiKey")).toBe("marketplace");
      expect(sanitizeKeyPrefix("web.token")).toBe("web");
    });

    it("folds unknown prefixes into the `other` bucket", () => {
      expect(sanitizeKeyPrefix("attacker.x")).toBe("other");
      expect(sanitizeKeyPrefix("AAAAAAAAAA")).toBe("other");
      expect(sanitizeKeyPrefix("")).toBe("other");
      expect(sanitizeKeyPrefix(".")).toBe("other");
    });

    it("keeps the counter map cardinality bounded under attacker probing", () => {
      for (let i = 0; i < 1000; i += 1) {
        incrementHostSecretCounter("hostSecret_denied", "evil.plugin", sanitizeKeyPrefix(`attacker${i}.x`));
      }
      // 1000 unique attacker prefixes collapse to one `other` bucket
      expect(getHostSecretCounter("hostSecret_denied", "evil.plugin", "other")).toBe(1000);
      expect(getHostSecretCounter("hostSecret_denied", "evil.plugin", "attacker0")).toBe(0);
    });
  });
});
