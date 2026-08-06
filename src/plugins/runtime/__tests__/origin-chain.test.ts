/**
 * Issue #664 P2 (PR #860) — runWithInvocationOrigin UI-stickiness tests.
 *
 * Pins:
 *   (a) UI → plugin → plugin keeps `effectiveOrigin === "ui"` at the
 *       innermost frame. Wrapper plugins called from a UI panel must not
 *       silently demote their inner `ctx.callTool` to plugin origin.
 *   (b) plugin → plugin (no UI ancestor) stays `plugin`.
 *   (c) setTimeout/queueMicrotask inside a plugin handler that calls back
 *       into callTool retains the chain (this is what AsyncLocalStorage
 *       buys us).
 *   (d) Concurrent inner calls share the same parent frame.
 *
 * The pre-fix bug routed inner ctx.callTool through the headless reviewer
 * lane because origin was demoted to plugin — interactive AAD popup
 * silently queued forever (#664 reproducer).
 */
import { describe, it, expect } from "vitest";
import {
  runWithInvocationOrigin,
  currentInvocationOrigin,
} from "../origin-chain.js";

describe("runWithInvocationOrigin — issue #664 P2 UI-stickiness", () => {
  it("(a) UI → plugin → plugin keeps UI at the innermost frame", async () => {
    let innermost: string | undefined;
    await runWithInvocationOrigin("ui", undefined, async () => {
      // Outer = UI panel
      expect(currentInvocationOrigin()).toBe("ui");
      await runWithInvocationOrigin("plugin", undefined, async () => {
        // Wrapper plugin handler — UI ancestor present
        expect(currentInvocationOrigin()).toBe("ui");
        await runWithInvocationOrigin("plugin", undefined, async () => {
          // Inner ctx.callTool — still UI
          innermost = currentInvocationOrigin();
        });
      });
    });
    expect(innermost).toBe("ui");
  });

  it("(b) plugin → plugin (no UI ancestor) stays plugin", async () => {
    let innermost: string | undefined;
    await runWithInvocationOrigin("plugin", undefined, async () => {
      expect(currentInvocationOrigin()).toBe("plugin");
      await runWithInvocationOrigin("plugin", undefined, async () => {
        innermost = currentInvocationOrigin();
      });
    });
    expect(innermost).toBe("plugin");
  });

  it("(c) setTimeout boundary preserves the chain (AsyncLocalStorage)", async () => {
    // The chain rides on the async-frame so a setTimeout inside the
    // handler that re-enters the runtime keeps the parent UI origin.
    const observed: string[] = [];
    await runWithInvocationOrigin("ui", undefined, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          observed.push(currentInvocationOrigin() ?? "undefined");
          resolve();
        }, 0);
      });
    });
    expect(observed).toEqual(["ui"]);
  });

  it("(c') queueMicrotask boundary preserves the chain", async () => {
    const observed: string[] = [];
    await runWithInvocationOrigin("ui", undefined, async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          observed.push(currentInvocationOrigin() ?? "undefined");
          resolve();
        });
      });
    });
    expect(observed).toEqual(["ui"]);
  });

  it("(d) concurrent inner calls share the same parent frame", async () => {
    const observed: string[] = [];
    await runWithInvocationOrigin("ui", undefined, async () => {
      // Three concurrent inner ctx.callTool invocations — all should see
      // the same UI ancestor.
      await Promise.all([
        runWithInvocationOrigin("plugin", undefined, async () => {
          observed.push(currentInvocationOrigin() ?? "undefined");
        }),
        runWithInvocationOrigin("plugin", undefined, async () => {
          observed.push(currentInvocationOrigin() ?? "undefined");
        }),
        runWithInvocationOrigin("plugin", undefined, async () => {
          observed.push(currentInvocationOrigin() ?? "undefined");
        }),
      ]);
    });
    expect(observed).toEqual(["ui", "ui", "ui"]);
  });

  it("explicit parentOrigin=ui upgrades current=plugin to ui", async () => {
    // Even without an ancestor scope, an explicit `parentOrigin: "ui"`
    // makes the frame UI. This is the path used by entry points that have
    // a UI ancestor in another process boundary (IPC origin classification).
    let observed: string | undefined;
    await runWithInvocationOrigin("plugin", "ui", async () => {
      observed = currentInvocationOrigin();
    });
    expect(observed).toBe("ui");
  });

  it("outside any scope → currentInvocationOrigin returns undefined", () => {
    expect(currentInvocationOrigin()).toBeUndefined();
  });
});
