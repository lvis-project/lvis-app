import { describe, expect, it } from "vitest";
import {
  shouldOpenDemoReactivationOnBoot,
  type DemoStatusProbe,
} from "../demo-reactivation-gate.js";
import type { AppSettings } from "../../types.js";

function settings(
  overrides: Partial<AppSettings["llm"]> = {},
): Pick<AppSettings, "llm"> {
  return {
    llm: {
      authMode: "login",
      provider: "azure-foundry",
      vendors: {},
      streamSmoothing: "none",
      fallbackChain: [],
      ...overrides,
    },
  };
}

describe("shouldOpenDemoReactivationOnBoot", () => {
  it("opens activation when login-mode Azure Foundry demo is not boot-effective", () => {
    const demoStatus: DemoStatusProbe = {
      ok: true,
      activated: false,
      vendor: null,
    };

    expect(shouldOpenDemoReactivationOnBoot(settings(), demoStatus)).toBe(true);
  });

  it("does not open activation when the demo is active for the current process", () => {
    const demoStatus: DemoStatusProbe = {
      ok: true,
      activated: true,
      vendor: "azure-foundry",
    };

    expect(shouldOpenDemoReactivationOnBoot(settings(), demoStatus)).toBe(false);
  });

  it("does not open activation in manual auth mode", () => {
    expect(
      shouldOpenDemoReactivationOnBoot(
        settings({ authMode: "manual" }),
        { ok: true, activated: false, vendor: null },
      ),
    ).toBe(false);
  });

  it("does not open activation for non-demo providers", () => {
    expect(
      shouldOpenDemoReactivationOnBoot(
        settings({ provider: "openai" }),
        { ok: true, activated: false, vendor: null },
      ),
    ).toBe(false);
  });

  it("does not open activation when demo status cannot be trusted", () => {
    expect(
      shouldOpenDemoReactivationOnBoot(settings(), {
        ok: false,
        error: "unauthorized-frame",
      }),
    ).toBe(false);
    expect(shouldOpenDemoReactivationOnBoot(settings(), null)).toBe(false);
  });
});
