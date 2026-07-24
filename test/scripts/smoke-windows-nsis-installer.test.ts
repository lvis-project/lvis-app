import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ACL_QUERY_SCRIPT,
  assertRuntimeNotificationArtifactsRemoved,
  FOREIGN_PROTOCOL_FIXTURE_SCRIPT,
  buildPowerShellScript,
  captureOutputChunk,
  isExactProtocolCommand,
  isExactProtocolIcon,
  isOwnedRuntimeShortcut,
  MAX_OUTPUT_CHARS,
  normalizeToastActivatorClsid,
  parseExecutableFromCommand,
  parseJsonProcessResult,
  REGISTRY_QUERY_SCRIPT,
  validateRegistryQueryResult,
  waitForExactUninstallRegistrationRemoved,
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

function runPowerShellParser(source: string) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    throw new Error(
      "SystemRoot/WINDIR is required for PowerShell parser tests",
    );
  }
  const parserScript = [
    "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:LVIS_POWERSHELL_SOURCE_BASE64))",
    "$tokens = $null",
    "$parseErrors = $null",
    "[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors) | Out-Null",
    "if ($parseErrors.Count -gt 0) {",
    "  $parseErrors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }",
    "  exit 1",
    "}",
  ].join("\n");
  return spawnSync(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      parserScript,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LVIS_POWERSHELL_SOURCE_BASE64: Buffer.from(source, "utf8").toString(
          "base64",
        ),
      },
      timeout: 30_000,
      windowsHide: true,
    },
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

  it("accepts only the full quoted lvis command, case-insensitively", () => {
    const executable = "C:\\Program Files\\LVIS\\LVIS.exe";
    expect(
      isExactProtocolCommand(
        '"c:\\PROGRAM FILES\\lvis\\LVIS.EXE" "%1"',
        executable,
      ),
    ).toBe(true);
    expect(isExactProtocolCommand(executable + ' "%1"', executable)).toBe(
      false,
    );
    expect(
      isExactProtocolCommand('"C:\\Program Files\\LVIS\\LVIS.exe"', executable),
    ).toBe(false);
    expect(
      isExactProtocolCommand(
        '"C:\\Program Files\\LVIS\\LVIS.exe" "%1" --extra',
        executable,
      ),
    ).toBe(false);

    expect(
      isExactProtocolIcon('"c:\\PROGRAM FILES\\lvis\\LVIS.EXE",0', executable),
    ).toBe(true);
    expect(isExactProtocolIcon(`"${executable}"`, executable)).toBe(false);
    expect(isExactProtocolIcon(`"${executable}",1`, executable)).toBe(false);

    expect(
      validateRegistryQueryResult(
        {
          keyExists: true,
          valueExists: true,
          value: "",
          valueKind: "String",
          entries: [],
        },
        {
          hive: "HKLM",
          path: "SOFTWARE\\Classes\\lvis",
          view: "64",
          mode: "value",
        },
      ),
    ).toMatchObject({ valueExists: true, value: "", valueKind: "String" });
  });

  it("accepts only exact Electron-owned runtime shortcut fields", () => {
    const expected = {
      installedExe: "C:\\Program Files\\LVIS\\LVIS.exe",
      installDir: "C:\\Program Files\\LVIS",
      description: "LVIS",
      appUserModelId: "xyz.lvisai.app",
    };
    const owned = {
      target: "c:\\PROGRAM FILES\\lvis\\LVIS.exe",
      workingDirectory: "c:\\PROGRAM FILES\\LVIS",
      arguments: "",
      description: "LVIS",
      appUserModelId: "xyz.lvisai.app",
      toastClsid: "{62fd3efb-b3d2-4235-9402-6979f52c0286}",
    };

    expect(normalizeToastActivatorClsid(owned.toastClsid)).toBe(
      "{62FD3EFB-B3D2-4235-9402-6979F52C0286}",
    );
    expect(
      normalizeToastActivatorClsid("62fd3efb-b3d2-4235-9402-6979f52c0286"),
    ).toBe("{62FD3EFB-B3D2-4235-9402-6979F52C0286}");
    expect(
      normalizeToastActivatorClsid("{62fd3efb-b3d2-4235-9402-6979f52c0286"),
    ).toBeNull();
    expect(
      normalizeToastActivatorClsid("62fd3efb-b3d2-4235-9402-6979f52c0286}"),
    ).toBeNull();
    expect(normalizeToastActivatorClsid("not-a-guid")).toBeNull();

    expect(isOwnedRuntimeShortcut(owned, expected)).toBe(true);
    expect(
      isOwnedRuntimeShortcut(
        { ...owned, target: "C:\\Foreign\\LVIS.exe" },
        expected,
      ),
    ).toBe(false);
    expect(
      isOwnedRuntimeShortcut(
        { ...owned, workingDirectory: "C:\\Foreign" },
        expected,
      ),
    ).toBe(false);
    expect(
      isOwnedRuntimeShortcut({ ...owned, arguments: "--foreign" }, expected),
    ).toBe(false);
    expect(
      isOwnedRuntimeShortcut({ ...owned, description: "Foreign" }, expected),
    ).toBe(false);
    expect(
      isOwnedRuntimeShortcut(
        { ...owned, appUserModelId: "foreign.app" },
        expected,
      ),
    ).toBe(false);
    expect(
      isOwnedRuntimeShortcut({ ...owned, toastClsid: "invalid" }, expected),
    ).toBe(false);
    expect(isOwnedRuntimeShortcut(null, expected)).toBe(false);
    expect(
      isOwnedRuntimeShortcut({ ...owned, target: null }, expected),
    ).toBe(false);
  });

  it("waits for both exact uninstall registry views to disappear", async () => {
    const machineInstall = {
      registryPath:
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LVIS-Test",
      entry: {
        view: "64",
        key: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LVIS-Test",
      },
    };
    const states: Array<Record<string, boolean>> = [
      { "64": true, "32": false },
      { "64": false, "32": true },
      { "64": false, "32": false },
    ];
    const calls: Array<{
      hive: string;
      path: string;
      view: string;
      mode: string;
    }> = [];
    let elapsedMs = 0;
    let round = 0;

    await waitForExactUninstallRegistrationRemoved(machineInstall, 2_000, {
      now: () => elapsedMs,
      queryRegistry: async (hive, path, view, mode) => {
        calls.push({ hive, path, view, mode });
        return { keyExists: states[round]?.[view] ?? false };
      },
      delay: async (delayMs) => {
        expect(delayMs).toBe(500);
        elapsedMs += delayMs;
        round += 1;
      },
    });

    expect(calls.map(({ view }) => view)).toEqual([
      "64",
      "32",
      "64",
      "32",
      "64",
      "32",
    ]);
    for (const call of calls) {
      expect(call).toMatchObject({
        hive: "HKLM",
        path: machineInstall.registryPath,
        mode: "default",
      });
    }
    expect(elapsedMs).toBe(1_000);
  });

  it("fails closed for uninstall registry timeout and invalid queries", async () => {
    const machineInstall = {
      registryPath:
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LVIS-Test",
      entry: {
        view: "64",
        key: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LVIS-Test",
      },
    };
    const views: string[] = [];
    let elapsedMs = 0;
    let timeoutMessage = "";
    try {
      await waitForExactUninstallRegistrationRemoved(machineInstall, 1_000, {
        now: () => elapsedMs,
        queryRegistry: async (_hive, _path, view) => {
          views.push(view);
          return { keyExists: view === "32" };
        },
        delay: async (delayMs) => {
          elapsedMs += delayMs;
        },
      });
      throw new Error("expected the uninstall registration wait to time out");
    } catch (error) {
      timeoutMessage = error instanceof Error ? error.message : String(error);
    }
    expect(views).toEqual(["64", "32", "64", "32"]);
    expect(timeoutMessage).toContain(machineInstall.registryPath);
    expect(timeoutMessage).toContain("key survived in registry views: 32");
    expect(timeoutMessage).toContain(
      `discovered 64-bit key ${machineInstall.entry.key}`,
    );

    await expect(
      waitForExactUninstallRegistrationRemoved(machineInstall, 1_000, {
        now: () => 0,
        queryRegistry: async () => ({}),
        delay: async () => {},
      }),
    ).rejects.toThrow(
      "invalid exact HKLM uninstall registration query contract for 64-bit view",
    );

    const queryFailure = new Error("registry probe failed");
    await expect(
      waitForExactUninstallRegistrationRemoved(machineInstall, 1_000, {
        now: () => 0,
        queryRegistry: async () => {
          throw queryFailure;
        },
        delay: async () => {},
      }),
    ).rejects.toBe(queryFailure);
    await expect(
      waitForExactUninstallRegistrationRemoved(machineInstall, 0),
    ).rejects.toThrow("uninstall registration wait timeout must be positive");
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
      FOREIGN_PROTOCOL_FIXTURE_SCRIPT,
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

  it("binds each ACL rule before SID translation and never reads catch $_", () => {
    expect(ACL_QUERY_SCRIPT).toContain("  $rule = $_\n");
    expect(ACL_QUERY_SCRIPT).toContain(
      "$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    );
    expect(ACL_QUERY_SCRIPT).toContain(
      "catch { $sid = $rule.IdentityReference.Value }",
    );
    expect(ACL_QUERY_SCRIPT).not.toMatch(/catch\s*\{[^}]*\$_/s);
    for (const field of [
      "FileSystemRights",
      "AccessControlType",
      "InheritanceFlags",
      "PropagationFlags",
      "IsInherited",
    ]) {
      expect(ACL_QUERY_SCRIPT).toContain(`$rule.${field}`);
      expect(ACL_QUERY_SCRIPT).not.toContain(`$_.${field}`);
    }
  });

  it.runIf(process.platform === "win32")(
    "parses every generated PowerShell program with the Windows AST parser",
    () => {
      for (const [label, script] of Object.entries({
        registry: REGISTRY_QUERY_SCRIPT,
        acl: ACL_QUERY_SCRIPT,
        foreignProtocolFixture: FOREIGN_PROTOCOL_FIXTURE_SCRIPT,
        notificationCleanup: readRepoFile(
          "build/uninstall-windows-notification-artifacts.ps1",
        ),
      })) {
        const result = runPowerShellParser(script);
        expect(result.error, label).toBeUndefined();
        expect(
          result.status,
          `${label}: ${result.stdout}\n${result.stderr}`,
        ).toBe(0);
      }
    },
  );
  it.runIf(process.platform === "win32")(
    "preserves a real same-target partial-owned shortcut without aborting",
    () => {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) {
        throw new Error("SystemRoot/WINDIR is required for shortcut tests");
      }
      const powerShell = join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const installDir = mkdtempSync(
        join(tmpdir(), "lvis-notification-cleanup-"),
      );
      const installedExe = join(installDir, "LVIS.exe");
      const installMarker = join(
        installDir,
        ".lvis-nsis-per-machine-v1",
      );
      const shortcutName = `LVIS-test-${randomUUID()}`;
      const appUserModelId = `xyz.lvisai.test.${randomUUID()}`;
      let shortcutPath: string | null = null;
      writeFileSync(installedExe, "test executable");
      writeFileSync(installMarker, "");

      try {
        const programsResult = spawnSync(
          powerShell,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "[PSCustomObject]@{ path = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs) } | ConvertTo-Json -Compress",
          ],
          { encoding: "utf8", timeout: 30_000, windowsHide: true },
        );
        expect(programsResult.error).toBeUndefined();
        expect(
          programsResult.status,
          `${programsResult.stdout}\n${programsResult.stderr}`,
        ).toBe(0);
        const programs = JSON.parse(programsResult.stdout.trim()) as {
          path?: unknown;
        };
        expect(typeof programs.path).toBe("string");
        expect((programs.path as string).trim().length).toBeGreaterThan(0);
        shortcutPath = join(programs.path as string, `${shortcutName}.lnk`);
        expect(existsSync(shortcutPath)).toBe(false);

        const createShortcutScript = buildPowerShellScript([
          "$shortcutPath = $env:LVIS_FIXTURE_SHORTCUT_PATH",
          "if ([string]::IsNullOrWhiteSpace($shortcutPath) -or -not [IO.Path]::IsPathRooted($shortcutPath)) { throw 'shortcut fixture path is invalid' }",
          "if (Test-Path -LiteralPath $shortcutPath) { throw 'shortcut fixture already exists' }",
          "$wscript = $null",
          "$shortcut = $null",
          "try {",
          "  $wscript = New-Object -ComObject WScript.Shell",
          "  $shortcut = $wscript.CreateShortcut($shortcutPath)",
          "  $shortcut.TargetPath = $env:LVIS_FIXTURE_EXE",
          "  $shortcut.WorkingDirectory = $env:LVIS_FIXTURE_INSTALL_DIR",
          "  $shortcut.Arguments = ''",
          "  $shortcut.Description = $env:LVIS_FIXTURE_DESCRIPTION",
          "  $shortcut.Save()",
          "}",
          "finally {",
          "  if ($null -ne $shortcut -and [Runtime.InteropServices.Marshal]::IsComObject($shortcut)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }",
          "  if ($null -ne $wscript -and [Runtime.InteropServices.Marshal]::IsComObject($wscript)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($wscript) }",
          "}",
          "[PSCustomObject]@{ path = $shortcutPath } | ConvertTo-Json -Compress",
        ]);
        const createResult = spawnSync(
          powerShell,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            createShortcutScript,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              LVIS_FIXTURE_SHORTCUT_PATH: shortcutPath,
              LVIS_FIXTURE_EXE: installedExe,
              LVIS_FIXTURE_INSTALL_DIR: installDir,
              LVIS_FIXTURE_DESCRIPTION: `${shortcutName}-foreign`,
            },
            timeout: 30_000,
            windowsHide: true,
          },
        );
        expect(createResult.error).toBeUndefined();
        expect(
          createResult.status,
          `${createResult.stdout}\n${createResult.stderr}`,
        ).toBe(0);
        const created = JSON.parse(createResult.stdout.trim()) as {
          path?: unknown;
        };
        expect(created.path).toBe(shortcutPath);
        expect(shortcutPath.endsWith(`${sep}${shortcutName}.lnk`)).toBe(true);
        expect(existsSync(shortcutPath)).toBe(true);
        const before = readFileSync(shortcutPath);

        const cleanupResult = spawnSync(
          powerShell,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(
              repoRoot,
              "build",
              "uninstall-windows-notification-artifacts.ps1",
            ),
            "-InstalledExecutable",
            installedExe,
            "-ShortcutName",
            shortcutName,
            "-AppUserModelId",
            appUserModelId,
            "-InstallMarker",
            installMarker,
          ],
          {
            encoding: "utf8",
            timeout: 60_000,
            windowsHide: true,
          },
        );
        expect(cleanupResult.error).toBeUndefined();
        expect(
          cleanupResult.status,
          `${cleanupResult.stdout}\n${cleanupResult.stderr}`,
        ).toBe(0);
        expect(cleanupResult.stderr.trim()).toBe("");
        const events = cleanupResult.stdout
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map(
            (line) =>
              JSON.parse(line) as {
                component?: string;
                status?: string;
                artifact?: string;
                detail?: string;
              },
          );
        const preserved = events.find(
          (event) =>
            event.component === "lvis-notification-cleanup" &&
            event.status === "foreign-preserved" &&
            event.artifact === "shortcut" &&
            event.detail?.includes(
              "preserved same-target partial-owned shortcut; mismatched fields:",
            ),
        );
        expect(preserved?.detail).toContain("description");
        expect(
          events.some(
            (event) =>
              event.artifact === "shortcut" && event.status === "removed",
          ),
        ).toBe(false);
        expect(
          events.some((event) => event.status === "contract-failed"),
        ).toBe(false);
        expect(existsSync(shortcutPath)).toBe(true);
        expect(readFileSync(shortcutPath)).toEqual(before);
      } finally {
        try {
          if (shortcutPath && existsSync(shortcutPath)) {
            const shortcut = lstatSync(shortcutPath);
            if (!shortcut.isFile() || shortcut.isSymbolicLink()) {
              throw new Error(
                `refusing to remove non-regular shortcut fixture: ${shortcutPath}`,
              );
            }
            rmSync(shortcutPath, { force: true });
          }
        } finally {
          const resolvedTemp = resolve(tmpdir()).toLowerCase();
          const resolvedFixture = resolve(installDir).toLowerCase();
          if (!resolvedFixture.startsWith(`${resolvedTemp}${sep}`)) {
            throw new Error(
              `refusing to remove fixture outside temp: ${installDir}`,
            );
          }
          rmSync(installDir, { recursive: true, force: true });
        }
      }
    },
    90_000,
  );

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
      valueKind: null,
      entries: [validEntry],
    };
    const missingKey = {
      keyExists: false,
      valueExists: false,
      value: null,
      valueKind: null,
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
          valueKind: null,
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
          valueKind: "String",
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
          valueKind: "String",
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
        name: "missing valueKind contract",
        context: defaultContext,
        result: {
          keyExists: true,
          valueExists: false,
          value: null,
          entries: [],
        },
        error: /invalid contract/,
      },
      {
        name: "non-string valueKind contract",
        context: defaultContext,
        result: { ...missingKey, valueKind: 7 },
        error: /invalid contract/,
      },
      {
        name: "missing key with a value kind",
        context: defaultContext,
        result: { ...missingKey, valueKind: "String" },
        error: /invalid missing-key state/,
      },
      {
        name: "tree with a value kind",
        context: treeContext,
        result: { ...validTree, valueKind: "String" },
        error: /tree query returned an invalid state/,
      },
      {
        name: "default absent value with a kind",
        context: defaultContext,
        result: { ...missingKey, keyExists: true, valueKind: "String" },
        error: /default query returned an invalid state/,
      },
      {
        name: "default present value with a null kind",
        context: defaultContext,
        result: {
          ...missingKey,
          keyExists: true,
          valueExists: true,
          value: "command",
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
      valueKind: null,
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
      expect(
        validateRegistryQueryResult(parsedDefault, {
          hive: "HKCU",
          path: "SOFTWARE\\Classes\\lvis\\shell\\open\\command",
          view: "64",
          mode: "default",
        }),
      ).toBe(parsedDefault);
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

  it("verifies the complete machine protocol contract and owner-only cleanup", () => {
    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");
    const installer = readRepoFile("build/installer.nsh");

    expect(installer).toContain(
      'WriteRegStr SHELL_CONTEXT "Software\\Classes\\lvis" "" "URL:lvis"',
    );
    expect(installer).toContain(
      'WriteRegStr SHELL_CONTEXT "Software\\Classes\\lvis" "URL Protocol" ""',
    );
    const expectedProtocolCommand =
      "'\"" + "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" + '" "%1"\'';
    expect(installer).toContain(
      'WriteRegStr SHELL_CONTEXT "Software\\Classes\\lvis\\shell\\open\\command" "" ' +
        expectedProtocolCommand,
    );
    expect(installer).toContain(
      'WriteRegStr SHELL_CONTEXT "Software\\Classes\\lvis\\DefaultIcon" ""',
    );

    const cleanupStart = installer.indexOf("lvis_remove_files_done:");
    const cleanupEnd = installer.indexOf("lvis_protocol_cleanup_done:");
    const cleanup = installer.slice(cleanupStart, cleanupEnd);
    expect(cleanupStart).toBeGreaterThan(
      installer.indexOf('RMDir /r "$INSTDIR"'),
    );
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    expect(cleanup).toContain("${if} ${isUpdated}");
    expect(cleanup).toContain('${GetOptions} $R0 "--updated" $R1');
    const firstOwnerRead = cleanup.indexOf("ReadRegStr $R1 SHELL_CONTEXT");
    expect(
      cleanup
        .slice(0, firstOwnerRead)
        .match(/Goto lvis_protocol_cleanup_done/g),
    ).toHaveLength(2);
    expect(cleanup).toContain(
      'ReadRegStr $R1 SHELL_CONTEXT "Software\\Classes\\lvis\\shell\\open\\command" ""',
    );
    expect(cleanup).toContain(
      'ReadRegStr $R1 HKEY_CURRENT_USER "Software\\Classes\\lvis\\shell\\open\\command" ""',
    );
    expect(cleanup).toContain("StrCmp $R1 $R2");
    expect(cleanup).toContain(
      "StrCpy $R0 '\"$INSTDIR\\${APP_EXECUTABLE_FILENAME}\",0'",
    );
    expect(cleanup).not.toContain(
      "StrCpy $R0 '$INSTDIR\\${APP_EXECUTABLE_FILENAME}",
    );
    expect(
      cleanup.match(
        /ReadRegStr \$R1 (?:SHELL_CONTEXT|HKEY_CURRENT_USER) "Software\\Classes\\lvis\\DefaultIcon" ""/g,
      ),
    ).toHaveLength(2);
    expect(cleanup.match(/StrCmpS \$R1 "URL:lvis"/g)).toHaveLength(2);
    expect(cleanup).toContain(
      'DeleteRegValue SHELL_CONTEXT "Software\\Classes\\lvis" "URL Protocol"',
    );
    expect(cleanup).toContain(
      'DeleteRegValue HKEY_CURRENT_USER "Software\\Classes\\lvis" "URL Protocol"',
    );
    expect(installer).toContain(
      "!macro lvisDeleteExactEmptyRegistryKey _root _parent _child",
    );
    expect(installer).toContain("advapi32::RegOpenKeyExW");
    expect(installer).toContain("shlwapi::SHDeleteEmptyKeyW");
    expect(installer).toContain(
      "IntOp $0 $0 | ${LVIS_KEY_WOW64_64KEY}",
    );
    expect(installer).toContain(
      "IntOp $0 $0 | ${LVIS_KEY_WOW64_32KEY}",
    );
    expect(
      cleanup.match(
        /!insertmacro lvisDeleteExactEmptyRegistryKey 0x8000000[12] "Software\\Classes/g,
      ),
    ).toHaveLength(10);
    expect(
      cleanup.match(/!insertmacro lvisDeleteExactEmptyRegistryKey 0x80000002/g),
    ).toHaveLength(5);
    expect(
      cleanup.match(/!insertmacro lvisDeleteExactEmptyRegistryKey 0x80000001/g),
    ).toHaveLength(5);
    expect(installer).not.toContain(
      "!macro lvisDeleteRegKeyIfNoValuesOrSubkeys",
    );
    expect(cleanup).not.toMatch(
      /^\s*DeleteRegKey .*Software\\Classes\\lvis/m,
    );

    expect(smoke).toContain("LVIS_REGISTRY_VALUE_NAME");
    expect(smoke).toContain('registration.rootDefault !== "URL:lvis"');
    expect(smoke).toContain('registration.urlProtocol !== ""');
    expect(smoke).toContain('registration.urlProtocolKind !== "String"');
    expect(smoke).toContain("urlProtocolKind: urlProtocol.valueKind");
    expect(smoke).toContain(
      "isExactProtocolCommand(registration.command, installedExe)",
    );
    const appStop = smoke.indexOf("await state.runningApp.stop()");
    const hkcuAfterStop = smoke.indexOf(
      'await assertNoCurrentUserProtocolHandlers("installed app launch")',
    );
    const asrtProbe = smoke.indexOf(
      "state.probe = await prepareAsrtUninstallProbe",
    );
    expect(hkcuAfterStop).toBeGreaterThan(appStop);
    expect(hkcuAfterStop).toBeLessThan(asrtProbe);

    expect(installer).toContain(
      "!macro lvisIsExactEmptyUrlProtocolRegSz _root _out",
    );
    expect(installer).toContain("advapi32::RegGetValueW");
    expect(installer).toContain("${LVIS_RRF_RT_REG_SZ}");
    expect(installer).toContain("${LVIS_RRF_NOEXPAND}");
    expect(installer).toContain("${LVIS_RRF_ZEROONFAILURE}");
    expect(installer).toContain("${LVIS_RRF_SUBKEY_WOW6464KEY}");
    expect(installer).toContain("${LVIS_RRF_SUBKEY_WOW6432KEY}");
    expect(installer).toContain("System::Call '*(&i2 65535) p .r2'");
    expect(installer).toContain("${AndIf} $3 = 1");
    expect(installer).toContain("${AndIf} $4 = 2");
    expect(installer).toContain("System::Call '*$2(&i2 .r6)'");
    expect(installer).toContain("${If} $6 = 0");
    expect(cleanup).toContain(
      "!insertmacro lvisIsExactEmptyUrlProtocolRegSz 0x80000002 $R1",
    );
    expect(cleanup).toContain(
      "!insertmacro lvisIsExactEmptyUrlProtocolRegSz 0x80000001 $R1",
    );
    expect(cleanup).not.toMatch(
      /ReadRegStr \$R1 .* "Software\\Classes\\lvis" "URL Protocol"/,
    );
    expect(
      cleanup.match(/!insertmacro lvisIsExactEmptyUrlProtocolRegSz/g),
    ).toHaveLength(2);
    expect(cleanup.match(/StrCmp \$R1 "1" 0 \+2/g)).toHaveLength(2);

    expect(smoke).toContain("PROTOCOL_ICON_REGISTRY_PATH");
    expect(smoke).toContain("defaultIcon:");
    expect(smoke).toContain(
      "isExactProtocolIcon(registration.defaultIcon, installedExe)",
    );
    expect(smoke).not.toContain("protocolCommands(");
    expect(FOREIGN_PROTOCOL_FIXTURE_SCRIPT).toContain(
      "[Microsoft.Win32.RegistryValueKind]::Binary",
    );
    expect(FOREIGN_PROTOCOL_FIXTURE_SCRIPT).toContain(
      "[Microsoft.Win32.RegistryValueKind]::ExpandString",
    );
    expect(smoke).toContain('kind: keepAppData ? "ExpandString" : "Binary"');
    expect(smoke).toContain("LVIS_FOREIGN_PROTOCOL_KIND: fixture.kind");
    expect(FOREIGN_PROTOCOL_FIXTURE_SCRIPT).not.toContain(
      "LVIS_REGISTRY_VIEW -eq '64'",
    );
    expect(FOREIGN_PROTOCOL_FIXTURE_SCRIPT).toContain(
      "function Remove-EmptyFixtureKey",
    );
    expect(REGISTRY_QUERY_SCRIPT).not.toContain(
      "function Remove-EmptyFixtureKey",
    );
    expect(FOREIGN_PROTOCOL_FIXTURE_SCRIPT).toContain(
      "if (([byte[]]$rootKey.GetValue('URL Protocol')).Length -ne 0)",
    );
    expect(FOREIGN_PROTOCOL_FIXTURE_SCRIPT).not.toContain("::DWord");
    expect(FOREIGN_PROTOCOL_FIXTURE_SCRIPT).not.toContain("$fixtureDword");
    expect(FOREIGN_PROTOCOL_FIXTURE_SCRIPT).toContain(
      "foreign named command value was removed",
    );
    expect(FOREIGN_PROTOCOL_FIXTURE_SCRIPT).toContain("'assert-preserved'");
    expect(FOREIGN_PROTOCOL_FIXTURE_SCRIPT).toContain("'cleanup'");

    const uninstallFlow = smoke.slice(
      smoke.indexOf("async function uninstallAndVerify"),
      smoke.indexOf("async function cleanupFailedInstallerPass"),
    );
    const processExit = uninstallFlow.indexOf("await runProcess");
    const uninstallRegistrationBarrier = uninstallFlow.indexOf(
      "await waitForExactUninstallRegistrationRemoved",
    );
    const installedExeRemoval = uninstallFlow.indexOf(
      "await waitForFileRemoved",
    );
    const notificationPostcondition = uninstallFlow.indexOf(
      "await assertRuntimeNotificationArtifactsRemoved(machineInstall)",
    );
    const foreignProtocolPostcondition = uninstallFlow.indexOf(
      "await assertForeignProtocolFixturePreserved",
    );
    for (const index of [
      processExit,
      uninstallRegistrationBarrier,
      installedExeRemoval,
      notificationPostcondition,
      foreignProtocolPostcondition,
    ]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(uninstallRegistrationBarrier).toBeGreaterThan(processExit);
    expect(installedExeRemoval).toBeGreaterThan(uninstallRegistrationBarrier);
    expect(notificationPostcondition).toBeGreaterThan(installedExeRemoval);
    expect(foreignProtocolPostcondition).toBeGreaterThan(
      notificationPostcondition,
    );
    expect(
      uninstallFlow.indexOf("await assertForeignProtocolFixturePreserved"),
    ).toBeLessThan(
      uninstallFlow.indexOf("await cleanupForeignProtocolFixture"),
    );
    expect(
      uninstallFlow.indexOf("await cleanupForeignProtocolFixture"),
    ).toBeLessThan(uninstallFlow.indexOf("await assertUninstalledSurface"));
    const fixtureAttachIndex = smoke.indexOf(
      "state.foreignProtocolFixture = createForeignProtocolFixture(keepAppData)",
    );
    const fixtureSeedIndex = smoke.indexOf(
      "await seedForeignProtocolFixture(state.foreignProtocolFixture)",
    );
    expect(fixtureAttachIndex).toBeGreaterThanOrEqual(0);
    expect(fixtureSeedIndex).toBeGreaterThan(fixtureAttachIndex);
    expect(smoke).toContain("foreignProtocolFixture: null");
  });

  it("enforces notification residue only for exact owned provenance", async () => {
    const unexpectedPathProbe = () => {
      throw new Error("path probe must not run");
    };
    const unexpectedToastProbe = async () => {
      throw new Error("toast probe must not run");
    };
    await expect(
      assertRuntimeNotificationArtifactsRemoved(
        { runtimeShortcutProvenance: null },
        {
          pathExists: unexpectedPathProbe,
          findToastRegistrations: unexpectedToastProbe,
        },
      ),
    ).resolves.toBeUndefined();

    await expect(
      assertRuntimeNotificationArtifactsRemoved(
        {
          runtimeShortcutProvenance: {
            ownedBeforeUninstall: true,
            path: "",
            toastClsid: null,
          },
        },
        {
          pathExists: unexpectedPathProbe,
          findToastRegistrations: unexpectedToastProbe,
        },
      ),
    ).rejects.toThrow("requires owned shortcut path and toast CLSID provenance");

    const owned = {
      runtimeShortcutProvenance: {
        ownedBeforeUninstall: true,
        path: "C:\\Users\\runner\\Programs\\LVIS.lnk",
        toastClsid: "{62FD3EFB-B3D2-4235-9402-6979F52C0286}",
      },
    };
    await expect(
      assertRuntimeNotificationArtifactsRemoved(owned, {
        pathExists: () => true,
        findToastRegistrations: async () => [],
      }),
    ).rejects.toThrow("notification shortcut residue");

    await expect(
      assertRuntimeNotificationArtifactsRemoved(owned, {
        pathExists: () => false,
        findToastRegistrations: async () => [{ view: 64 }],
      }),
    ).rejects.toThrow("notification toast residue in HKCU views 64");

    await expect(
      assertRuntimeNotificationArtifactsRemoved(owned, {
        pathExists: () => false,
        findToastRegistrations: async () => [],
      }),
    ).resolves.toBeUndefined();
  });

  it("requires the genuine uninstaller to clean exact current-user notification artifacts", () => {
    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");
    const installer = readRepoFile("build/installer.nsh");
    const cleanup = readRepoFile(
      "build/uninstall-windows-notification-artifacts.ps1",
    );
    const earlyBoot = readRepoFile("src/main/early-boot-env.ts");

    const runPassStart = smoke.indexOf("async function runInstallerPass");
    const runPassEnd = smoke.indexOf("async function main", runPassStart);
    const runPass = smoke.slice(runPassStart, runPassEnd);
    const appStop = runPass.indexOf("await state.runningApp.stop()");
    const hkcuAfterStop = runPass.indexOf(
      'await assertNoCurrentUserProtocolHandlers("installed app launch")',
    );
    const ownershipAssertion = runPass.indexOf(
      "await assertRuntimeNotificationArtifacts(state.machineInstall)",
    );
    const normalUninstall = runPass.indexOf("await uninstallAndVerify(");

    expect(hkcuAfterStop).toBeGreaterThan(appStop);
    expect(ownershipAssertion).toBeGreaterThan(hkcuAfterStop);
    expect(normalUninstall).toBeGreaterThan(ownershipAssertion);
    expect(runPass).not.toContain(
      "cleanupOwnedRuntimeNotificationArtifacts(state.machineInstall)",
    );

    const failureStart = smoke.indexOf(
      "async function cleanupFailedInstallerPass",
    );
    const failureEnd = smoke.indexOf(
      "async function runInstallerPass",
      failureStart,
    );
    const failureCleanup = smoke.slice(failureStart, failureEnd);
    const failureOwnerCleanup = failureCleanup.indexOf(
      "await cleanupOwnedRuntimeNotificationArtifacts(state.machineInstall)",
    );
    const failureUninstaller = failureCleanup.indexOf(
      "uninstaller process exit",
      failureOwnerCleanup,
    );
    expect(failureOwnerCleanup).toBeGreaterThanOrEqual(0);
    expect(failureUninstaller).toBeGreaterThan(failureOwnerCleanup);

    expect(smoke).toContain("System.AppUserModel.ID");
    expect(smoke).toContain("System.AppUserModel.ToastActivatorCLSID");
    expect(smoke).toContain("toastActivatorRegistrations(toastClsid)");
    expect(smoke).toContain(
      "uninstall left current-user toast CLSID residue",
    );
    expect(smoke).not.toContain("unlinkSync(");

    const customUninstallStart = installer.indexOf("!macro customUnInstall");
    const updaterGate = installer.indexOf(
      '${GetOptions} $R0 "--updated" $R2',
      customUninstallStart,
    );
    const cleanupExitSentinel = installer.indexOf(
      'StrCpy $R4 "1"',
      updaterGate,
    );
    const cleanupFailureSentinel = installer.indexOf(
      'StrCpy $R5 "LVIS notification cleanup did not run"',
      cleanupExitSentinel,
    );
    const productCleanup = installer.indexOf(
      "UAC_AsUser_Call Function un.lvisCleanupCurrentUserNotificationArtifacts",
      cleanupFailureSentinel,
    );
    const cleanupFunctionStart = installer.indexOf(
      "Function un.lvisCleanupCurrentUserNotificationArtifacts",
    );
    const cleanupFunctionEnd = installer.indexOf(
      "FunctionEnd",
      cleanupFunctionStart,
    );
    const cleanupFunction = installer.slice(
      cleanupFunctionStart,
      cleanupFunctionEnd,
    );
    const asrtTeardown = installer.indexOf("ASRT OS sandbox teardown");
    expect(cleanupExitSentinel).toBeGreaterThan(updaterGate);
    expect(cleanupFailureSentinel).toBeGreaterThan(cleanupExitSentinel);
    expect(productCleanup).toBeGreaterThan(cleanupFailureSentinel);
    expect(asrtTeardown).toBeGreaterThan(productCleanup);
    expect(installer).toContain("${UAC_SYNCREGISTERS}");
    expect(installer).toContain("${if} $R4 != 0");

    expect(cleanupFunction).toContain(
      'StrCpy $R6 "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"',
    );
    expect(cleanupFunction).toContain(
      "kernel32::IsWow64Process2(p -1, *i .R7, *i .R8) i .R9",
    );
    expect(cleanupFunction).not.toContain("*i .r7");
    expect(cleanupFunction).toContain(
      "IntCmp $R8 0x014c lvis_notification_powershell_path_ready",
    );
    expect(cleanupFunction).toContain(
      "IntCmp $R8 0x8664 lvis_notification_use_sysnative",
    );
    expect(cleanupFunction).toContain(
      "IntCmp $R8 0xaa64 lvis_notification_use_sysnative",
    );
    expect(cleanupFunction).toContain(
      'StrCpy $R6 "$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"',
    );
    expect(cleanupFunction).toContain("IfErrors lvis_notification_arch_probe_failed");
    expect(cleanupFunction).toContain('IfFileExists "$R6"');
    expect(cleanupFunction).toContain('StrCmp $R4 "error"');
    expect(cleanupFunction).toContain(
      "PowerShell executable is missing at $R6",
    );
    expect(cleanupFunction).toContain(
      "Windows native architecture detection failed",
    );
    expect(installer).toContain("Push $R6");
    expect(installer).toContain("Pop $R6");
    expect(installer).toContain("Push $R7");
    expect(installer).toContain("Pop $R7");
    expect(installer).toContain("Push $R8");
    expect(installer).toContain("Pop $R8");
    expect(installer).toContain("Push $R9");
    expect(installer).toContain("Pop $R9");

    const uninstallFlow = smoke.slice(
      smoke.indexOf("async function uninstallAndVerify"),
      smoke.indexOf("async function cleanupFailedInstallerPass"),
    );
    const processExit = uninstallFlow.indexOf("await runProcess");
    const uninstallRegistrationBarrier = uninstallFlow.indexOf(
      "await waitForExactUninstallRegistrationRemoved",
    );
    const installedExeRemoval = uninstallFlow.indexOf(
      "await waitForFileRemoved",
    );
    const notificationPostcondition = uninstallFlow.indexOf(
      "await assertRuntimeNotificationArtifactsRemoved(machineInstall)",
    );
    const foreignProtocolPostcondition = uninstallFlow.indexOf(
      "await assertForeignProtocolFixturePreserved",
    );
    for (const index of [
      processExit,
      uninstallRegistrationBarrier,
      installedExeRemoval,
      notificationPostcondition,
      foreignProtocolPostcondition,
    ]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(uninstallRegistrationBarrier).toBeGreaterThan(processExit);
    expect(installedExeRemoval).toBeGreaterThan(uninstallRegistrationBarrier);
    expect(notificationPostcondition).toBeGreaterThan(installedExeRemoval);
    expect(notificationPostcondition).toBeLessThan(
      foreignProtocolPostcondition,
    );
    expect(uninstallFlow).toContain(
      "await waitForExactUninstallRegistrationRemoved(machineInstall, timeoutMs);",
    );
    expect(uninstallFlow).toContain(
      "await waitForFileRemoved(machineInstall.installedExe, timeoutMs);",
    );
    expect(smoke).toContain("machineInstall.registryPath");
    expect(smoke).toContain("key survived in registry views:");

    expect(cleanup).toContain("RegistryView]::Registry64");
    expect(cleanup).toContain("RegistryView]::Registry32");
    expect(cleanup).toContain("System.AppUserModel.ID");
    expect(cleanup).toContain("System.AppUserModel.ToastActivatorCLSID");
    expect(cleanup).toContain('GetValueKind("CustomActivator")');
    expect(cleanup).toContain("DoNotExpandEnvironmentNames");
    expect(cleanup).toContain(
      "[System.IO.File]::Move($shortcutPath, $quarantinePath)",
    );
    expect(cleanup).toContain("[System.IO.File]::Delete($quarantinePath)");
    expect(cleanup).toContain(
      "[System.IO.File]::Move($quarantinePath, $shortcutPath)",
    );
    expect(cleanup).toContain(".lvis-nsis-per-machine-v1");
    expect(cleanup).toContain(
      'ValidateSet("removed", "foreign-preserved", "verified-absent", "contract-failed")',
    );
    expect(cleanup).toContain(
      'throw "the exact zero-byte regular NSIS marker contract is unavailable:',
    );
    expect(cleanup).not.toContain(
      "Preserved notification artifacts because the exact NSIS marker contract is unavailable.",
    );
    expect(cleanup).toContain("Get-ShortcutOwnershipMismatches");
    expect(cleanup).toContain(
      "if (-not (Test-SamePath $record.Target $installedExe))",
    );
    expect(cleanup).toContain(
      "preserved same-target partial-owned shortcut; mismatched fields:",
    );
    expect(cleanup).toContain(
      "preserved same-target partial-owned shortcut at final postcondition; mismatched fields:",
    );
    expect(cleanup).not.toContain(
      "same-target shortcut has partial LVIS ownership; mismatched fields:",
    );
    expect(cleanup).not.toContain(
      "a same-target partial-owned shortcut survived; mismatched fields:",
    );
    const mismatchCheck = cleanup.indexOf("if ($mismatches.Count -ne 0)");
    const partialPreserve = cleanup.indexOf(
      "preserved same-target partial-owned shortcut;",
      mismatchCheck,
    );
    const exactOwnedElse = cleanup.indexOf("else {", partialPreserve);
    const quarantineMove = cleanup.indexOf(
      "[System.IO.File]::Move($shortcutPath, $quarantinePath)",
      exactOwnedElse,
    );
    expect(mismatchCheck).toBeGreaterThanOrEqual(0);
    expect(partialPreserve).toBeGreaterThan(mismatchCheck);
    expect(exactOwnedElse).toBeGreaterThan(partialPreserve);
    expect(quarantineMove).toBeGreaterThan(exactOwnedElse);
    expect(cleanup.slice(mismatchCheck, exactOwnedElse)).not.toContain("throw");
    expect(cleanup).toContain(
      "the exact owned shortcut survived the final cleanup postcondition",
    );
    expect(cleanup).toContain(
      'Write-CleanupEvent "contract-failed" "notification-artifacts"',
    );
    expect(cleanup).toContain(
      'Write-CleanupEvent "foreign-preserved" "shortcut"',
    );
    const finalToastCheck = cleanup.indexOf(
      "$remaining = @(Find-ExactToastRegistrations $installedExe)",
    );
    const finalShortcutCheck = cleanup.lastIndexOf(
      "$shortcutResidue = Get-Item",
    );
    expect(finalShortcutCheck).toBeGreaterThan(finalToastCheck);

    expect(earlyBoot).toContain(
      '"{62FD3EFB-B3D2-4235-9402-6979F52C0286}"',
    );
    expect(earlyBoot).toContain("app.setToastActivatorCLSID(");
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
      "0.0.67",
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

  it("attests completed NSIS installs with a final installer-only marker", () => {
    const markerName = ".lvis-nsis-per-machine-v1";
    const installer = readRepoFile("build/installer.nsh");
    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");

    expect(installer).toContain(
      `!define LVIS_NSIS_PER_MACHINE_MARKER "${markerName}"`,
    );
    expect(installer.split(markerName)).toHaveLength(2);
    expect(smoke).toContain(
      `const NSIS_PER_MACHINE_MARKER_NAME = "${markerName}"`,
    );

    const installStart = installer.indexOf("!macro customInstall");
    const installEnd = installer.indexOf("!macroend", installStart);
    const customInstall = installer.slice(installStart, installEnd);
    const uninstallStart = installer.indexOf("!macro customUnInstall");
    const uninstallEnd = installer.indexOf("!macroend", uninstallStart);
    const customUninstall = installer.slice(uninstallStart, uninstallEnd);
    const removeStart = installer.indexOf("!macro customRemoveFiles");
    const removeEnd = installer.indexOf("!macroend", removeStart);
    const customRemoveFiles = installer.slice(removeStart, removeEnd);

    const staleDelete = customInstall.indexOf(
      'Delete "$INSTDIR\\${LVIS_NSIS_PER_MACHINE_MARKER}"',
    );
    const protocolWrite = customInstall.indexOf(
      'WriteRegStr SHELL_CONTEXT "Software\\Classes\\lvis" "" "URL:lvis"',
    );
    const installLocationWrite = customInstall.indexOf(
      'WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"',
    );
    const stickyWriteCheck = customInstall.indexOf(
      'StrCpy $R3 "could not write the per-machine registry contract"',
    );
    const urlTypeReadback = customInstall.indexOf(
      "!insertmacro lvisIsExactEmptyUrlProtocolRegSz 0x80000002 $R1",
    );
    const installLocationReadback = customInstall.indexOf(
      'ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation"',
    );
    const markerCreate = customInstall.indexOf(
      'FileOpen $R1 "$INSTDIR\\${LVIS_NSIS_PER_MACHINE_MARKER}" w',
    );

    expect(staleDelete).toBeGreaterThanOrEqual(0);
    expect(protocolWrite).toBeGreaterThan(staleDelete);
    expect(stickyWriteCheck).toBeGreaterThan(installLocationWrite);
    expect(customInstall.slice(protocolWrite, stickyWriteCheck)).not.toContain(
      "ClearErrors",
    );
    expect(urlTypeReadback).toBeGreaterThan(stickyWriteCheck);
    expect(installLocationReadback).toBeGreaterThan(urlTypeReadback);
    expect(markerCreate).toBeGreaterThan(installLocationReadback);
    expect(customInstall.lastIndexOf("WriteRegStr")).toBeLessThan(markerCreate);
    expect(customInstall).toContain(
      'FileOpen $R1 "$INSTDIR\\${LVIS_NSIS_PER_MACHINE_MARKER}" r',
    );
    expect(customInstall).toContain("FileSeek $R1 0 END $R2");
    expect(customInstall).toContain(
      'Abort "LVIS install failed: $R3; the incomplete marker could not be removed"',
    );
    expect(customInstall.match(/Push \$R[123]/g)).toHaveLength(3);
    expect(customInstall.match(/Pop \$R[123]/g)).toHaveLength(3);
    expect(customUninstall).toContain(
      'StrCpy $R3 "$INSTDIR\\${LVIS_NSIS_PER_MACHINE_MARKER}"',
    );
    expect(customUninstall).not.toContain(
      'FileOpen $R1 "$INSTDIR\\${LVIS_NSIS_PER_MACHINE_MARKER}"',
    );
    expect(customUninstall).not.toContain(
      'Delete "$INSTDIR\\${LVIS_NSIS_PER_MACHINE_MARKER}"',
    );
    expect(customRemoveFiles).not.toContain("LVIS_NSIS_PER_MACHINE_MARKER");

    expect(smoke).toContain(
      "markerPath: join(installLocation, NSIS_PER_MACHINE_MARKER_NAME)",
    );
    expect(smoke).toContain("const marker = statSync(markerPath)");
    expect(smoke).toContain("!marker.isFile() || marker.size !== 0");
    expect(smoke).toContain("uninstall left NSIS per-machine marker");
    expect(smoke).not.toContain("readFileSync(markerPath");
    expect(smoke).not.toContain("writeFileSync(markerPath");
    const discover = smoke.indexOf(
      "state.machineInstall = await installAndDiscover",
    );
    const installedLaunch = smoke.indexOf(
      "state.runningApp = await startInstalledApp",
    );
    expect(installedLaunch).toBeGreaterThan(discover);
    const installAndDiscoverStart = smoke.indexOf(
      "async function installAndDiscover",
    );
    const installAndDiscoverEnd = smoke.indexOf(
      "async function uninstallAndVerify",
      installAndDiscoverStart,
    );
    const installAndDiscover = smoke.slice(
      installAndDiscoverStart,
      installAndDiscoverEnd,
    );
    expect(
      installAndDiscover.indexOf("await assertInstalledSurface"),
    ).toBeLessThan(installAndDiscover.indexOf("return machineInstall"));
    const failureLabel = customInstall.indexOf(
      "lvis_machine_install_contract_failed:",
    );
    expect(failureLabel).toBeGreaterThan(markerCreate);
    expect(
      customInstall.indexOf(
        'Delete "$INSTDIR\\${LVIS_NSIS_PER_MACHINE_MARKER}"',
        failureLabel,
      ),
    ).toBeGreaterThan(failureLabel);
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
