import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  grantAsrtWindowsBackendAcl,
  installAsrtWindowsSandbox,
  isAsrtWindowsReady,
  normalizeAsrtWindowsUserState,
  normalizeAsrtWindowsWfpState,
  resolveAsrtWindowsReady,
} from "../asrt-windows-support.js";

function readAsrtSandboxManagerSource(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@anthropic-ai/sandbox-runtime");
  return readFileSync(join(dirname(indexPath), "sandbox", "sandbox-manager.js"), "utf-8");
}

describe("asrt-windows-support adapter", () => {
  it("keeps a development package root unchanged and uses absolute System32 icacls", async () => {
    const exec = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => callback(null));
    const packageRoot = String.raw`C:\workspace\lvis\node_modules\@anthropic-ai\sandbox-runtime`;

    await grantAsrtWindowsBackendAcl({
      execFile: exec,
      pathExists: () => true,
      resolvePackageRoot: () => packageRoot,
      systemRoot: String.raw`C:\Windows`,
    });

    expect(exec).toHaveBeenCalledWith(
      String.raw`C:\Windows\System32\icacls.exe`,
      [packageRoot, "/grant", "sandbox-runtime-users:(OI)(CI)(RX)", "/T", "/C"],
      { windowsHide: true },
      expect.any(Function),
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("targets the resolved ASRT package root by default", async () => {
    const exec = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => callback(null));
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(
      require.resolve("@anthropic-ai/sandbox-runtime/package.json"),
    );

    await grantAsrtWindowsBackendAcl({ execFile: exec });

    expect(exec).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]System32[\\/]icacls\.exe$/i),
      expect.arrayContaining([packageRoot]),
      { windowsHide: true },
      expect.any(Function),
    );
  });

  it("maps an exact packaged app.asar segment to the physical unpacked package", async () => {
    const exec = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => callback(null));
    const virtualRoot = String.raw`C:\Program Files\LVIS\resources\app.asar\node_modules\@anthropic-ai\sandbox-runtime`;
    const physicalRoot = String.raw`C:\Program Files\LVIS\resources\app.asar.unpacked\node_modules\@anthropic-ai\sandbox-runtime`;
    const pathExists = vi.fn((path: string) => path === physicalRoot);

    await grantAsrtWindowsBackendAcl({
      execFile: exec,
      pathExists,
      resolvePackageRoot: () => virtualRoot,
      systemRoot: String.raw`C:\Windows`,
    });

    expect(pathExists).toHaveBeenCalledWith(physicalRoot);
    expect(exec).toHaveBeenCalledWith(
      String.raw`C:\Windows\System32\icacls.exe`,
      expect.arrayContaining([physicalRoot]),
      { windowsHide: true },
      expect.any(Function),
    );
  });

  it("does not rewrite a non-matching fooapp.asar.backup path segment", async () => {
    const exec = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => callback(null));
    const packageRoot = String.raw`C:\Program Files\LVIS\resources\fooapp.asar.backup\node_modules\@anthropic-ai\sandbox-runtime`;
    const pathExists = vi.fn((path: string) => path === packageRoot);

    await grantAsrtWindowsBackendAcl({
      execFile: exec,
      pathExists,
      resolvePackageRoot: () => packageRoot,
      systemRoot: String.raw`C:\Windows`,
    });

    expect(pathExists).toHaveBeenCalledWith(packageRoot);
    expect(exec).toHaveBeenCalledWith(
      String.raw`C:\Windows\System32\icacls.exe`,
      expect.arrayContaining([packageRoot]),
      { windowsHide: true },
      expect.any(Function),
    );
  });

  it("does not invoke icacls when the resolved physical target is missing", async () => {
    const exec = vi.fn();
    const warn = vi.fn();
    const virtualRoot = String.raw`C:\Program Files\LVIS\resources\app.asar\node_modules\@anthropic-ai\sandbox-runtime`;

    await expect(
      grantAsrtWindowsBackendAcl({
        execFile: exec,
        pathExists: () => false,
        resolvePackageRoot: () => virtualRoot,
        systemRoot: String.raw`C:\Windows`,
        warn,
      }),
    ).resolves.toBeUndefined();

    expect(exec).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[sandbox] ASRT backend ACL grant failed (non-fatal)",
      expect.objectContaining({
        message: expect.stringContaining("does not exist"),
      }),
    );
  });

  it("keeps non-access ACL failures non-fatal without attempting elevation", async () => {
    const warn = vi.fn();
    const failure = Object.assign(new Error("spawn icacls ENOENT"), {
      code: "ENOENT",
    });
    const exec = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => callback(failure));

    await expect(
      grantAsrtWindowsBackendAcl({
        execFile: exec,
        pathExists: () => true,
        resolvePackageRoot: () => String.raw`C:\asrt`,
        systemRoot: String.raw`C:\Windows`,
        warn,
      }),
    ).resolves.toBeUndefined();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[sandbox] ASRT backend ACL grant failed (non-fatal)",
      failure,
    );
  });

  it.each([5, "EACCES", "EPERM"] as const)(
    "uses the fixed elevated fallback only for access-denied code %s",
    async (code) => {
      const warn = vi.fn();
      const accessDenied = Object.assign(new Error(`icacls access denied: ${code}`), { code });
      const packageRoot = String.raw`C:\Program Files\LVIS\resources\app.asar.unpacked\node_modules\@anthropic-ai\sandbox-runtime`;
      let callCount = 0;
      const exec = vi.fn((
        _file: string,
        _args: readonly string[],
        _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
        callback: (error: Error | null) => void,
      ) => {
        callCount += 1;
        callback(callCount === 1 ? accessDenied : null);
      });

      await grantAsrtWindowsBackendAcl({
        execFile: exec,
        pathExists: () => true,
        resolvePackageRoot: () => packageRoot,
        systemRoot: String.raw`C:\Windows`,
        warn,
      });

      expect(exec).toHaveBeenCalledTimes(2);
      const [powershellPath, elevatedArgs, elevatedOptions] = exec.mock.calls[1]!;
      expect(powershellPath).toBe(
        String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      );
      expect(elevatedArgs).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        expect.any(String),
      ]);
      const encodedCommand = elevatedArgs[elevatedArgs.indexOf("-EncodedCommand") + 1];
      const script = Buffer.from(encodedCommand!, "base64").toString("utf16le");
      expect(script).toContain("Start-Process");
      expect(script).toContain("-Verb RunAs");
      expect(script).not.toContain(packageRoot);
      expect(elevatedOptions).toMatchObject({
        env: {
          LVIS_ASRT_ACL_TARGET: packageRoot,
          LVIS_ASRT_ICACLS_PATH: String.raw`C:\Windows\System32\icacls.exe`,
        },
        windowsHide: true,
      });
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([1223, 1])(
    "keeps elevated ACL cancellation/non-zero exit %s warning-only and non-fatal",
    async (exitCode) => {
      const warn = vi.fn();
      const accessDenied = Object.assign(new Error("icacls exited 5"), { code: 5 });
      const elevatedFailure = Object.assign(new Error(`elevated icacls exited ${exitCode}`), {
        code: exitCode,
      });
      let callCount = 0;
      const exec = vi.fn((
        _file: string,
        _args: readonly string[],
        _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
        callback: (error: Error | null) => void,
      ) => {
        callCount += 1;
        callback(callCount === 1 ? accessDenied : elevatedFailure);
      });

      await expect(
        grantAsrtWindowsBackendAcl({
          execFile: exec,
          pathExists: () => true,
          resolvePackageRoot: () => String.raw`C:\asrt`,
          systemRoot: String.raw`C:\Windows`,
          warn,
        }),
      ).resolves.toBeUndefined();

      expect(exec).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        "[sandbox] ASRT backend ACL elevated grant failed (non-fatal)",
        elevatedFailure,
      );
    },
  );

  it("awaits the backend ACL grant after install and before WFP verification", async () => {
    const events: string[] = [];

    const result = await installAsrtWindowsSandbox({
      loadRuntime: async () => ({
        installWindowsSandbox: () => {
          events.push("install");
          return {
            user: {
              provisioned: true,
              sid: "S-1-5-21-1",
              groupExists: true,
              inBuiltinUsers: true,
              inSandboxGroup: true,
              hiddenFromLogon: true,
              credPresent: true,
            },
            wfp: { state: "cannot-read" },
          };
        },
        verifyWindowsWfpEgress: async () => {
          events.push("verify");
          return { stderr: "BLOCKED" };
        },
      }),
      grantBackendAcl: async () => {
        events.push("acl");
      },
    });

    expect(events).toEqual(["install", "acl", "verify"]);
    expect(result).toEqual({
      userState: "ready",
      wfpState: "cannot-read",
      ready: true,
    });
  });

  it("does not grant the backend ACL when UAC is cancelled", async () => {
    const grantBackendAcl = vi.fn(async () => undefined);
    const verifyWindowsWfpEgress = vi.fn(async () => undefined);

    const result = await installAsrtWindowsSandbox({
      loadRuntime: async () => ({
        installWindowsSandbox: () => ({ cancelled: true }),
        verifyWindowsWfpEgress,
      }),
      grantBackendAcl,
    });

    expect(result).toEqual({ cancelled: true });
    expect(grantBackendAcl).not.toHaveBeenCalled();
    expect(verifyWindowsWfpEgress).not.toHaveBeenCalled();
  });

  it("normalizes the ASRT 0.0.64 ready sandbox-user shape", () => {
    expect(
      normalizeAsrtWindowsUserState({
        provisioned: true,
        sid: "S-1-5-21-1",
        groupExists: true,
        inBuiltinUsers: true,
        inSandboxGroup: true,
        hiddenFromLogon: true,
        credPresent: true,
      }),
    ).toBe("ready");
  });

  it("treats partial sandbox-user provisioning as incomplete, not ready", () => {
    expect(
      normalizeAsrtWindowsUserState({
        provisioned: true,
        sid: "S-1-5-21-1",
        groupExists: true,
      }),
    ).toBe("incomplete");
  });

  it("treats an empty sandbox-user status as absent", () => {
    expect(normalizeAsrtWindowsUserState({})).toBe("absent");
  });

  it("normalizes WFP status conservatively", () => {
    expect(normalizeAsrtWindowsWfpState({ state: "installed" })).toBe("installed");
    expect(normalizeAsrtWindowsWfpState({ state: "cannot-read" })).toBe("cannot-read");
    expect(normalizeAsrtWindowsWfpState({ state: "unexpected-upstream-state" })).toBe("absent");
  });

  it("requires both sandbox user and WFP to be ready", () => {
    expect(isAsrtWindowsReady("ready", "installed")).toBe(true);
    expect(isAsrtWindowsReady("ready", "cannot-read")).toBe(false);
    expect(isAsrtWindowsReady("incomplete", "installed")).toBe(false);
  });

  it("treats cannot-read WFP as ready only when ASRT behavioral verification succeeds", async () => {
    const verified = await resolveAsrtWindowsReady("ready", "cannot-read", async () => ({
      target: "127.0.0.1:49152",
      stderr: "BLOCKED",
    }));
    expect(verified).toBe(true);

    const failed = await resolveAsrtWindowsReady("ready", "cannot-read", async () => {
      throw new Error("WFP egress verification failed");
    });
    expect(failed).toBe(false);

    const absent = await resolveAsrtWindowsReady("ready", "absent", async () => {
      throw new Error("should not verify absent WFP");
    });
    expect(absent).toBe(false);
  });

  it("pins Windows filesystem ACL readiness to ASRT initialize fail-closed behavior", () => {
    const source = readAsrtSandboxManagerSource();
    expect(source).toContain("grantWindowsAcl({");
    expect(source).toContain("stampWindowsAcl({");
    expect(source).toContain("revokeWindowsAcl({ sandboxUserSid: sb, srtWin })");
    expect(source).toContain("restoreWindowsAcl({ sandboxUserSid: sb, srtWin })");
    expect(source).toContain("config = undefined;");
    expect(source).toContain("throw e;");
  });
});
