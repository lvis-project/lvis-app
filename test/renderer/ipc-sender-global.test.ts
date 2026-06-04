/**
 * IPC sender validation regression test — fix/ipc-sender-full-audit
 *
 * Two concerns:
 *  1. validateSender() allows trusted frames (file://, localhost) and rejects
 *     untrusted origins.
 *  2. Every channel classified as mutating or sensitive in the channel manifest has
 *     a validateSender() guard present in the IPC domain source files
 *     (src/ipc/domains/*). Public read-only channels are excluded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { OVERLAY_V1, PERMISSIONS, ROUTINES_V2 } from "../../src/shared/ipc-channels.js";
import { validateSender } from "../../src/ipc/gated.js";
import type { IpcMainInvokeEvent } from "electron";

// ─── Channel manifest ────────────────────────────────────────────────────────

/**
 * mutating: destructive or settings/permissions/plugins/files/network mutators.
 * sensitive: triggers LLM calls, writes memory/tasks, or reads sensitive local context.
 * public read-only: pure non-sensitive read-only queries — guard not required.
 */
const CHANNEL_MANIFEST: Record<string, "mutating" | "sensitive" | "public-read"> = {
  // Settings
  "lvis:settings:get": "public-read",
  "lvis:settings:update": "mutating",
  "lvis:settings:set-api-key": "mutating",
  "lvis:settings:has-api-key": "public-read",
  "lvis:settings:delete-api-key": "mutating",
  "lvis:settings:set-web-api-key": "mutating",
  "lvis:settings:has-web-api-key": "public-read",
  "lvis:settings:delete-web-api-key": "mutating",
  // Chat
  "lvis:chat:has-provider": "public-read",
  "lvis:chat:send": "sensitive",
  "lvis:chat:new": "mutating",
  "lvis:chat:sessions": "public-read",
  "lvis:chat:get-history": "public-read",
  "lvis:chat:edit-resend": "sensitive",
  "lvis:chat:fork": "sensitive",
  "lvis:chat:continue-last-user": "sensitive",
  "lvis:chat:retry-effort": "sensitive",
  "lvis:chat:export": "sensitive",
  // Memory
  "lvis:memory:entries:list": "sensitive",
  "lvis:memory:entries:save": "sensitive",
  "lvis:memory:entries:delete": "mutating",
  "lvis:memory:entries:search": "sensitive",
  "lvis:memory:index:get": "sensitive",
  "lvis:memory:sessions:list": "sensitive",
  "lvis:memory:sessions:search": "sensitive",
  "lvis:memory:agents-md:get": "sensitive",
  "lvis:memory:agents-md:update": "mutating",
  "lvis:memory:user-prefs:get": "sensitive",
  "lvis:memory:user-prefs:update": "mutating",
  // Plugins
  "lvis:plugins:marketplace:list": "public-read",
  "lvis:plugins:install": "mutating",
  "lvis:plugins:uninstall": "mutating",
  "lvis:plugins:ui:list": "public-read",
  "lvis:plugins:cards": "public-read",
  "lvis:plugins:perf-stats": "public-read",
  "lvis:plugins:call": "sensitive",
  // MCP
  "lvis:mcp:servers": "public-read",
  "lvis:mcp:kill": "mutating",
  // Permissions
  "lvis:permission:get-mode": "public-read",
  "lvis:permission:set-mode": "mutating",
  "lvis:permission:list-rules": "public-read",
  "lvis:permission:add-rule": "mutating",
  "lvis:permission:remove-rule": "mutating",
  [PERMISSIONS.dirDispatch]: "mutating",
  [PERMISSIONS.reviewerDispatch]: "sensitive",
  [PERMISSIONS.deferredList]: "sensitive",
  [PERMISSIONS.deferredResolve]: "mutating",
  [PERMISSIONS.auditShow]: "sensitive",
  [PERMISSIONS.auditVerify]: "sensitive",
  [PERMISSIONS.hookTrustList]: "sensitive",
  // Approval
  "lvis:approval:respond": "mutating",
  // Policy
  "lvis:policy:get": "public-read",
  "lvis:policy:set": "mutating",
  // Usage / observability
  "lvis:usage:summary": "public-read",
  // Conversation UX extras
  "lvis:starred:list": "public-read",
  "lvis:starred:add": "sensitive",
  "lvis:starred:remove": "sensitive",
  // Audit
  "lvis:audit:search": "public-read",
  "lvis:audit:stats": "public-read",
  // Telemetry
  "lvis:telemetry:consent-answer": "mutating",
  // Routines v2 — invoke channels only (fired/running-started/running-finished are main→renderer push, no handle)
  "lvis:routines:v2:list": "public-read",
  "lvis:routines:v2:add": "mutating",
  "lvis:routines:v2:dismiss": "mutating",
  "lvis:routines:v2:remove": "mutating",
  "lvis:routines:v2:trigger-now": "mutating",
  "lvis:routines:v2:list-sessions": "public-read",
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

describe("ipc-bridge.ts — mutating/sensitive channels have validateSender guard", () => {
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
    .filter(([, access]) => access === "mutating" || access === "sensitive")
    .map(([channel]) => channel);

  const publicReadChannels = Object.entries(CHANNEL_MANIFEST)
    .filter(([, access]) => access === "public-read")
    .map(([channel]) => channel);
  const channelConstantAliases: Record<string, string> = {
    "lvis:routines:v2:list": "ROUTINES_V2.list",
    "lvis:routines:v2:add": "ROUTINES_V2.add",
    "lvis:routines:v2:dismiss": "ROUTINES_V2.dismiss",
    "lvis:routines:v2:remove": "ROUTINES_V2.remove",
    "lvis:routines:v2:trigger-now": "ROUTINES_V2.triggerNow",
    "lvis:routines:v2:list-sessions": "ROUTINES_V2.listSessions",
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

  for (const channel of publicReadChannels) {
    it(`${channel} is classified read-only (public read-only)`, () => {
      const channelPattern = handlePatternFor(channel);
      const channelIdx = source.search(channelPattern);
      expect(channelIdx, `channel "${channel}" not found in ipc-bridge.ts`).toBeGreaterThan(-1);
    });
  }
});
