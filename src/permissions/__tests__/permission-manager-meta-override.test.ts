/**
 * Permission SOT V1 — PermissionManager owns the meta `decisionOverride`
 * re-elevation.
 *
 * Before this move the executor rewrote PermissionManager's `allow` verdict
 * into a `forceModal` ask for `meta`-category builtin tools whose author
 * declared `decisionOverride: "ask"` (the agent_spawn case), re-reading
 * `getMode()` to carve out allow-all mode. That block was layer-agnostic: it
 * fired for a layer-3 allow-rule hit OR a layer-5 `alwaysAllowed` hit as well
 * as the layer-6 override path.
 *
 * The SOT is now a **post-computation guard at the bottom of `checkDetailed`**
 * (after all layers have been evaluated). Placing it there is the only correct
 * single-source: the override branch in `categoryBasedDecision` only covers
 * layer 6; layer-3 and layer-5 return early before `categoryBasedDecision` is
 * called and would silently bypass an override-branch-only guard.
 *
 * The `mode !== "allow"` check in the post-guard is NOT dead code: at that
 * point in `checkDetailed` the mode is not narrowed (unlike inside the override
 * branch where strict/allow early-returns have already excluded those modes).
 * The allow-all invariant (`mode === "allow"` → no prompt for any
 * non-hard-blocked tool, agent_spawn included) is enforced by that live guard,
 * not by an early return.
 *
 * Truth-table axes:
 *   - decisionOverride="ask" × default/auto                → ask + forceModal (post-guard fires)
 *   - decisionOverride="ask" × allow (any layer)           → allow, NO prompt (post-guard skips)
 *   - decisionOverride="ask" × strict                      → ask layer 2, no forceModal
 *                                                            (layer-2 return before layer 3/5/6)
 *   - decisionOverride="ask" × layer-5 alwaysAllowed       → still ask + forceModal (MAJOR-2 fix)
 *   - decisionOverride="ask" × layer-5 alwaysAllowed+allow → allow, NO prompt
 *   - decisionOverride="ask" × layer-3 allow-rule          → still ask + forceModal (MAJOR-2 fix)
 *   - decisionOverride=undefined                           → override-`allow` (unchanged)
 *   - decisionOverride="always-allow-with-audit"           → override-`allow` (only "ask" elevates)
 *
 * `always-allow-with-audit` is short-circuited by the executor BEFORE
 * checkDetailed runs and is covered by the executor integration suite.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PermissionManager } from "../permission-manager.js";

vi.mock("../permissions-store.js", () => ({
  readPermissionsFile: vi.fn(async () => null),
  updatePermissionsFile: vi.fn(async () => undefined),
}));

describe("PermissionManager — meta decisionOverride re-elevation (V1 SOT)", () => {
  let pm: PermissionManager;

  beforeEach(() => {
    pm = new PermissionManager("/tmp/test-meta-override-permissions.json");
  });

  // ── Layer-6 (override branch) baseline ──────────────────────────────────

  it("default mode + decisionOverride='ask' → forceModal ask (layer 6)", () => {
    pm.setMode("default");
    const result = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(result.decision).toBe("ask");
    expect(result.forceModal).toBe(true);
    expect(result.layer).toBe(6);
  });

  it("auto mode + decisionOverride='ask' → forceModal ask (layer 6)", () => {
    pm.setMode("auto");
    const result = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(result.decision).toBe("ask");
    expect(result.forceModal).toBe(true);
    expect(result.layer).toBe(6);
  });

  it("allow mode + decisionOverride='ask' → allow, NO forceModal (#1469 axis)", () => {
    // The allow-all invariant: the post-computation guard's `mode !== "allow"`
    // check is the live SOT here — it skips the re-elevation so agent_spawn
    // gets the same no-prompt behaviour as any other non-hard-blocked tool under
    // the user's explicit allow-all opt-in.
    pm.setMode("allow");
    const result = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(result.decision).toBe("allow");
    expect(result.forceModal).toBeUndefined();
  });

  it("strict mode + decisionOverride='ask' → ask layer 2 (mode-first, no forceModal)", () => {
    // strict returns ask at layer 2 before layers 3/5/6, so the post-guard
    // never fires (result.decision is already "ask", not "allow").
    pm.setMode("strict");
    const result = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(result.decision).toBe("ask");
    expect(result.layer).toBe(2);
    expect(result.forceModal).toBeUndefined();
  });

  it("default mode + no decisionOverride → override allow (post-guard skips)", () => {
    // Non-meta callers pass undefined; the post-guard condition
    // `context.decisionOverride === "ask"` is false, so the result is the
    // historical override-allow unchanged.
    pm.setMode("default");
    const result = pm.checkDetailed("some_meta_tool", "builtin", "meta");
    expect(result.decision).toBe("allow");
    expect(result.forceModal).toBeUndefined();
    expect(result.layer).toBe(6);
  });

  it("default mode + decisionOverride='always-allow-with-audit' → allow (post-guard skips)", () => {
    // Only "ask" triggers the post-guard; "always-allow-with-audit" keeps the
    // override allow. (The executor short-circuits this value before reaching
    // checkDetailed; this is defence-in-depth.)
    pm.setMode("default");
    const result = pm.checkDetailed("ask_user_question", "builtin", "meta", null, {
      decisionOverride: "always-allow-with-audit",
    });
    expect(result.decision).toBe("allow");
    expect(result.forceModal).toBeUndefined();
    expect(result.layer).toBe(6);
  });

  // ── MAJOR-2 — layer-5 alwaysAllowed must not defeat the per-invocation gate

  it("layer-5 alwaysAllowed + default mode + decisionOverride='ask' → forceModal ask", async () => {
    // Regression: the OLD executor block was layer-agnostic. A user clicking
    // "Allow always" on agent_spawn's modal calls addAlwaysAllowedPersist and
    // subsequent invocations hit layer-5 (alwaysAllowed.get()), returning allow
    // BEFORE categoryBasedDecision. The post-guard (layer-agnostic) must still
    // re-elevate to ask+forceModal to honour the tool author's per-invocation
    // contract, even against a persisted grant.
    pm.setMode("default");
    await pm.addAlwaysAllowedPersist("agent_spawn");
    const result = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(result.decision).toBe("ask");
    expect(result.forceModal).toBe(true);
    expect(result.layer).toBe(6);
  });

  it("layer-5 alwaysAllowed + allow mode + decisionOverride='ask' → allow (allow-all wins)", async () => {
    // Even with a persisted grant, allow-all mode must mean no prompt at all.
    // The post-guard's `mode !== "allow"` check skips the re-elevation.
    pm.setMode("allow");
    await pm.addAlwaysAllowedPersist("agent_spawn");
    const result = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(result.decision).toBe("allow");
    expect(result.forceModal).toBeUndefined();
  });

  // ── MAJOR-2 — layer-3 allow-rule must not defeat the per-invocation gate

  it("layer-3 allow-rule + default mode + decisionOverride='ask' → forceModal ask", () => {
    // A user-created allow-rule (e.g. "agent_spawn" → allow) hits layer 3 and
    // returns allow before categoryBasedDecision. The post-guard must still
    // re-elevate.
    pm.setMode("default");
    pm.setRules([{ pattern: "agent_spawn", action: "allow" }]);
    const result = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(result.decision).toBe("ask");
    expect(result.forceModal).toBe(true);
    expect(result.layer).toBe(6);
  });

  it("layer-3 allow-rule + allow mode + decisionOverride='ask' → allow (allow-all wins)", () => {
    // Allow-all still wins even with an explicit allow-rule.
    pm.setMode("allow");
    pm.setRules([{ pattern: "agent_spawn", action: "allow" }]);
    const result = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(result.decision).toBe("allow");
    expect(result.forceModal).toBeUndefined();
  });
});
