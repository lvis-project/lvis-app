import { describe, expect, it, vi } from "vitest";
import {
  assertEventEmitAccess,
  assertEventSubscribeAccess,
} from "../access-control.js";

describe("plugin event access control", () => {
  it("rejects private subscriptions before owner/grant resolution", () => {
    const auditLog = vi.fn();
    expect(() => assertEventSubscribeAccess({
      callerPluginId: "plugin-a",
      eventType: "settings.apiKey.openai",
      targetPluginId: undefined,
      getAccessGrant: () => undefined,
      auditLog,
    })).toThrow(/private event/);
    expect(auditLog).toHaveBeenCalledWith(
      "error",
      "plugin_private_event_access_denied",
      expect.objectContaining({ eventType: "settings.apiKey.openai" }),
    );
  });

  it("rejects private emission even when the event is unowned or self-owned", () => {
    for (const ownerPluginId of [undefined, "plugin-a"]) {
      expect(() => assertEventEmitAccess({
        callerPluginId: "plugin-a",
        eventType: "audit.log",
        ownerPluginId,
      })).toThrow(/private event/);
    }
  });
});
