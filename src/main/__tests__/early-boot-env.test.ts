/**
 * Early boot environment tests.
 *
 * `runEarlyBootEnv()` is the only place the app touches Chromium's command
 * line, and the command line is frozen once the network service starts — so a
 * switch appended here is process-wide and unobservable to anything that runs
 * later. The guard below pins the one switch that must never come back: the
 * manual host-resolver map was removed with the private-endpoint access path,
 * and reinstating it would reintroduce a DNS override that the SSRF guard
 * (which resolves through Node's `dns.lookup`) cannot see, because the request
 * itself leaves through Chromium's `net.fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessPlatform } from "../../testing/process-platform.js";

const appended: Array<{ name: string; value?: string }> = [];

const mockedElectron = vi.hoisted(() => ({
  app: {
    commandLine: {
      appendSwitch: vi.fn(),
      appendArgument: vi.fn(),
    },
    disableHardwareAcceleration: vi.fn(),
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    setToastActivatorCLSID: vi.fn(),
    getPath: vi.fn(() => ""),
    dock: undefined,
    isPackaged: false,
  },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  registerPluginAssetProtocolScheme: vi.fn(),
  registerMcpAppProtocolScheme: vi.fn(),
  ensureWorkspaceCwd: vi.fn(() => "/tmp/lvis-workspace"),
}));

vi.mock("electron", () => ({
  app: mockedElectron.app,
  protocol: mockedElectron.protocol,
}));
vi.mock("../ensure-workspace-cwd.js", () => ({
  ensureWorkspaceCwd: mockedElectron.ensureWorkspaceCwd,
}));
vi.mock("../plugin-asset-protocol.js", () => ({
  registerPluginAssetProtocolScheme: mockedElectron.registerPluginAssetProtocolScheme,
}));
vi.mock("../mcp-app-protocol.js", () => ({
  registerMcpAppProtocolScheme: mockedElectron.registerMcpAppProtocolScheme,
}));

import { runEarlyBootEnv } from "../early-boot-env.js";

describe("runEarlyBootEnv", () => {
  let userDataPath: string;
  const realPlatform = process.platform;

  beforeEach(() => {
    appended.length = 0;
    vi.clearAllMocks();
    mockedElectron.app.commandLine.appendSwitch.mockImplementation(
      (name: string, value?: string) => {
        appended.push({ name, value });
      },
    );
    userDataPath = mkdtempSync(join(tmpdir(), "early-boot-env-"));
    mockedElectron.app.getPath.mockReturnValue(userDataPath);
    // A settings file written by an older build, still carrying the removed
    // manual host-resolver map. Anything that reads settings at boot will find
    // a syntactically valid map here — so the guard test below fails loudly if
    // a reader and `appendSwitch` are ever reinstated.
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({
        llm: { provider: "openai", hostResolverMap: "10.0.0.10 internal-endpoint.example.com" },
      }),
      "utf-8",
    );
    // The WSL/ozone branch is the one command-line path that is exercised on
    // every platform this suite runs on, so it doubles as proof that the
    // `appendSwitch` recorder above is live.
    setProcessPlatform("linux");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setProcessPlatform(realPlatform);
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("anchors the workspace cwd, registers protocol schemes, and pins the app identity", () => {
    runEarlyBootEnv();

    expect(mockedElectron.ensureWorkspaceCwd).toHaveBeenCalledOnce();
    expect(mockedElectron.registerPluginAssetProtocolScheme).toHaveBeenCalledOnce();
    expect(mockedElectron.registerMcpAppProtocolScheme).toHaveBeenCalledOnce();
    expect(mockedElectron.app.setName).toHaveBeenCalledWith("LVIS");
    expect(mockedElectron.app.setAppUserModelId).toHaveBeenCalledWith("xyz.lvisai.app");
  });

  it("appends no host-resolver-rules switch even when a legacy map is persisted", () => {
    runEarlyBootEnv();

    // Plumbing proof: the WSL branch DID append, so an absent
    // `host-resolver-rules` below is a real absence, not a dead recorder.
    expect(appended).toContainEqual({ name: "ozone-platform-hint", value: "wayland" });
    expect(appended.map((entry) => entry.name)).not.toContain("host-resolver-rules");
    expect(JSON.stringify(appended)).not.toContain("internal-endpoint.example.com");
  });
});
