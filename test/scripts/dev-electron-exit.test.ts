import { describe, it, expect } from "vitest";
import {
  classifyElectronExit,
  DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE,
} from "../../scripts/lib/dev-electron-exit.mjs";

describe("classifyElectronExit", () => {
  it("restarts only for the demo activation managed-relaunch exit code", () => {
    expect(
      classifyElectronExit({
        code: DEMO_ACTIVATION_DEV_RELAUNCH_EXIT_CODE,
        signal: null,
        shuttingDown: false,
        restartInFlight: false,
      }),
    ).toBe("restart");
  });

  it("shuts down the dev loop for ordinary app exits", () => {
    expect(
      classifyElectronExit({
        code: 0,
        signal: null,
        shuttingDown: false,
        restartInFlight: false,
      }),
    ).toBe("shutdown");
  });

  it("ignores expected termination during an existing restart", () => {
    expect(
      classifyElectronExit({
        code: null,
        signal: "SIGTERM",
        shuttingDown: false,
        restartInFlight: true,
      }),
    ).toBe("ignore");
  });
});
