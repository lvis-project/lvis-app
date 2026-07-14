import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ACL_QUERY_SCRIPT,
  buildPowerShellScript,
  parseExecutableFromCommand,
  REGISTRY_QUERY_SCRIPT,
} from "../../scripts/smoke-windows-nsis-installer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
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
