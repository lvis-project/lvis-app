/**
 * Side-chat channels MUST stay INTERNAL. Side chat drives a second
 * ConversationLoop that runs arbitrary tools, so no external origin (local-api /
 * cli / plugin frame) may ever reach them. Asserts the fail-closed
 * classification:
 *   - none of the sidechat channels appear in PUBLIC_CHANNELS,
 *   - isPublicChannel() is false for every one,
 *   - none leak into EXTERNAL_MUTATION_CHANNELS or CHANNEL_GESTURE,
 *   - the stream/fallback pair is DISTINCT from the main chat pair (isolation).
 */
import { describe, it, expect } from "vitest";
import {
  CHANNELS,
  PUBLIC_CHANNELS,
  EXTERNAL_MUTATION_CHANNELS,
  CHANNEL_GESTURE,
  isPublicChannel,
} from "../app-contract.js";

const sidechatChannels = Object.values(CHANNELS.sidechat);

describe("sidechat channels are internal (fail-closed)", () => {
  it("defines the expected byte-identical channel strings", () => {
    expect(CHANNELS.sidechat).toEqual({
      send: "lvis:sidechat:send",
      new: "lvis:sidechat:new",
      load: "lvis:sidechat:load",
      list: "lvis:sidechat:list",
      abort: "lvis:sidechat:abort",
      stream: "lvis:sidechat:stream",
      fallback: "lvis:sidechat:fallback",
    });
  });

  it("no sidechat channel leaks into PUBLIC_CHANNELS", () => {
    const publicSet = new Set<string>(PUBLIC_CHANNELS);
    for (const channel of sidechatChannels) {
      expect(publicSet.has(channel), `leaked public: ${channel}`).toBe(false);
      expect(isPublicChannel(channel), channel).toBe(false);
    }
  });

  it("no sidechat channel is an external-mutation or gesture-gated channel", () => {
    const extSet = new Set<string>(EXTERNAL_MUTATION_CHANNELS);
    for (const channel of sidechatChannels) {
      expect(extSet.has(channel), `leaked external-mutation: ${channel}`).toBe(false);
      expect(CHANNEL_GESTURE[channel], `gesture-classified: ${channel}`).toBeUndefined();
    }
  });

  it("stream/fallback are a DEDICATED pair, distinct from the main chat pair", () => {
    // The wire channel is the discriminator that keeps the two streams isolated
    // (No-Fallback): if side chat reused chat.stream the main renderer's
    // onChatStream subscriber would receive side-chat frames.
    expect(CHANNELS.sidechat.stream).not.toBe(CHANNELS.chat.stream);
    expect(CHANNELS.sidechat.fallback).not.toBe(CHANNELS.chat.fallback);
  });
});
