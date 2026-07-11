/**
 * #885 b2/b3 — the MCP-app detach + disconnect channels MUST stay INTERNAL.
 * They spawn/close host windows and broadcast host state, so no external origin
 * (local-api / cli / plugin frame) may ever reach them. Asserts the fail-closed
 * classification and that adding them did NOT touch the public surface (so
 * CONTRACT_VERSION does not need to bump — the freeze test stays green).
 */
import { describe, it, expect } from "vitest";
import {
  CHANNELS,
  CONTRACT_VERSION,
  PUBLIC_CHANNELS,
  EXTERNAL_MUTATION_CHANNELS,
  CHANNEL_GESTURE,
  INTERNAL_HOST_CHANNELS,
  isPublicChannel,
} from "../app-contract.js";

const mcpAppChannels = [
  CHANNELS.mcp.openDetached,
  CHANNELS.mcp.detachedPayload,
  CHANNELS.mcp.serverDisconnected,
  CHANNELS.mcp.disposeUiSession,
  // `oncalltool` — an app runs a tool on its own server. The most sensitive of the
  // set (it EXECUTES), so it must never be publicly reachable either.
  CHANNELS.mcp.callTool,
  // `onmessage` — an app pushes text into the conversation (or the notification
  // surface). Mutates conversation state, so it is internal for the same reason.
  CHANNELS.mcp.uiMessage,
  // `ondownloadfile` — an app saves inline bytes through the user's save dialog. It
  // WRITES A FILE, so it must never be publicly reachable.
  CHANNELS.mcp.uiDownloadFile,
  // `onupdatemodelcontext` — an app overwrites what the model reads on the next turn.
  // Mutates model-facing state, so it is internal for the same reason.
  CHANNELS.mcp.uiModelContext,
];

describe("#885 MCP-app channels are internal (fail-closed)", () => {
  it("defines the expected byte-identical channel strings", () => {
    expect(CHANNELS.mcp.openDetached).toBe("lvis:mcp:open-detached");
    expect(CHANNELS.mcp.detachedPayload).toBe("lvis:mcp:detached-payload");
    expect(CHANNELS.mcp.serverDisconnected).toBe("lvis:mcp:server-disconnected");
    expect(CHANNELS.mcp.disposeUiSession).toBe("lvis:mcp:dispose-ui-session");
    expect(CHANNELS.mcp.callTool).toBe("lvis:mcp:call-tool");
    expect(CHANNELS.mcp.uiMessage).toBe("lvis:mcp:ui-message");
    expect(CHANNELS.mcp.uiDownloadFile).toBe("lvis:mcp:ui-download-file");
    expect(CHANNELS.mcp.uiModelContext).toBe("lvis:mcp:ui-model-context");
  });

  it("no MCP-app channel leaks into PUBLIC_CHANNELS", () => {
    const publicSet = new Set<string>(PUBLIC_CHANNELS);
    for (const channel of mcpAppChannels) {
      expect(publicSet.has(channel), `leaked public: ${channel}`).toBe(false);
      expect(isPublicChannel(channel), channel).toBe(false);
    }
  });

  it("no MCP-app channel is an external-mutation or gesture-gated channel", () => {
    const extSet = new Set<string>(EXTERNAL_MUTATION_CHANNELS);
    for (const channel of mcpAppChannels) {
      expect(extSet.has(channel), `leaked external-mutation: ${channel}`).toBe(false);
      expect(CHANNEL_GESTURE[channel], `gesture-classified: ${channel}`).toBeUndefined();
    }
  });

  it("classifies the two window-manager-registered handlers under detachedWindow", () => {
    const detached = new Set<string>(INTERNAL_HOST_CHANNELS.detachedWindow);
    expect(detached.has(CHANNELS.mcp.openDetached)).toBe(true);
    expect(detached.has(CHANNELS.mcp.detachedPayload)).toBe(true);
  });

  it("does NOT bump CONTRACT_VERSION (all three are internal)", () => {
    // Pinned so a future public-surface change is a conscious edit here, not a
    // side effect of adding these internal channels.
    expect(CONTRACT_VERSION).toBe("1.2.0");
  });
});
