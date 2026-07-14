import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ACL_QUERY_SCRIPT,
  buildPowerShellScript,
  captureOutputChunk,
  MAX_OUTPUT_CHARS,
  parseExecutableFromCommand,
  parseJsonProcessResult,
  REGISTRY_QUERY_SCRIPT,
  validateRegistryQueryResult,
} from "../../scripts/smoke-windows-nsis-installer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

const WINDOWS_UNINSTALL_REGISTRY_PATH =
  "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

function runRegistryQueryScript(overrides: Record<string, string>) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    throw new Error("SystemRoot/WINDIR is required for Windows registry tests");
  }
  const env = { ...process.env };
  delete env.LVIS_REGISTRY_DISPLAY_NAME_FILTER;
  Object.assign(env, overrides);
  return spawnSync(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      REGISTRY_QUERY_SCRIPT,
    ],
    { encoding: "utf8", env, timeout: 30_000, windowsHide: true },
  );
}

describe("Windows NSIS installer smoke contracts", () => {
  it("extracts quoted and unquoted executable paths from registry commands", () => {
    expect(
      parseExecutableFromCommand(
        '"C:\\Program Files\\LVIS\\Uninstall LVIS.exe" /S /allusers',
      ),
    ).toBe("C:\\Program Files\\LVIS\\Uninstall LVIS.exe");
    expect(
      parseExecutableFromCommand('C:\\Program Files\\LVIS\\LVIS.exe "%1"'),
    ).toBe("C:\\Program Files\\LVIS\\LVIS.exe");
  });

  it("preserves PowerShell block boundaries with newlines instead of semicolon joins", () => {
    const blockScript = buildPowerShellScript([
      "switch ($value) {",
      "  'ok' { return $true }",
      "}",
    ]);

    for (const script of [
      blockScript,
      REGISTRY_QUERY_SCRIPT,
      ACL_QUERY_SCRIPT,
    ]) {
      expect(script).toContain("\n");
      expect(script).not.toMatch(/\{\s*;/);
      expect(script).not.toMatch(/;\s*\}/);
    }
    expect(REGISTRY_QUERY_SCRIPT).toContain(
      "$hive = switch ($env:LVIS_REGISTRY_HIVE) {\n",
    );
    expect(REGISTRY_QUERY_SCRIPT).toContain("\ntry {\n");
    expect(ACL_QUERY_SCRIPT).toContain("ForEach-Object {\n");
    expect(() => buildPowerShellScript([])).toThrow(/non-empty string array/);
  });

  it("pre-filters registry trees by an exact display name before enumerating values", () => {
    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");
    const filterRequired = REGISTRY_QUERY_SCRIPT.indexOf(
      "IsNullOrWhiteSpace($env:LVIS_REGISTRY_DISPLAY_NAME_FILTER)",
    );
    const displayNameRead = REGISTRY_QUERY_SCRIPT.indexOf(
      "$displayName = $child.GetValue('DisplayName'",
    );
    const exactComparison = REGISTRY_QUERY_SCRIPT.indexOf(
      "[System.StringComparison]::Ordinal",
    );
    const valueEnumeration = REGISTRY_QUERY_SCRIPT.indexOf(
      "$child.GetValueNames()",
    );

    expect(MAX_OUTPUT_CHARS).toBe(16_000);
    expect(filterRequired).toBeGreaterThanOrEqual(0);
    expect(displayNameRead).toBeGreaterThan(filterRequired);
    expect(exactComparison).toBeGreaterThan(displayNameRead);
    expect(valueEnumeration).toBeGreaterThan(exactComparison);
    expect(REGISTRY_QUERY_SCRIPT).toContain(
      "[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames",
    );
    expect(smoke).toContain(
      "env.LVIS_REGISTRY_DISPLAY_NAME_FILTER = displayNameFilter",
    );
    expect(smoke).toContain("entry.values.DisplayName === displayName");
  });

  it("retains the 16K output tail but reports truncation and rejects unsafe JSON", () => {
    const atLimit = captureOutputChunk("", "x".repeat(MAX_OUTPUT_CHARS));
    expect(atLimit).toEqual({
      output: "x".repeat(MAX_OUTPUT_CHARS),
      truncated: false,
    });

    const truncated = captureOutputChunk(atLimit.output, "tail");
    expect(truncated.output).toHaveLength(MAX_OUTPUT_CHARS);
    expect(truncated.output.endsWith("tail")).toBe(true);
    expect(truncated.truncated).toBe(true);

    const validResult = {
      stdout: '{"ok":true}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    expect(parseJsonProcessResult(validResult, "test process")).toEqual({
      ok: true,
    });
    expect(() =>
      parseJsonProcessResult(
        { ...validResult, stdoutTruncated: true },
        "test process",
      ),
    ).toThrow(/stdout exceeded the 16000-character capture limit/);
    expect(() =>
      parseJsonProcessResult(
        { ...validResult, stderrTruncated: true },
        "test process",
      ),
    ).toThrow(/stderr exceeded the 16000-character capture limit/);
    expect(() =>
      parseJsonProcessResult({ ...validResult, stdout: "   " }, "test process"),
    ).toThrow(/empty JSON output/);
    expect(() =>
      parseJsonProcessResult(
        { ...validResult, stdout: "not json" },
        "test process",
      ),
    ).toThrow(/malformed JSON/);
    expect(() =>
      parseJsonProcessResult(
        { stdout: '{"ok":true}', stderr: "" },
        "test process",
      ),
    ).toThrow(/invalid process output contract/);
  });

  it("enforces registry query state semantics by mode", () => {
    const treeContext = {
      hive: "HKLM",
      path: WINDOWS_UNINSTALL_REGISTRY_PATH,
      view: "64",
      mode: "tree",
    };
    const defaultContext = {
      ...treeContext,
      path: "SOFTWARE\\Classes\\lvis\\shell\\open\\command",
      mode: "default",
    };
    const validEntry = {
      key: `HKEY_LOCAL_MACHINE\\${WINDOWS_UNINSTALL_REGISTRY_PATH}\\LVIS`,
      view: "64",
      values: { DisplayName: "LVIS" },
    };
    const validTree = {
      keyExists: true,
      valueExists: false,
      value: null,
      entries: [validEntry],
    };
    const missingKey = {
      keyExists: false,
      valueExists: false,
      value: null,
      entries: [],
    };

    const validCases = [
      {
        name: "missing tree key",
        context: treeContext,
        result: missingKey,
      },
      {
        name: "missing default key",
        context: defaultContext,
        result: missingKey,
      },
      { name: "tree result", context: treeContext, result: validTree },
      {
        name: "default value absent",
        context: defaultContext,
        result: {
          keyExists: true,
          valueExists: false,
          value: null,
          entries: [],
        },
      },
      {
        name: "default value present",
        context: defaultContext,
        result: {
          keyExists: true,
          valueExists: true,
          value: '"C:\\Program Files\\LVIS\\LVIS.exe" "%1"',
          entries: [],
        },
      },
      {
        name: "default empty string present",
        context: defaultContext,
        result: {
          keyExists: true,
          valueExists: true,
          value: "",
          entries: [],
        },
      },
    ];
    for (const testCase of validCases) {
      expect(
        validateRegistryQueryResult(testCase.result, testCase.context),
        testCase.name,
      ).toBe(testCase.result);
    }

    const invalidCases = [
      {
        name: "unknown mode",
        context: { ...treeContext, mode: "values" },
        result: validTree,
        error: /unsupported registry query validation mode/,
      },
      {
        name: "missing key with an entry",
        context: treeContext,
        result: { ...missingKey, entries: [validEntry] },
        error: /invalid missing-key state/,
      },
      {
        name: "missing key with valueExists and a value",
        context: defaultContext,
        result: { ...missingKey, valueExists: true, value: "command" },
        error: /invalid missing-key state/,
      },
      {
        name: "missing key with a non-null value",
        context: defaultContext,
        result: { ...missingKey, value: "command" },
        error: /invalid missing-key state/,
      },
      {
        name: "tree with valueExists",
        context: treeContext,
        result: { ...validTree, valueExists: true, value: "command" },
        error: /tree query returned an invalid state/,
      },
      {
        name: "tree with a non-null value",
        context: treeContext,
        result: { ...validTree, value: "command" },
        error: /tree query returned an invalid state/,
      },
      {
        name: "default with entries",
        context: defaultContext,
        result: { ...missingKey, keyExists: true, entries: [validEntry] },
        error: /default query returned an invalid state/,
      },
      {
        name: "default absent value with non-null payload",
        context: defaultContext,
        result: { ...missingKey, keyExists: true, value: "command" },
        error: /default query returned an invalid state/,
      },
      {
        name: "default present value with non-string payload",
        context: defaultContext,
        result: {
          ...missingKey,
          keyExists: true,
          valueExists: true,
          value: 7,
        },
        error: /default query returned an invalid state/,
      },
      {
        name: "non-array entries contract",
        context: treeContext,
        result: { ...validTree, entries: "not-an-array" },
        error: /invalid contract/,
      },
    ];
    for (const testCase of invalidCases) {
      expect(
        () => validateRegistryQueryResult(testCase.result, testCase.context),
        testCase.name,
      ).toThrow(testCase.error);
    }
  });

  it("rejects malformed registry tree entry shapes before absence checks", () => {
    const context = {
      hive: "HKLM",
      path: WINDOWS_UNINSTALL_REGISTRY_PATH,
      view: "64",
      mode: "tree",
    };
    const validEntry = {
      key: `HKEY_LOCAL_MACHINE\\${WINDOWS_UNINSTALL_REGISTRY_PATH}\\LVIS`,
      view: "64",
      values: { DisplayName: "LVIS" },
    };
    const validResult = {
      keyExists: true,
      valueExists: false,
      value: null,
      entries: [validEntry],
    };

    for (const malformedEntry of [
      null,
      [],
      { ...validEntry, key: "" },
      { ...validEntry, view: "32" },
      { ...validEntry, values: null },
      { ...validEntry, values: [] },
      { ...validEntry, values: { DisplayName: 7 } },
    ]) {
      expect(() =>
        validateRegistryQueryResult(
          { ...validResult, entries: [malformedEntry] },
          context,
        ),
      ).toThrow(/malformed entry/);
    }
  });

  it.runIf(process.platform === "win32")(
    "queries the real uninstall tree with a nonexistent exact filter and keeps JSON small",
    () => {
      const displayNameFilter = `LVIS-NOT-PRESENT-${randomUUID()}-${randomUUID()}`;
      const keyExistence: boolean[] = [];

      for (const view of ["64", "32"]) {
        const result = runRegistryQueryScript({
          LVIS_REGISTRY_HIVE: "HKLM",
          LVIS_REGISTRY_PATH: WINDOWS_UNINSTALL_REGISTRY_PATH,
          LVIS_REGISTRY_VIEW: view,
          LVIS_REGISTRY_MODE: "tree",
          LVIS_REGISTRY_DISPLAY_NAME_FILTER: displayNameFilter,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout.length).toBeLessThan(2_000);
        const parsed = parseJsonProcessResult(
          {
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
          `PowerShell registry ${view}-bit query`,
        );
        expect(parsed.entries).toEqual([]);
        keyExistence.push(parsed.keyExists);
      }
      expect(keyExistence).toContain(true);

      const missingFilter = runRegistryQueryScript({
        LVIS_REGISTRY_HIVE: "HKLM",
        LVIS_REGISTRY_PATH: WINDOWS_UNINSTALL_REGISTRY_PATH,
        LVIS_REGISTRY_VIEW: "64",
        LVIS_REGISTRY_MODE: "tree",
      });
      expect(missingFilter.status).not.toBe(0);
      expect(`${missingFilter.stdout}\n${missingFilter.stderr}`).toContain(
        "LVIS_REGISTRY_DISPLAY_NAME_FILTER is required for tree mode",
      );

      const defaultMode = runRegistryQueryScript({
        LVIS_REGISTRY_HIVE: "HKCU",
        LVIS_REGISTRY_PATH: "SOFTWARE\\Classes\\lvis\\shell\\open\\command",
        LVIS_REGISTRY_VIEW: "64",
        LVIS_REGISTRY_MODE: "default",
      });
      expect(defaultMode.error).toBeUndefined();
      expect(defaultMode.status).toBe(0);
      const parsedDefault = JSON.parse(defaultMode.stdout.trim());
      expect(typeof parsedDefault.keyExists).toBe("boolean");
      expect(parsedDefault.entries).toEqual([]);
    },
  );

  it("uses fail-closed .NET registry views and cross-checks machine uninstall commands", () => {
    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");

    expect(smoke).toContain('const REGISTRY_VIEWS = ["64", "32"]');
    expect(smoke).toContain("[Microsoft.Win32.RegistryHive]::LocalMachine");
    expect(smoke).toContain("[Microsoft.Win32.RegistryHive]::CurrentUser");
    expect(smoke).toContain("[Microsoft.Win32.RegistryView]::Registry64");
    expect(smoke).toContain("[Microsoft.Win32.RegistryView]::Registry32");
    expect(smoke).toContain("$ErrorActionPreference = 'Stop'");
    expect(smoke).toContain("$baseKey.OpenSubKey");
    expect(smoke).toContain('typeof result.keyExists !== "boolean"');
    expect(smoke).not.toContain("registryExecutable");
    expect(smoke).not.toContain("reg.exe");
    expect(smoke).toContain('productUninstallEntries("HKLM")');
    expect(smoke).toContain('productUninstallEntries("HKCU")');
    expect(smoke).toContain("entry.values.InstallLocation");
    expect(smoke).toContain("entry.values.UninstallString");
    expect(smoke).toContain("entry.values.QuietUninstallString");
    expect(smoke).toContain("const exactEntry = await registryQuery(");
    expect(smoke).toMatch(
      /for \(const view of REGISTRY_VIEWS\)[\s\S]+registryPath,\s+view,\s+"default"/,
    );
    expect(smoke).toContain(
      "uninstall left exact HKLM ${view}-bit key (discovered in ${entry.view}-bit view)",
    );
    expect(smoke).toContain("await assertUninstalledSurface(machineInstall)");
    expect(smoke).toContain(
      "await assertUninstalledSurface(state.machineInstall)",
    );
    expect(smoke).not.toContain(
      "assertUninstalledSurface(machineInstall.installDir)",
    );
    expect(smoke).toContain("machineUninstallExecutable(");
    expect(smoke).toContain("/allusers");
    expect(smoke).toContain("/currentuser");
    expect(smoke).toContain('["/S", "/allusers"]');
    expect(smoke).not.toContain('["/S", "/currentuser"]');
    expect(smoke).toContain(
      "pathToFileURL(resolve(process.argv[1])).href === import.meta.url",
    );
    expect(smoke).toContain("if (isEntrypoint) main().catch(failSmoke)");
  });

  it("requires real ASRT preconditions and verifies exact genuine teardown", () => {
    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");

    expect(smoke).toContain('await runAsrtJson(srtWin, ["user", "status"])');
    expect(smoke).toContain('await runAsrtJson(srtWin, ["wfp", "status"])');
    expect(smoke).toContain('raw.state !== "installed"');
    expect(smoke).toMatch(
      /assertAclAllowsReadExecute\(\s*backendRoot,\s*groupSid/,
    );
    expect(smoke).toContain("requireInheritance: true");
    expect(smoke).toContain('"packaged srt-win executable"');
    expect(smoke).toMatch(/"acl",\r?\n\s+"grant"/);
    expect(smoke).toContain('await stopChildProcess(holder, "ACL holder")');
    expect(smoke).toContain("assertAsrtUserRemoved(state.user)");
    expect(smoke).toContain("user[field] !== false");
    expect(smoke).toContain('violations.push("user.sid must be absent")');
    expect(smoke).toContain('"marker_version"');
    expect(smoke).toContain('"marker_user_sid"');
    expect(smoke).toContain('"ca_cert_thumb"');
    expect(smoke).toContain('"ca_cert_pem"');
    expect(smoke).toContain("real_user_sid must be nonempty");
    expect(smoke).toContain("assertWfpRemoved(state.wfp)");
    expect(smoke).toMatch(/assertAclSidAbsent\(\s*probe\.holderTarget/);
    expect(smoke).toContain(
      'const args = ["/S", "/allusers", ...(keepAppData ? ["/KEEP_APP_DATA"] : [])]',
    );
    expect(smoke).toContain("await assertNoPreexistingAsrtState()");
    expect(smoke).toContain("resolveRepositorySrtWin()");
  });

  it("preserves every deduped sentinel during KEEP and removes it during DELETE", () => {
    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");

    expect(smoke).toContain(
      'requiredPackageString(packageJson.build?.productName, "build.productName")',
    );
    expect(smoke).toContain('requiredPackageString(packageJson.name, "name")');
    expect(smoke).toContain("USER_DATA_SENTINEL_CONTENT");
    expect(smoke).toContain("hasExpectedUserDataSentinel(target)");
    expect(smoke).toContain("assertUserDataTargetsExist()");
    expect(smoke).toContain("assertUserDataTargetsRemoved()");
  });

  it("tears ASRT down before KEEP_APP_DATA and skips teardown only for updater uninstall", () => {
    const installer = readRepoFile("build/installer.nsh");
    const updatedGuard = installer.indexOf("${if} ${isUpdated}");
    const updatedArg = installer.indexOf('${GetOptions} $R0 "--updated"');
    const keepOption = installer.indexOf('${GetOptions} $R0 "/KEEP_APP_DATA"');
    const recover = installer.indexOf('"$R2" acl recover --force');
    const teardown = installer.indexOf('"$R2" uninstall');
    const keepBranch = installer.indexOf('${if} $R1 == "1"');

    expect(updatedGuard).toBeGreaterThanOrEqual(0);
    expect(updatedArg).toBeGreaterThan(updatedGuard);
    expect(keepOption).toBeGreaterThan(updatedArg);
    expect(recover).toBeGreaterThan(keepOption);
    expect(teardown).toBeGreaterThan(recover);
    expect(keepBranch).toBeGreaterThan(teardown);
    expect(installer.slice(updatedGuard, keepOption)).toContain(
      "Goto lvis_skip_genuine_uninstall",
    );
    expect(installer.slice(keepOption, recover)).not.toContain(
      "Goto lvis_skip_genuine_uninstall",
    );
    expect(installer).toContain(
      'Abort "LVIS uninstall failed: ASRT holder ACL recovery returned exit $R3"',
    );
    expect(installer).toContain(
      'Abort "LVIS uninstall failed: ASRT teardown returned exit $R3"',
    );
    expect(installer).toContain(
      'Abort "LVIS uninstall failed: packaged srt-win.exe is missing; ASRT teardown cannot be verified"',
    );
    expect(installer).toContain(
      'WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"',
    );

    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      dependencies?: Record<string, string>;
      build?: { nsis?: { deleteAppDataOnUninstall?: boolean } };
    };
    expect(packageJson.dependencies?.["@anthropic-ai/sandbox-runtime"]).toBe(
      "0.0.65",
    );
    expect(packageJson.build?.nsis?.deleteAppDataOnUninstall).toBe(false);
  });

  it("hard-stops timed-out trees and reports pass-specific failure cleanup", () => {
    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");

    expect(smoke).toContain('"taskkill.exe"');
    expect(smoke).toContain('["/PID", String(child.pid), "/T", "/F"]');
    expect(smoke).toContain("did not exit within the 5s termination grace");
    expect(smoke).toContain("async function cleanupFailedInstallerPass");
    expect(smoke).toContain('...(state.keepAppData ? ["/KEEP_APP_DATA"] : [])');
    expect(smoke).toContain("[windows-installer-smoke] cleanup report");
    expect(smoke).toContain("KEEP sentinel content preserved");
    expect(smoke).toContain("DELETE userData absent");
  });

  it("enables machine and destructive gates only on disposable Windows CI", () => {
    const workflow = readRepoFile(".github/workflows/build-installers.yml");
    expect(workflow).toContain(
      "LVIS_ALLOW_DISPOSABLE_WINDOWS_INSTALLER_SMOKE: ${{ matrix.target == 'win' && '1' || '' }}",
    );
    expect(workflow).toContain(
      "LVIS_ALLOW_DESTRUCTIVE_UNINSTALL_SMOKE: ${{ matrix.target == 'win' && '1' || '' }}",
    );

    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");
    expect(smoke).toContain('"LVIS_ALLOW_DISPOSABLE_WINDOWS_INSTALLER_SMOKE"');
    expect(smoke).toContain("assertDisposableSmokeGate()");
  });
});
