/**
 * Windows ASRT sandbox — platform LOGIC tests.
 *
 * These prove the Windows partial-confinement posture WITHOUT a real Windows host:
 * `process.platform` is forced to 'win32' and the pure config/capability/env
 * logic is asserted directly. What is NOT covered here (and cannot be on
 * darwin/CI): the live srt-win install, UAC elevation, and
 * actual WFP egress enforcement — those need a real Windows box (see the PR
 * body's "not verifiable" section).
 *
 * Added to the CI `windows-permission-tests` job (ci.yml, windows-latest) AND
 * runs on darwin/linux too — the platform is faked, so the logic is the same.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPerExecFilesystemSupported,
  buildPerCommandSandboxCustomConfig,
  buildSandboxConfig,
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  hasPerExecFilesystemAllowGrants,
} from "../asrt-sandbox.js";
import {
  sandboxRelaxesCategory,
  isWeakSandbox,
  type SandboxCapability,
} from "../sandbox-capability.js";
import { sandboxConfinementForPlatform } from "../../shared/sandbox-capability-info.js";
import { buildSandboxedChildEnv } from "../../tools/safe-env.js";
// Real ASRT surfaces — pin our mirrored constants + the binShell adapter
// against the package so upstream drift fails CI (not silently desyncs).
import {
  DEFAULT_WINDOWS_PROXY_PORT_RANGE as ASRT_PROXY_PORT_RANGE,
} from "@anthropic-ai/sandbox-runtime";
import { parseWindowsBinShell } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";

const ORIGINAL_PLATFORM = process.platform;
function forcePlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}
afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
  vi.unstubAllEnvs();
});

describe("windows sandbox — mirrored constants pinned against ASRT", () => {
  it("DEFAULT_WINDOWS_PROXY_PORT_RANGE mirrors ASRT's exported value", () => {
    expect(DEFAULT_WINDOWS_PROXY_PORT_RANGE).toEqual([60080, 60089]);
    // Drift guard: if ASRT changes its default, this fails so the proxy bind
    // range never silently desyncs from what the install WFP-permits.
    expect([...DEFAULT_WINDOWS_PROXY_PORT_RANGE]).toEqual([
      ...ASRT_PROXY_PORT_RANGE,
    ]);
  });

});

describe("windows sandbox — buildSandboxConfig emits the windows section on win32", () => {
  it("emits windows.proxyPortRange (default range) without legacy groupName on win32", () => {
    forcePlatform("win32");
    const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true });
    expect(config.windows).toBeDefined();
    expect(config.windows?.proxyPortRange).toEqual([60080, 60089]);
    expect((config.windows as Record<string, unknown>).groupName).toBeUndefined();
  });

  it("honors a trusted non-default proxyPortRange on win32 (enterprise install)", () => {
    forcePlatform("win32");
    const config = buildSandboxConfig({
      allowedDomains: [],
      windows: { proxyPortRange: [61000, 61009] },
    });
    expect(config.windows?.proxyPortRange).toEqual([61000, 61009]);
  });

  it("does NOT emit a windows section off win32 (mac/linux config shape unchanged)", () => {
    for (const platform of ["darwin", "linux"] as const) {
      forcePlatform(platform);
      const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true });
      expect(config.windows).toBeUndefined();
    }
  });
});

describe("windows sandbox — capability is fs+network partial confinement", () => {
  it("sandboxConfinementForPlatform(win32, partial) confines fs+network but not process", () => {
    expect(sandboxConfinementForPlatform("win32", "partial")).toEqual({
      filesystem: true,
      process: false,
      network: true,
    });
  });

  it("mac/linux full confines are unchanged (regression guard)", () => {
    expect(sandboxConfinementForPlatform("darwin", "full")).toEqual({
      filesystem: true,
      process: true,
      network: true,
    });
    expect(sandboxConfinementForPlatform("linux", "full")).toEqual({
      filesystem: true,
      process: true,
      network: true,
    });
  });

  it("the published win32 capability declares process confinement false", () => {
    // The shape boot.ts publishes on win32 (partial ASRT).
    const winCap: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: sandboxConfinementForPlatform("win32", "partial"),
    };
    expect(winCap.confines?.filesystem).toBe(true);
    expect(winCap.confines?.network).toBe(true);
    expect(winCap.confines?.process).toBe(false);
    // Still a verified, non-none ASRT capability → not "weak" by the binary
    // gate; the per-category gate is what makes it partial.
    expect(isWeakSandbox(winCap)).toBe(false);
  });
});

describe("windows sandbox — PR1 sandboxRelaxesCategory now LIVE for win32", () => {
  const winCap = (): SandboxCapability => ({
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
    confines: sandboxConfinementForPlatform("win32", "partial"),
  });

  it("RELAXES network and filesystem-bearing categories covered by Windows ASRT", () => {
    expect(sandboxRelaxesCategory(winCap(), "network")).toBe(true);
    for (const category of ["write", "read", "meta"] as const) {
      expect(sandboxRelaxesCategory(winCap(), category)).toBe(true);
    }
  });

  it("does NOT relax shell because Windows ASRT still has no process isolation", () => {
    expect(sandboxRelaxesCategory(winCap(), "shell")).toBe(false);
  });

  it("mac/linux full ASRT still relaxes ALL categories (dormancy preserved)", () => {
    const fullCap: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
      confines: sandboxConfinementForPlatform("darwin", "full"),
    };
    for (const category of ["network", "write", "shell", "read", "meta"] as const) {
      expect(sandboxRelaxesCategory(fullCap, category)).toBe(true);
    }
  });
});

describe("windows sandbox — binShell threading (the double-shell fix)", () => {
  it("ASRT parseWindowsBinShell accepts 'powershell' (Windows PowerShell)", () => {
    expect(parseWindowsBinShell("powershell")).toEqual({ kind: "powershell" });
  });

  it("ASRT parseWindowsBinShell accepts 'pwsh' (PowerShell Core)", () => {
    expect(parseWindowsBinShell("pwsh")).toEqual({ kind: "pwsh" });
  });

  it("ASRT parseWindowsBinShell accepts an absolute Git Bash path", () => {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(parseWindowsBinShell(gitBash)).toEqual({ kind: "bash", path: gitBash });
  });

  it("ASRT parseWindowsBinShell REJECTS a relative bash name (no silent cmd fallback)", () => {
    // This is why bash.ts only threads an ABSOLUTE resolved shell path on win32.
    expect(() => parseWindowsBinShell("bash")).toThrow();
  });

  it("undefined binShell defaults to cmd in ASRT — the prior double-shell trap", () => {
    // The bug this fixes: powershell.ts pre-rendered `powershell.exe -Command …`
    // AND passed binShell=undefined → ASRT defaulted to cmd → cmd /c "powershell
    // …". Now powershell.ts passes 'powershell' + the bare command instead.
    expect(parseWindowsBinShell(undefined)).toEqual({ kind: "cmd" });
  });
});

describe("windows sandbox — per-exec filesystem grant guard", () => {
  it("rejects non-empty per-exec allowRead/allowWrite on win32 before ASRT sees it", () => {
    forcePlatform("win32");

    expect(hasPerExecFilesystemAllowGrants({ allowWrite: ["C:\\repo"] })).toBe(true);
    expect(() =>
      assertPerExecFilesystemSupported(
        { allowRead: ["C:\\repo"], denyRead: ["C:\\secret"] },
        "test-wrap",
      ),
    ).toThrow(/does not support per-exec filesystem\.allowRead\/allowWrite/i);
    expect(() =>
      assertPerExecFilesystemSupported(
        { allowWrite: ["C:\\repo"], denyWrite: ["C:\\Users\\u\\.ssh"] },
        "test-wrap",
      ),
    ).toThrow(/does not support per-exec filesystem\.allowRead\/allowWrite/i);
  });

  it("permits Windows per-exec deny-only slices and empty allow arrays", () => {
    forcePlatform("win32");

    expect(hasPerExecFilesystemAllowGrants({ denyRead: ["C:\\secret"] })).toBe(false);
    expect(() =>
      assertPerExecFilesystemSupported(
        {
          allowRead: [],
          allowWrite: [],
          denyRead: ["C:\\secret"],
          denyWrite: ["C:\\Users\\u\\.ssh"],
        },
        "test-wrap",
      ),
    ).not.toThrow();
  });

  it("permits per-exec allow grants off Windows", () => {
    forcePlatform("linux");

    expect(() =>
      assertPerExecFilesystemSupported(
        { allowWrite: ["/tmp/repo"], allowRead: ["/tmp/repo"] },
        "test-wrap",
      ),
    ).not.toThrow();
  });

  it("does not materialize omitted filesystem fields as empty arrays", () => {
    const config = buildPerCommandSandboxCustomConfig({
      denyRead: ["/home/u/.ssh"],
      denyWrite: ["/home/u/.config"],
    });
    const fs = config?.filesystem as Record<string, unknown>;

    expect(fs).toEqual({
      denyRead: ["/home/u/.ssh"],
      denyWrite: ["/home/u/.config"],
    });
    expect(Object.prototype.hasOwnProperty.call(fs, "allowRead")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fs, "allowWrite")).toBe(false);
  });

  it("keeps explicitly empty allow arrays when the caller intentionally overrides them", () => {
    const config = buildPerCommandSandboxCustomConfig({
      allowRead: [],
      allowWrite: [],
      denyRead: ["/home/u/.ssh"],
    });
    const fs = config?.filesystem as Record<string, unknown>;

    expect(fs.allowRead).toEqual([]);
    expect(fs.allowWrite).toEqual([]);
    expect(fs.denyRead).toEqual(["/home/u/.ssh"]);
    expect(Object.prototype.hasOwnProperty.call(fs, "denyWrite")).toBe(false);
  });
});

describe("windows sandbox — safe-env preserves SANDBOX_RUNTIME + proxy keys", () => {
  it("propagates SANDBOX_RUNTIME (the benign Windows marker ASRT emits)", () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    // ASRT's wrapped env = process.env + its additions; SANDBOX_RUNTIME is one
    // ASRT sets on Windows. It must survive the allow-list (was previously
    // dropped — added to ASRT_SANDBOX_ENV_KEYS for honesty).
    const wrapped: NodeJS.ProcessEnv = {
      ...process.env,
      SANDBOX_RUNTIME: "1",
      HTTP_PROXY: "http://srt:tok@localhost:60080",
      HTTPS_PROXY: "http://srt:tok@localhost:60080",
    };
    const env = buildSandboxedChildEnv(wrapped);
    expect(env.SANDBOX_RUNTIME).toBe("1");
    expect(env.HTTP_PROXY).toBe("http://srt:tok@localhost:60080");
    expect(env.HTTPS_PROXY).toBe("http://srt:tok@localhost:60080");
  });

  it("still strips host secrets even with the Windows proxy set present", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    const wrapped: NodeJS.ProcessEnv = {
      ...process.env,
      SANDBOX_RUNTIME: "1",
      HTTP_PROXY: "http://srt:tok@localhost:60080",
    };
    const env = buildSandboxedChildEnv(wrapped);
    expect(Object.prototype.hasOwnProperty.call(env, "ANTHROPIC_API_KEY")).toBe(false);
  });
});
