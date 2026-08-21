import { describe, expect, it, vi } from "vitest";
import { createTailnetObserverConfigService } from "../tailnet-observer-config-service.js";
import type { TailnetObserverConfigFile } from "../tailnet-surface-server.js";
import type { TailnetObserverConfigView } from "../../shared/tailnet-observer-config.js";

const CAPABILITY = "lvis.example.com/cap/conversation-observer";

function service(options: {
  file?: TailnetObserverConfigFile | null;
  env?: NodeJS.ProcessEnv;
  listeningPort?: number | null;
  activeConfig?: {
    port: number;
    expectedAppCapability: string;
    controllerEnabled: boolean;
    pairedSharingEnabled: boolean;
    webOrigin?: string;
  } | null;
  lastStartError?: string | null;
  pairedSharingBootstrapFailed?: boolean;
  writeConfigFile?: (file: TailnetObserverConfigFile) => Promise<void>;
} = {}) {
  return createTailnetObserverConfigService({
    pairedSharingBootstrapFailed: () => options.pairedSharingBootstrapFailed === true,
    readConfigFile: async () => options.file ?? null,
    writeConfigFile: options.writeConfigFile ?? (async () => undefined),
    env: options.env ?? {},
    runtimeState: () => ({
      listeningPort: options.listeningPort ?? null,
      activeConfig: options.activeConfig ?? null,
      lastStartError: options.lastStartError ?? null,
    }),
  });
}

const OFF_VIEW: TailnetObserverConfigView = Object.freeze({
  enabled: false,
  expectedAppCapability: "",
  port: 46_173,
  controllerEnabled: false,
  pairedSharingEnabled: false,
  webEnabled: false,
  webOrigin: "",
});

describe("Tailnet observer configuration service", () => {
  it("reports a never-configured observer as off, not as missing", async () => {
    const snapshot = await service().snapshot();

    expect(snapshot.saved).toEqual(OFF_VIEW);
    expect(snapshot.effective.enabled).toBe(false);
    expect(snapshot.listeningPort).toBeNull();
    expect(snapshot.restartRequired).toBe(false);
  });

  it("separates what is saved from what the environment makes effective", async () => {
    const snapshot = await service({
      file: { enabled: true, expectedAppCapability: CAPABILITY, port: 46_500 },
      env: { LVIS_TAILNET_OBSERVER_PORT: "47000" },
    }).snapshot();

    expect(snapshot.saved.port).toBe(46_500);
    expect(snapshot.effective.port).toBe(47_000);
    expect(snapshot.provenance.port).toBe("env-override");
  });

  it("says a restart is required until the listener matches the resolved config", async () => {
    const file: TailnetObserverConfigFile = {
      enabled: true,
      expectedAppCapability: CAPABILITY,
    };
    const active = {
      port: 46_173,
      expectedAppCapability: CAPABILITY,
      controllerEnabled: false,
      pairedSharingEnabled: false,
    };

    expect((await service({ file, listeningPort: 46_173, activeConfig: active }).snapshot())
      .restartRequired).toBe(false);
    // Saved a different capability than the one the running listener enforces.
    expect((await service({
      file: { ...file, expectedAppCapability: "other/cap/observer" },
      listeningPort: 46_173,
      activeConfig: active,
    }).snapshot()).restartRequired).toBe(true);
    // Turned it off while a listener is still up.
    expect((await service({ listeningPort: 46_173, activeConfig: active }).snapshot())
      .restartRequired).toBe(true);
  });

  it("surfaces the boot failure a log line used to be the only record of", async () => {
    const snapshot = await service({
      lastStartError: "tailnet-web-origin-missing-or-invalid",
      pairedSharingBootstrapFailed: true,
    }).snapshot();

    expect(snapshot.lastStartError).toBe("tailnet-web-origin-missing-or-invalid");
    expect(snapshot.pairedSharingBootstrapFailed).toBe(true);
  });

  it("persists only what was chosen, not the negatives", async () => {
    const writeConfigFile = vi.fn(async () => undefined);
    await service({ writeConfigFile }).apply({
      enabled: true,
      expectedAppCapability: CAPABILITY,
      port: 46_173,
      controllerEnabled: false,
      pairedSharingEnabled: true,
      webEnabled: false,
      webOrigin: "",
    });

    expect(writeConfigFile).toHaveBeenCalledWith({
      enabled: true,
      expectedAppCapability: CAPABILITY,
      pairedSharingEnabled: true,
    });
  });
});
