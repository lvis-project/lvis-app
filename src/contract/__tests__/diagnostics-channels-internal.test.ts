/**
 * #1499 E2 — the diagnostics-bundle / production-log-tail / crash-list channels
 * MUST stay INTERNAL. A diagnostics bundle serializes redacted host state
 * (settings, audit trail, logs, crash-dump metadata) to a user-chosen file, and
 * the log tail exposes production log lines — no external origin (local-api /
 * cli / plugin frame) may ever reach them. Asserts the fail-closed
 * classification:
 *   - none of the channels appear in PUBLIC_CHANNELS,
 *   - isPublicChannel() is false for every one,
 *   - none leak into EXTERNAL_MUTATION_CHANNELS or CHANNEL_GESTURE.
 */
import { describe, it, expect } from "vitest";
import {
  CHANNELS,
  PUBLIC_CHANNELS,
  EXTERNAL_MUTATION_CHANNELS,
  CHANNEL_GESTURE,
  isPublicChannel,
} from "../app-contract.js";

const diagnosticsChannels = [
  ...Object.values(CHANNELS.diagnostics),
  ...Object.values(CHANNELS.logs),
];

describe("#1499 diagnostics/logs channels are internal (fail-closed)", () => {
  it("defines the expected byte-identical channel strings", () => {
    expect(CHANNELS.diagnostics).toEqual({
      export: "lvis:diagnostics:export",
      crashList: "lvis:diagnostics:crash-list",
    });
    expect(CHANNELS.logs).toEqual({ tail: "lvis:logs:tail" });
  });

  it("no diagnostics/logs channel leaks into PUBLIC_CHANNELS", () => {
    const publicSet = new Set<string>(PUBLIC_CHANNELS);
    for (const channel of diagnosticsChannels) {
      expect(publicSet.has(channel), `leaked public: ${channel}`).toBe(false);
      expect(isPublicChannel(channel), channel).toBe(false);
    }
  });

  it("no diagnostics/logs channel is an external-mutation or gesture-gated channel", () => {
    const extSet = new Set<string>(EXTERNAL_MUTATION_CHANNELS);
    for (const channel of diagnosticsChannels) {
      expect(extSet.has(channel), `leaked external-mutation: ${channel}`).toBe(false);
      expect(CHANNEL_GESTURE[channel], `gesture-classified: ${channel}`).toBeUndefined();
    }
  });
});
