/**
 * #1444 — the interactive PTY terminal channels MUST stay INTERNAL. A terminal
 * spawns arbitrary user commands, so no external origin (local-api / cli /
 * plugin frame) may ever reach them. Asserts the fail-closed classification:
 *   - none of the terminal channels appear in PUBLIC_CHANNELS,
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

const terminalChannels = Object.values(CHANNELS.terminal);

describe("#1444 terminal channels are internal (fail-closed)", () => {
  it("defines the expected byte-identical channel strings", () => {
    expect(CHANNELS.terminal).toEqual({
      spawn: "lvis:terminal:spawn",
      input: "lvis:terminal:input",
      resize: "lvis:terminal:resize",
      kill: "lvis:terminal:kill",
      data: "lvis:terminal:data",
      exit: "lvis:terminal:exit",
    });
  });

  it("no terminal channel leaks into PUBLIC_CHANNELS", () => {
    const publicSet = new Set<string>(PUBLIC_CHANNELS);
    for (const channel of terminalChannels) {
      expect(publicSet.has(channel), `leaked public: ${channel}`).toBe(false);
      expect(isPublicChannel(channel), channel).toBe(false);
    }
  });

  it("no terminal channel is an external-mutation or gesture-gated channel", () => {
    const extSet = new Set<string>(EXTERNAL_MUTATION_CHANNELS);
    for (const channel of terminalChannels) {
      expect(extSet.has(channel), `leaked external-mutation: ${channel}`).toBe(false);
      expect(CHANNEL_GESTURE[channel], `gesture-classified: ${channel}`).toBeUndefined();
    }
  });
});
