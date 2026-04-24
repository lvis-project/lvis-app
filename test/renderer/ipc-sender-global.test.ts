/**
 * IPC sender validation regression test — fix/ipc-sender-full-audit
 *
 * Two concerns:
 *  1. validateSender() allows trusted frames (file://, localhost) and rejects
 *     untrusted origins.
 *  2. Every channel classified as TIER 1 or TIER 2 in the channel manifest has
 *     a validateSender() guard present in ipc-bridge.ts source text.
 *     TIER 3 (read-only) channels are explicitly excluded from the requirement.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateSender } from "../../src/ipc-bridge.js";
import type { IpcMainInvokeEvent } from "electron";

// ─── Channel manifest ────────────────────────────────────────────────────────

/**
 * TIER 1: destructive or settings/permissions/plugins/files/network mutators.
 * TIER 2: triggers LLM calls or writes memory/tasks.
 * TIER 3: pure read-only queries — guard not required.
 */
const CHANNEL_MANIFEST: Record<string, "tier1" | "tier2" | "tier3"> = {
  // Settings
  "lvis:settings:get": "tier3",
  "lvis:settings:update": "tier1",
  "lvis:settings:set-api-key": "tier1",
  "lvis:settings:has-api-key": "tier3",
  "lvis:settings:delete-api-key": "tier1",
  "lvis:settings:set-web-api-key": "tier1",
  "lvis:settings:has-web-api-key": "tier3",
  "lvis:settings:delete-web-api-key": "tier1",
  // Chat
  "lvis:chat:has-provider": "tier3",
  "lvis:chat:send": "tier2",
  "lvis:chat:new": "tier1",
  "lvis:chat:sessions": "tier3",
  "lvis:chat:load-session": "tier1",
  "lvis:chat:get-history": "tier3",
  "lvis:chat:edit-resend": "tier2",
  "lvis:chat:fork": "tier2",
  "lvis:chat:retry-effort": "tier2",
  "lvis:chat:export": "tier2",
  // Memory
  "lvis:memory:notes:list": "tier3",
  "lvis:memory:notes:save": "tier1",
  "lvis:memory:notes:delete": "tier1",
  "lvis:memory:notes:search": "tier3",
  "lvis:memory:lvis-md:get": "tier3",
  "lvis:memory:lvis-md:update": "tier1",
  "lvis:memory:user-prefs:get": "tier3",
  "lvis:memory:user-prefs:update": "tier1",
  // Plugins
  "lvis:plugins:marketplace:list": "tier3",
  "lvis:plugins:install": "tier1",
  "lvis:plugins:uninstall": "tier1",
  "lvis:plugins:ui:list": "tier3",
  "lvis:plugins:cards": "tier3",
  "lvis:plugins:perf-stats": "tier3",
  "lvis:plugins:call": "tier2",
  // MCP
  "lvis:mcp:servers": "tier3",
  "lvis:mcp:kill": "tier1",
  // Permissions
  "lvis:permission:get-mode": "tier3",
  "lvis:permission:set-mode": "tier1",
  "lvis:permission:list-rules": "tier3",
  "lvis:permission:add-rule": "tier1",
  "lvis:permission:remove-rule": "tier1",
  // Approval
  "lvis:approval:respond": "tier1",
  // Policy
  "lvis:policy:get": "tier3",
  "lvis:policy:set": "tier1",
  // Tasks
  "lvis:tasks:add": "tier1",
  "lvis:tasks:update": "tier1",
  "lvis:tasks:get": "tier3",
  "lvis:tasks:delete": "tier1",
  "lvis:tasks:query": "tier3",
  "lvis:tasks:pending": "tier3",
  "lvis:tasks:overdue": "tier3",
  "lvis:tasks:today": "tier3",
  // Routine briefing
  "lvis:routine:dismiss-briefing": "tier1",
  "lvis:routine:snooze-briefing": "tier1",
  "lvis:routine:get-latest-briefing": "tier3",
  "lvis:routines:dev-reset-daily-briefing": "tier1",
  // Usage / observability
  "lvis:usage:summary": "tier3",
  // Conversation UX extras
  "lvis:starred:list": "tier3",
  "lvis:starred:add": "tier2",
  "lvis:starred:remove": "tier2",
  // Audit
  "lvis:audit:search": "tier3",
  "lvis:audit:stats": "tier3",
  // Telemetry
  "lvis:telemetry:consent-answer": "tier1",
};

// ─── validateSender unit tests ───────────────────────────────────────────────

function makeEvent(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url } } as unknown as IpcMainInvokeEvent;
}

describe("validateSender", () => {
  it("trusts file:// renderer (packaged app)", () => {
    expect(validateSender(makeEvent("file:///app/index.html"))).toBe(true);
  });

  it("trusts http://localhost dev server", () => {
    expect(validateSender(makeEvent("http://localhost:5173/"))).toBe(true);
  });

  it("trusts http://127.0.0.1 dev server", () => {
    expect(validateSender(makeEvent("http://127.0.0.1:5173/"))).toBe(true);
  });

  it("rejects https://evil.com (remote origin)", () => {
    expect(validateSender(makeEvent("https://evil.com"))).toBe(false);
  });

  it("rejects http://localhost.attacker.com (hostname spoof)", () => {
    expect(validateSender(makeEvent("http://localhost.attacker.com"))).toBe(false);
  });

  it("rejects https://localhost (HTTPS is not trusted)", () => {
    expect(validateSender(makeEvent("https://localhost"))).toBe(false);
  });

  it("rejects empty url", () => {
    expect(validateSender(makeEvent(""))).toBe(false);
  });

  it("returns true when event has no senderFrame (test synthetic events)", () => {
    expect(validateSender(null)).toBe(true);
    expect(validateSender(undefined)).toBe(true);
    expect(validateSender({} as IpcMainInvokeEvent)).toBe(true);
  });
});

// ─── Source-level guard audit ────────────────────────────────────────────────

describe("ipc-bridge.ts — TIER 1/2 channels have validateSender guard", () => {
  const bridgePath = join(__dirname, "../../src/ipc-bridge.ts");
  const source = readFileSync(bridgePath, "utf-8");

  const gatedChannels = Object.entries(CHANNEL_MANIFEST)
    .filter(([, tier]) => tier === "tier1" || tier === "tier2")
    .map(([channel]) => channel);

  const tier3Channels = Object.entries(CHANNEL_MANIFEST)
    .filter(([, tier]) => tier === "tier3")
    .map(([channel]) => channel);

  for (const channel of gatedChannels) {
    it(`${channel} has validateSender guard`, () => {
      // Find the ipcMain.handle block for this channel and check that
      // validateSender appears between this channel registration and the next.
      const channelPattern = new RegExp(
        `ipcMain\\.handle\\("${channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      );
      const channelIdx = source.search(channelPattern);
      expect(channelIdx, `channel "${channel}" not found in ipc-bridge.ts`).toBeGreaterThan(-1);

      // Grab the source from channel declaration to the next ipcMain.handle or end of registerIpcHandlers
      const afterChannel = source.slice(channelIdx);
      const nextHandleIdx = afterChannel.search(/ipcMain\.handle\((?!.*"lvis:)/);
      const nextHandleRealIdx = afterChannel.indexOf("ipcMain.handle(", 10); // skip self
      const snippet = nextHandleRealIdx > 0
        ? afterChannel.slice(0, nextHandleRealIdx)
        : afterChannel.slice(0, 1000);

      expect(
        snippet,
        `channel "${channel}" (${CHANNEL_MANIFEST[channel]}) is missing validateSender guard`,
      ).toContain("validateSender(");
    });
  }

  for (const channel of tier3Channels) {
    it(`${channel} is classified read-only (TIER 3)`, () => {
      const channelPattern = new RegExp(
        `ipcMain\\.handle\\("${channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      );
      const channelIdx = source.search(channelPattern);
      expect(channelIdx, `channel "${channel}" not found in ipc-bridge.ts`).toBeGreaterThan(-1);
    });
  }
});
