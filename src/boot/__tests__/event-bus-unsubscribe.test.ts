import { describe, expect, it } from "vitest";
import { emitEvent, onEvent, offEvent } from "../types.js";

/**
 * Boot event bus: onEvent() now returns an unsubscribe disposer so
 * PluginRuntime.onDisable can scrub handlers without having to retain the
 * original reference. offEvent() remains available for legacy callers.
 */
describe("boot event bus — unsubscribe", () => {
  it("onEvent returns a disposer that stops further handler calls", () => {
    const received: unknown[] = [];
    const unsubscribe = onEvent(
      "test.boot.unsub",
      (data) => { received.push(data); },
    );

    emitEvent("test.boot.unsub", { n: 1 });
    expect(received).toEqual([{ n: 1 }]);

    unsubscribe();
    emitEvent("test.boot.unsub", { n: 2 });
    expect(received).toEqual([{ n: 1 }]);
  });

  it("disposer is idempotent and safe to call twice", () => {
    const received: unknown[] = [];
    const unsubscribe = onEvent(
      "test.boot.unsub-2",
      (data) => { received.push(data); },
    );
    unsubscribe();
    unsubscribe(); // second call is a no-op, must not throw
    emitEvent("test.boot.unsub-2", "x");
    expect(received).toEqual([]);
  });

  it("offEvent still removes the handler for legacy callers", () => {
    const received: unknown[] = [];
    const handler = (data: unknown) => { received.push(data); };
    onEvent("test.boot.offlegacy", handler);
    offEvent("test.boot.offlegacy", handler);
    emitEvent("test.boot.offlegacy", "y");
    expect(received).toEqual([]);
  });
});
