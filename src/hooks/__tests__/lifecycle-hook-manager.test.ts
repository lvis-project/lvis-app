/**
 * #811 milestone-2 — NON-BLOCKING lifecycle hook events through the manager.
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §5 (event surface)
 * + §6 (non-blocking semantics). Covers, per the milestone acceptance criteria:
 *   - each lifecycle event fires its registered hook with the right payload
 *   - a deny on a lifecycle hook does NOT change control flow (observe-only)
 *   - an untrusted / quarantined lifecycle hook never fires (registry is the
 *     trust boundary — only trusted entries are ever installed)
 *   - back-compat: no config ⇒ no lifecycle dispatch, behavior identical
 *
 * Lifecycle hooks are CONFIG-ONLY (no `.sh` prefix), so every fixture here is a
 * `HookConfigEntry` pointing at a Node command fixture.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ScriptHookManager } from "../script-hook-manager.js";
import type { HookConfigEntry } from "../hook-config.js";
import type { LifecycleHookEvent } from "../script-hook-types.js";
import { hasNode } from "./test-helpers.js";

const FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");
const ECHO = resolve(FIXTURE_ROOT, "cmd-lifecycle-echo.js");
const DENY = resolve(FIXTURE_ROOT, "cmd-lifecycle-deny.js");

const HAS_NODE = hasNode();

function lifecycleEntry(
  event: LifecycleHookEvent,
  command: string[],
  over: Partial<HookConfigEntry> = {},
): HookConfigEntry {
  return {
    id: `${event}#0.0`,
    event,
    command,
    timeoutMs: 5000,
    source: "config",
    ...over,
  };
}

const ALL_EVENTS: LifecycleHookEvent[] = [
  "PostToolUseFailure",
  "PermissionDenied",
  "SessionStart",
  "Stop",
  "PreCompact",
  "PostCompact",
];

describe("#811 m2 — lifecycle event dispatch", () => {
  it.skipIf(!HAS_NODE).each(ALL_EVENTS)(
    "fires the registered hook for %s with the event + sessionId in the payload",
    async (event) => {
      const m = new ScriptHookManager();
      m.setTrustedRegistry([], [lifecycleEntry(event, ["node", ECHO])]);
      const out = await m.runLifecycleEvent(event, "sess-42", "unknown");
      expect(out.results).toHaveLength(1);
      // The echo fixture reflects the payload into `reason`.
      expect(out.results[0].reason).toContain(`event=${event}`);
      expect(out.results[0].reason).toContain("session=sess-42");
      // The runner carries the lifecycle event through onto the result.
      expect(out.results[0].hookType).toBe(event);
    },
  );

  it.skipIf(!HAS_NODE)("PostToolUseFailure carries toolName + errorMessage + durationMs", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PostToolUseFailure", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PostToolUseFailure", "s1", "unknown", {
      toolName: "fs_write",
      errorMessage: "disk full",
      durationMs: 123,
    });
    expect(out.results[0].reason).toContain("tool=fs_write");
    expect(out.results[0].reason).toContain("err=disk full");
    expect(out.results[0].reason).toContain("dur=123");
  });

  it.skipIf(!HAS_NODE)("PermissionDenied carries the denyReason {layer, source}", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PermissionDenied", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PermissionDenied", "s1", "unknown", {
      toolName: "bash",
      denyReason: { layer: 3, source: "tool-executor" },
    });
    expect(out.results[0].reason).toContain('deny={"layer":3,"source":"tool-executor"}');
  });

  it.skipIf(!HAS_NODE)("PreCompact carries reason + tokenEstimate", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PreCompact", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PreCompact", "s1", "unknown", {
      reason: "auto-compact",
      tokenEstimate: 90000,
    });
    expect(out.results[0].reason).toContain("reason=auto-compact");
    expect(out.results[0].reason).toContain("est=90000");
  });

  it.skipIf(!HAS_NODE)("PostCompact carries messages/tokens before + after", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PostCompact", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PostCompact", "s1", "unknown", {
      messagesBefore: 50,
      messagesAfter: 10,
      tokensBefore: 90000,
      tokensAfter: 20000,
    });
    expect(out.results[0].reason).toContain("mb=50");
    expect(out.results[0].reason).toContain("ma=10");
    expect(out.results[0].reason).toContain("tb=90000");
    expect(out.results[0].reason).toContain("ta=20000");
  });

  it.skipIf(!HAS_NODE)("SessionStart carries sessionMeta", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("SessionStart", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("SessionStart", "s1", "unknown", {
      sessionMeta: { sessionKind: "routine", routineId: "r1" },
    });
    expect(out.results[0].reason).toContain('meta={"sessionKind":"routine","routineId":"r1"}');
  });

  it.skipIf(!HAS_NODE)("DLP-redacts a secret-bearing errorMessage before dispatch", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PostToolUseFailure", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PostToolUseFailure", "s1", "unknown", {
      toolName: "fs_read",
      errorMessage: "failed to email ken@lvis.example.com",
    });
    // The email is redacted before the hook ever sees it.
    expect(out.results[0].reason).toContain("[REDACTED:EMAIL]");
    expect(out.results[0].reason).not.toContain("ken@lvis.example.com");
  });
});

describe("#811 m2 — NON-BLOCKING semantics (observe-only)", () => {
  it.skipIf(!HAS_NODE)("records a deny but the caller can ignore it (decision is observe-only)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("Stop", ["node", DENY])]);
    const out = await m.runLifecycleEvent("Stop", "s1", "unknown", { stopReason: "end_turn" });
    // The deny IS recorded for audit...
    expect(out.decision).toBe("deny");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].decision).toBe("deny");
    // ...but it is the CALLER's contract to ignore it — runLifecycleEvent never
    // throws and returns normally so a deny cannot abort the turn. (The
    // executor/loop wiring discards this result entirely.)
  });

  it("never throws and returns an empty observe result when nothing matches", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], []);
    const out = await m.runLifecycleEvent("Stop", "s1", "unknown", { stopReason: "end_turn" });
    expect(out.decision).toBe("allow");
    expect(out.results).toEqual([]);
  });
});

describe("#811 m2 — trust boundary + matcher", () => {
  it.skipIf(!HAS_NODE)("an untrusted / quarantined hook never fires (not in the trusted registry)", async () => {
    const m = new ScriptHookManager();
    // Simulate quarantine: the entry was NEVER installed into the trusted
    // registry. setTrustedRegistry only ever receives trusted entries.
    m.setTrustedRegistry([], []);
    const out = await m.runLifecycleEvent("SessionStart", "s1", "unknown");
    expect(out.results).toEqual([]);
    expect(m.size()).toBe(0);
  });

  it.skipIf(!HAS_NODE)("matcher subject is the sessionId — a non-matching session is skipped", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("Stop", ["node", ECHO], { matcher: "sess-allowed*" })]);

    const matched = await m.runLifecycleEvent("Stop", "sess-allowed-1", "unknown");
    expect(matched.results).toHaveLength(1);

    const skipped = await m.runLifecycleEvent("Stop", "sess-other", "unknown");
    expect(skipped.results).toEqual([]);
    expect(skipped.decision).toBe("allow");
  });

  it.skipIf(!HAS_NODE)("only the matching event's hook fires (event filter)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry(
      [],
      [
        lifecycleEntry("Stop", ["node", ECHO], { id: "Stop#0.0" }),
        lifecycleEntry("SessionStart", ["node", DENY], { id: "SessionStart#0.0" }),
      ],
    );
    // Firing Stop must NOT run the SessionStart deny hook.
    const out = await m.runLifecycleEvent("Stop", "s1", "unknown");
    expect(out.results).toHaveLength(1);
    expect(out.decision).toBe("allow");
    expect(out.results[0].reason).toContain("event=Stop");
  });
});

describe("#811 m2 — back-compat (no lifecycle config)", () => {
  it("a tool-use registry with no lifecycle entries dispatches nothing for lifecycle events", async () => {
    const m = new ScriptHookManager();
    // Only a (config) PreToolUse entry — no lifecycle entries at all.
    m.setTrustedRegistry([], [
      { id: "PreToolUse#0.0", event: "pre", command: ["./pre.sh"], timeoutMs: 5000, source: "config" },
    ]);
    const out = await m.runLifecycleEvent("Stop", "s1", "unknown", { stopReason: "end_turn" });
    expect(out.results).toEqual([]);
    expect(out.decision).toBe("allow");
  });
});
