/**
 * IPC sender validation regression test — fix/ipc-sender-full-audit
 *
 * Two concerns:
 *  1. validateSender() allows trusted frames (file://, localhost) and rejects
 *     untrusted origins.
 *  2. Every channel classified as TIER 1 or TIER 2 in the channel manifest has
 *     a validateSender() guard present in the IPC domain source files
 *     (src/ipc/domains/*). TIER 3 (read-only) channels are excluded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { OVERLAY_V1, PERMISSIONS, ROUTINES_V2 } from "../../src/shared/ipc-channels.js";
import { validateSender } from "../../src/ipc/gated.js";
import type { IpcMainInvokeEvent } from "electron";

// ─── Channel manifest ────────────────────────────────────────────────────────

/**
 * TIER 1: destructive or settings/permissions/plugins/files/network mutators.
 * TIER 2: triggers LLM calls, writes memory/tasks, or reads sensitive local context.
 * TIER 3: pure non-sensitive read-only queries — guard not required.
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
  "lvis:memory:entries:list": "tier2",
  "lvis:memory:entries:save": "tier2",
  "lvis:memory:entries:delete": "tier1",
  "lvis:memory:entries:search": "tier2",
  "lvis:memory:index:get": "tier2",
  "lvis:memory:sessions:list": "tier2",
  "lvis:memory:sessions:search": "tier2",
  "lvis:memory:agents-md:get": "tier2",
  "lvis:memory:agents-md:update": "tier1",
  "lvis:memory:lvis-md:get": "tier2",
  "lvis:memory:lvis-md:update": "tier1",
  "lvis:memory:user-prefs:get": "tier2",
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
  [PERMISSIONS.dirDispatch]: "tier1",
  [PERMISSIONS.reviewerDispatch]: "tier2",
  [PERMISSIONS.deferredList]: "tier2",
  [PERMISSIONS.deferredResolve]: "tier1",
  [PERMISSIONS.auditShow]: "tier2",
  [PERMISSIONS.auditVerify]: "tier2",
  [PERMISSIONS.hookTrustList]: "tier2",
  // Approval
  "lvis:approval:respond": "tier1",
  // Policy
  "lvis:policy:get": "tier3",
  "lvis:policy:set": "tier1",
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
  // Routines v2 — invoke channels only (fired/running-started/running-finished are main→renderer push, no handle)
  "lvis:routines:v2:list": "tier3",
  "lvis:routines:v2:add": "tier1",
  "lvis:routines:v2:dismiss": "tier1",
  "lvis:routines:v2:remove": "tier1",
  "lvis:routines:v2:trigger-now": "tier1",
  "lvis:routines:v2:list-sessions": "tier3",
  "lvis:routines:v2:read-session": "tier2",
  // Overlay v1 — primary-action is renderer→main invoke (write influence); show/update/dismiss are main→renderer push events
  "lvis:overlay:primary-action": "tier1",
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
  // ipc-bridge.ts is now a thin re-export shim; all handler source lives in
  // src/ipc/domains/*. Aggregate the full source so the channel + guard checks
  // remain valid against the actual implementation files.
  const domainDir = join(__dirname, "../../src/ipc/domains");
  const domainFiles = ["settings.ts", "chat.ts", "plugins.ts", "usage.ts", "audit.ts", "permissions.ts", "window.ts", "misc.ts"];
  // Inline IPC channel SoT constants (`shared/ipc-channels.ts`) into the
  // aggregated source so handlers written as `ipcMain.handle(ROUTINES_V2.list,
  // ...)` are matched by the same `ipcMain.handle("lvis:routines:v2:list"`
  // pattern the test runs for the other channels. Without this, Routine v2 +
  // Overlay V1 channels read as "not found in source" even though their
  // handlers live in `misc.ts`.
  const constInlinePairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(ROUTINES_V2)) {
    constInlinePairs.push([`ROUTINES_V2.${key}`, `"${value}"`]);
  }
  for (const [key, value] of Object.entries(OVERLAY_V1)) {
    constInlinePairs.push([`OVERLAY_V1.${key}`, `"${value}"`]);
  }
  // Substitute longer reference strings first so prefix collisions don't
  // corrupt later replacements (e.g. `ROUTINES_V2.list` would otherwise
  // partially rewrite `ROUTINES_V2.listSessions`).
  constInlinePairs.sort((a, b) => b[0].length - a[0].length);
  const rawSource = domainFiles
    .map((f) => readFileSync(join(domainDir, f), "utf-8"))
    .join("\n");
  let source = rawSource;
  for (const [ref, literal] of constInlinePairs) {
    source = source.split(ref).join(literal);
  }

  const gatedChannels = Object.entries(CHANNEL_MANIFEST)
    .filter(([, tier]) => tier === "tier1" || tier === "tier2")
    .map(([channel]) => channel);

  const tier3Channels = Object.entries(CHANNEL_MANIFEST)
    .filter(([, tier]) => tier === "tier3")
    .map(([channel]) => channel);
  const channelConstantAliases: Record<string, string> = {
    "lvis:routines:v2:list": "ROUTINES_V2.list",
    "lvis:routines:v2:add": "ROUTINES_V2.add",
    "lvis:routines:v2:dismiss": "ROUTINES_V2.dismiss",
    "lvis:routines:v2:remove": "ROUTINES_V2.remove",
    "lvis:routines:v2:trigger-now": "ROUTINES_V2.triggerNow",
    "lvis:routines:v2:list-sessions": "ROUTINES_V2.listSessions",
    "lvis:routines:v2:read-session": "ROUTINES_V2.readSession",
    "lvis:overlay:primary-action": "OVERLAY_V1.primaryAction",
    "lvis:permission:get-mode": "PERMISSIONS.getMode",
    "lvis:permission:set-mode": "PERMISSIONS.setMode",
    "lvis:permission:list-rules": "PERMISSIONS.listRules",
    "lvis:permission:add-rule": "PERMISSIONS.addRule",
    "lvis:permission:remove-rule": "PERMISSIONS.removeRule",
    "lvis:approval:respond": "PERMISSIONS.approvalRespond",
    "lvis:policy:get": "PERMISSIONS.policyGet",
    "lvis:policy:set": "PERMISSIONS.policySet",
    [PERMISSIONS.dirDispatch]: "PERMISSIONS.dirDispatch",
    [PERMISSIONS.reviewerDispatch]: "PERMISSIONS.reviewerDispatch",
    [PERMISSIONS.deferredList]: "PERMISSIONS.deferredList",
    [PERMISSIONS.deferredResolve]: "PERMISSIONS.deferredResolve",
    [PERMISSIONS.auditShow]: "PERMISSIONS.auditShow",
    [PERMISSIONS.auditVerify]: "PERMISSIONS.auditVerify",
    [PERMISSIONS.hookTrustList]: "PERMISSIONS.hookTrustList",
  };
  const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const handlePatternFor = (channel: string): RegExp => {
    const literal = `"${escapeRegex(channel)}"`;
    const alias = channelConstantAliases[channel];
    const target = alias ? `(?:${literal}|${escapeRegex(alias)})` : literal;
    return new RegExp(`ipcMain\\.handle\\(\\s*${target}\\s*,`);
  };

  for (const channel of gatedChannels) {
    it(`${channel} has validateSender guard`, () => {
      // Find the ipcMain.handle block for this channel and check that
      // validateSender appears between this channel registration and the next.
      const channelPattern = handlePatternFor(channel);
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
      const channelPattern = handlePatternFor(channel);
      const channelIdx = source.search(channelPattern);
      expect(channelIdx, `channel "${channel}" not found in ipc-bridge.ts`).toBeGreaterThan(-1);
    });
  }
});
