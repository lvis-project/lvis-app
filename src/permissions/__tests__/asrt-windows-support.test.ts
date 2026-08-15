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
  readAsrtWindowsStatus,
  resolveAsrtWindowsReady,
} from "../asrt-windows-support.js";

// ASRT 0.0.73: readAsrtWindowsStatus reads BOTH the sandbox-user and WFP state
// from a SINGLE `srt-win status` spawn (checkWindowsSandboxStatusAsync). Override
// only that one export; everything else (resolveSrtWin, WindowsSandboxError, …)
// stays real so the DI-based install tests are unaffected.
const { checkWindowsSandboxStatusAsyncMock } = vi.hoisted(() => ({
  checkWindowsSandboxStatusAsyncMock: vi.fn(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@anthropic-ai/sandbox-runtime")>();
  return {
    ...actual,
    checkWindowsSandboxStatusAsync: checkWindowsSandboxStatusAsyncMock,
  };
});

/**
 * Whether ASRT still releases the Windows ACLs it took when `initialize` fails.
 *
 * The behaviour being pinned: a partially-initialized sandbox has already
 * granted the sandbox user an ACE on the owner's files. If initialization then
 * throws without revoking, that grant outlives the failure — a sandbox user
 * that never started holding rights on files nobody sandboxed.
 *
 * Locating the block is the whole point, and the previous version of this test
 * did not. It asserted `config = undefined;` and `throw e;` as bare substrings
 * of a 1,500-line bundle, which proves only that those characters appear
 * somewhere, and it pinned the literal
 * `revokeWindowsAcl({ sandboxUserSid: sb, srtWin })` — which is the TEARDOWN
 * call site, a different function from the failure path this test is named for.
 * ASRT could have deleted the rollback from the failure path entirely and every
 * assertion would still have passed, because the teardown call kept them true.
 *
 * So: find the catches that fail initialization closed — identified by clearing
 * the config and rethrowing the value they caught, with a backreference so a
 * rethrow of something else does not match — and require one of them to release
 * the ACLs. ASRT has several such catches, one per subsystem it brings up, and
 * only the filesystem one holds ACLs; scanning all of them and asking whether
 * the release happens inside a failure path is what distinguishes that from the
 * teardown function, which is not a failure path at all. Identifier names are
 * minifier output and are deliberately not pinned; only the shape is.
 */
function rollsBackWindowsAclOnFailedInitialize(source: string): boolean {
  const failClosed = new RegExp(
    String.raw`catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]{0,1500}?)` +
      String.raw`config\s*=\s*undefined\s*;\s*throw\s+\1\s*;`,
    "g",
  );
  for (const match of source.matchAll(failClosed)) {
    const body = match[2] ?? "";
    if (
      /revokeWindowsAcl\(\s*\{\s*sandboxUserSid\s*:/.test(body)
      && /restoreWindowsAcl\(\s*\{\s*sandboxUserSid\s*:/.test(body)
    ) {
      return true;
    }
  }
  return false;
}

function readAsrtSandboxManagerSource(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@anthropic-ai/sandbox-runtime");
  return readFileSync(join(dirname(indexPath), "sandbox", "sandbox-manager.js"), "utf-8");
}

function readAsrtWindowsUtilsSource(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@anthropic-ai/sandbox-runtime");
  return readFileSync(
    join(dirname(indexPath), "sandbox", "windows-sandbox-utils.js"),
    "utf-8",
  );
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
        installWindowsSandboxAsync: async () => {
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
        installWindowsSandboxAsync: async () => ({ cancelled: true }),
        verifyWindowsWfpEgress,
      }),
      grantBackendAcl,
    });

    expect(result).toEqual({ cancelled: true });
    expect(grantBackendAcl).not.toHaveBeenCalled();
    expect(verifyWindowsWfpEgress).not.toHaveBeenCalled();
  });

  it("surfaces an install_timeout WindowsSandboxError distinctly (UAC left open)", async () => {
    // ASRT 0.0.73 installWindowsSandboxAsync throws WindowsSandboxError with code
    // 'install_timeout' when the self-elevating subprocess is killed by the 120s
    // spawn timeout with the UAC consent dialog still open. The adapter must
    // surface that distinctly (not as a generic failure), and must NOT run the
    // backend ACL grant or the WFP verification.
    const { WindowsSandboxError } = await import("@anthropic-ai/sandbox-runtime");
    const grantBackendAcl = vi.fn(async () => undefined);
    const verifyWindowsWfpEgress = vi.fn(async () => undefined);

    await expect(
      installAsrtWindowsSandbox({
        loadRuntime: async () => ({
          installWindowsSandboxAsync: async () => {
            throw new WindowsSandboxError(
              "install_timeout",
              "srt-win install timed out after 120000ms",
              "install",
            );
          },
          verifyWindowsWfpEgress,
        }),
        grantBackendAcl,
      }),
    ).rejects.toThrow(/timed out after 120s/i);

    expect(grantBackendAcl).not.toHaveBeenCalled();
    expect(verifyWindowsWfpEgress).not.toHaveBeenCalled();
  });

  it("refuses an install whose ambient write-deny stamping failed", async () => {
    // ASRT 0.0.73 added an install step that deny-stamps the stock
    // world-writable system dirs for the sandbox user, with its own exit code
    // (17 → 'install_ambient_failed'). The WFP filters and the sandbox user can
    // both be in place when it fails, so the tempting reading is "mostly
    // installed". It is not: the win32 capability LVIS publishes claims
    // `filesystem: true`, and that claim assumes those stamps landed. The
    // adapter must reject the install rather than let a half-stamped machine
    // publish filesystem confinement.
    const { WindowsSandboxError } = await import("@anthropic-ai/sandbox-runtime");
    const grantBackendAcl = vi.fn(async () => undefined);
    const verifyWindowsWfpEgress = vi.fn(async () => undefined);

    await expect(
      installAsrtWindowsSandbox({
        loadRuntime: async () => ({
          installWindowsSandboxAsync: async () => {
            throw new WindowsSandboxError(
              "install_ambient_failed",
              "srt-win install: ambient write-deny stamping failed",
              "install",
            );
          },
          verifyWindowsWfpEgress,
        }),
        grantBackendAcl,
      }),
    ).rejects.toThrow(/deny-stamp the stock world-writable system directories/i);

    // Fail-closed: neither the backend ACL grant nor the readiness verification
    // may run for an install that was not accepted.
    expect(grantBackendAcl).not.toHaveBeenCalled();
    expect(verifyWindowsWfpEgress).not.toHaveBeenCalled();
  });

  it("pins the ambient write-deny exit code the adapter maps", () => {
    // The mapping above is only meaningful while ASRT still emits this code.
    // If upstream renumbers or drops the ambient stamping step, this fails and
    // sends us back to the adapter instead of leaving a mapping for a code that
    // no longer occurs.
    const source = readAsrtWindowsUtilsSource();
    expect(source).toMatch(/case 17:/);
    expect(source).toContain("install_ambient_failed");
  });

  it("pins Windows per-exec filesystem to deny-only", () => {
    // `assertPerExecFilesystemSupported` (asrt-sandbox.ts), the powershell win32
    // refusal, and the MCP-stdio win32 refusal all rest on ONE upstream fact:
    // `srt-win exec` takes --deny-read/--deny-write but no allow grants. Pin it
    // against the installed bundle so a version bump that ADDS allow grants
    // surfaces here — those refusals would then be over-strict, not honest.
    const source = readAsrtWindowsUtilsSource();
    expect(source).toContain("'--deny-read'");
    expect(source).toContain("'--deny-write'");
    expect(source).not.toContain("'--allow-read'");
    expect(source).not.toContain("'--allow-write'");
  });

  it("reads user + WFP from the single checkWindowsSandboxStatusAsync spawn (ASRT 0.0.73)", async () => {
    const ORIGINAL_PLATFORM = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    checkWindowsSandboxStatusAsyncMock.mockResolvedValue({
      user: {
        provisioned: true,
        sid: "S-1-5-21-9",
        groupExists: true,
        inBuiltinUsers: true,
        inSandboxGroup: true,
        hiddenFromLogon: true,
        credPresent: true,
        realUserSid: "S-1-5-21-10",
      },
      wfp: { state: "installed", filters: 3 },
    });
    try {
      const status = await readAsrtWindowsStatus();

      // ONE status spawn — not the old two-spawn (user + wfp) path.
      expect(checkWindowsSandboxStatusAsyncMock).toHaveBeenCalledTimes(1);
      // Threaded the EXPLICIT srt-win descriptor (no implicit fallback since 0.0.67).
      expect(checkWindowsSandboxStatusAsyncMock.mock.calls[0]?.[0]).toMatchObject({
        srtWin: expect.objectContaining({ exe: expect.stringContaining("srt-win") }),
      });
      expect(status).toMatchObject({
        applicable: true,
        userState: "ready",
        wfpState: "installed",
        ready: true,
      });
    } finally {
      Object.defineProperty(process, "platform", {
        value: ORIGINAL_PLATFORM,
        configurable: true,
      });
      checkWindowsSandboxStatusAsyncMock.mockReset();
    }
  });

  it("normalizes the ASRT 0.0.73 ready sandbox-user shape", () => {
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
    // Applied at all — whitespace-tolerant, because the argument formatting is
    // the bundler's choice and not a behaviour we are pinning.
    expect(source).toMatch(/grantWindowsAcl\(\s*\{/);
    expect(source).toMatch(/stampWindowsAcl\(\s*\{/);
    // And released again when initialization fails. This is the assertion the
    // test is named for; see the helper for why locating the block matters.
    expect(rollsBackWindowsAclOnFailedInitialize(source)).toBe(true);
  });

  // The assertion above reads a file this repo does not control, so it cannot
  // be mutation-tested without editing `node_modules`. These drive the same
  // predicate over fixtures instead: each is a shape ASRT could plausibly ship,
  // and the first two are exactly what the previous assertions let through.
  describe("the ACL rollback pin", () => {
    /** The shape ASRT ships today, minified names and all. */
    const FAIL_CLOSED = `
      catch (e) {
        if (windowsFsSbUserSid) {
          revokeWindowsAcl({ sandboxUserSid: windowsFsSbUserSid, srtWin });
          restoreWindowsAcl({ sandboxUserSid: windowsFsSbUserSid, srtWin });
        }
        windowsFsSbUserSid = undefined;
        config = undefined;
        throw e;
      }`;
    /** The teardown call site, in a different function. Not a rollback. */
    const TEARDOWN = `
      function releaseWindowsHolds() {
        for (const e of revokeWindowsAcl({ sandboxUserSid: sb, srtWin }) ?? []) log(e);
        for (const e of restoreWindowsAcl({ sandboxUserSid: sb, srtWin }) ?? []) log(e);
      }`;

    it("accepts the release-then-rethrow shape", () => {
      expect(rollsBackWindowsAclOnFailedInitialize(FAIL_CLOSED)).toBe(true);
    });

    it("rejects a failure path that keeps the ACLs it took", () => {
      // The regression that matters: initialization still fails closed, but the
      // sandbox user keeps its ACE. Every assertion this test used to make was
      // satisfied by a source in this state.
      const kept = `
      catch (e) {
        windowsFsSbUserSid = undefined;
        config = undefined;
        throw e;
      }`;
      expect(rollsBackWindowsAclOnFailedInitialize(kept + TEARDOWN)).toBe(false);
    });

    it("does not accept the teardown call site as the failure path", () => {
      // Both release calls are present in the file, just not where they matter.
      expect(rollsBackWindowsAclOnFailedInitialize(TEARDOWN)).toBe(false);
    });

    it("does not pin the minifier's identifier names", () => {
      const renamed = FAIL_CLOSED
        .replaceAll("windowsFsSbUserSid", "q7")
        .replaceAll("catch (e)", "catch(_x)")
        .replaceAll("throw e;", "throw _x;");
      expect(rollsBackWindowsAclOnFailedInitialize(renamed)).toBe(true);
    });

    it("rejects the shipped source once the release calls are taken out of it", () => {
      // The fixtures above are hand-written, so they prove the predicate's logic
      // and not that it is aimed at the real artifact. This mutates the shipped
      // file in memory instead: strip the release calls and the same predicate
      // that passes on ASRT as published must reject what is left.
      const source = readAsrtSandboxManagerSource();
      expect(rollsBackWindowsAclOnFailedInitialize(source)).toBe(true);

      const stripped = source.replaceAll(
        /^[^\n]*(?:revoke|restore)WindowsAcl\(\s*\{\s*sandboxUserSid[^\n]*\n/gm,
        "",
      );
      // Non-vacuous: a strip that matched nothing would make the assertion
      // below true for the wrong reason.
      expect(stripped.length).toBeLessThan(source.length);
      expect(rollsBackWindowsAclOnFailedInitialize(stripped)).toBe(false);
    });

    it("requires the rethrow to carry the value that was caught", () => {
      // A catch that swallows its own error and throws something else is not
      // failing closed, whatever else the block does.
      const swallowed = FAIL_CLOSED.replace("throw e;", "throw new Error('boom');");
      expect(rollsBackWindowsAclOnFailedInitialize(swallowed)).toBe(false);
    });
  });
});
