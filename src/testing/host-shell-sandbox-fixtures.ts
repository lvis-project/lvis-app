import {
  __resetActiveSandboxCapabilityForTest,
  setActiveSandboxCapability,
  setSandboxRequestedAtBoot,
} from "../permissions/sandbox-capability.js";
import { setProcessPlatform } from "./process-platform.js";

export type HostShellSandboxFixturePlatform = "darwin" | "linux" | "win32";

export function partialWindowsAsrt(): void {
  setProcessPlatform("win32");
  setSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason: "srt-win partial",
    confines: { filesystem: true, process: false, network: true },
  });
}

export function requestedSandboxUnavailable(
  platform: HostShellSandboxFixturePlatform,
): void {
  setProcessPlatform(platform);
  __resetActiveSandboxCapabilityForTest();
  setSandboxRequestedAtBoot(true);
}
