/**
 * Permission SOT V1 — PermissionManager owns the meta `decisionOverride`
 * re-elevation.
 *
 * Before this move the executor rewrote PermissionManager's override-`allow`
 * verdict into a `forceModal` ask for `meta`-category builtin tools whose
 * author declared `decisionOverride: "ask"` (the agent_spawn case), re-reading
 * `getMode()` to carve out allow-all mode. That leaked the decision out of the
 * SOT. `categoryBasedDecision`'s `"override"` branch now owns it: the executor
 * only carries `context.decisionOverride` into `checkDetailed`.
 *
 * Truth-table axes: override × mode.
 *   - decisionOverride="ask" × default/auto → ask + forceModal (layer 6)
 *   - decisionOverride="ask" × allow        → allow, NO prompt (#1469 axis:
 *       allow-all never prompts, agent_spawn included — single-sourced by the
 *       mode==="allow" branch)
 *   - decisionOverride="ask" × strict       → ask (layer 2 mode-first gate,
 *       reached before the override branch; behaviour unchanged)
 *   - decisionOverride=undefined            → override-`allow` (unchanged)
 *
 * `always-allow-with-audit` is short-circuited by the executor BEFORE
 * checkDetailed runs, so it never reaches the PM override branch and is covered
 * by the executor integration suite, not here.
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
    // The allow-all invariant: an explicit opt-in to allow every
    // non-hard-blocked tool never prompts, agent_spawn (meta) included. The
    // SOT enforces this in the mode==="allow" branch of categoryBasedDecision;
    // the override branch's `this.mode !== "allow"` guard mirrors it so the
    // re-elevation cannot fire under allow-all. This is the exact regression
    // the executor's #1469 getMode() guard used to catch — now single-sourced.
    pm.setMode("allow");
    const result = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(result.decision).toBe("allow");
    expect(result.forceModal).toBeUndefined();
  });

  it("strict mode + decisionOverride='ask' → ask (mode-first layer 2, unchanged)", () => {
    // strict is a mode-first hard gate resolved before categoryBasedDecision's
    // override branch, so the meta override yields the ordinary strict ask
    // (layer 2) with no forceModal — identical to the pre-move behaviour, where
    // the executor's `decision === "allow"` predicate was already false in
    // strict and so never re-elevated.
    pm.setMode("strict");
    const result = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(result.decision).toBe("ask");
    expect(result.layer).toBe(2);
    expect(result.forceModal).toBeUndefined();
  });

  it("default mode + no decisionOverride → override allow (unchanged)", () => {
    // A meta builtin with no author override keeps the historical
    // override-`allow` — non-meta callers pass `undefined` and are unaffected.
    pm.setMode("default");
    const result = pm.checkDetailed("some_meta_tool", "builtin", "meta");
    expect(result.decision).toBe("allow");
    expect(result.forceModal).toBeUndefined();
    expect(result.layer).toBe(6);
  });

  it("default mode + decisionOverride='always-allow-with-audit' → allow (never elevated)", () => {
    // Defence in depth: even if `always-allow-with-audit` reached the override
    // branch (the executor short-circuits it earlier), only `"ask"` elevates —
    // this value keeps the override allow.
    pm.setMode("default");
    const result = pm.checkDetailed("ask_user_question", "builtin", "meta", null, {
      decisionOverride: "always-allow-with-audit",
    });
    expect(result.decision).toBe("allow");
    expect(result.forceModal).toBeUndefined();
    expect(result.layer).toBe(6);
  });
});
