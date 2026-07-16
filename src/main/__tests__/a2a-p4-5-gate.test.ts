import { describe, expect, it } from "vitest";
import type { SettingsService } from "../../data/settings-store.js";
import { snapshotA2ARemoteGates } from "../a2a-remote-gates.js";

describe("P4-5 deterministic remote gate", () => {
  it("proves the requested immutable boot-gate state", () => {
    const expected = process.env.A2A_P4_5_GATE_EXPECTED;
    expect(["off", "on"]).toContain(expected);
    const enabled = expected === "on";
    const settings = {
      get: (key: string) => key === "features" ? {} : undefined,
    } as Pick<SettingsService, "get">;
    const gates = snapshotA2ARemoteGates(settings, {
      LVIS_A2A_REMOTE: enabled ? "1" : "0",
      LVIS_A2A_REMOTE_RECEIVER: enabled ? "1" : "0",
    });
    expect(gates).toEqual({
      outboundRouting: enabled,
      receiverProfile: enabled,
    });
    expect(Object.isFrozen(gates)).toBe(true);
  });
});
