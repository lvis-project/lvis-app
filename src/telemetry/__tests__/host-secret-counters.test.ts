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
});
