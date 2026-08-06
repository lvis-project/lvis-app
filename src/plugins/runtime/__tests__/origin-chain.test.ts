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
  runWithInvocationReporting,
  currentInvocationReporting,
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
describe("reporting sink on the same chain", () => {
  // The sink used to live only in the caller's execute options, so a nested
  // ctx.callTool built its own options with none — every permission denial on
  // a plugin-emitted call was a silent no-op in the UI. Origin and sink
  // describe the same chain; these pin that they travel together.
  const sink = { onToolEnd: () => {} };

  it("a nested origin scope keeps the outer sink", async () => {
    await runWithInvocationReporting(sink, async () => {
      await runWithInvocationOrigin("plugin", undefined, async () => {
        expect(currentInvocationReporting()).toBe(sink);
      });
    });
  });

  it("survives an async hop inside the handler", async () => {
    await runWithInvocationReporting(sink, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runWithInvocationOrigin("plugin", undefined, async () => {
        await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
        expect(currentInvocationReporting()).toBe(sink);
      });
    });
  });

  it("keeps the outermost sink when an inner invocation publishes its own", async () => {
    const inner = { onToolEnd: () => {} };
    await runWithInvocationReporting(sink, async () => {
      await runWithInvocationReporting(inner, async () => {
        // The user is watching the outer surface, not whatever the inner
        // caller constructed.
        expect(currentInvocationReporting()).toBe(sink);
      });
    });
  });

  it("is undefined outside any invocation", () => {
    expect(currentInvocationReporting()).toBeUndefined();
  });
});
