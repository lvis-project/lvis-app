/**
 * Smoke-test the Windows NSIS setup.exe, not just win-unpacked/LVIS.exe.
 *
 * The packaged-app smoke catches missing runtime files in win-unpacked. This
 * script covers the installer path: silent install, launch installed app,
 * silent uninstall while preserving user data, and an opt-in destructive
 * uninstall pass for CI runners.
 */

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  prepareElectronLaunchArgs,
  prepareElectronLaunchEnv,
} from "./lib/electron-launch-options.mjs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
export const MAX_OUTPUT_CHARS = 16_000;
const DESTRUCTIVE_SMOKE_ENV = "LVIS_ALLOW_DESTRUCTIVE_UNINSTALL_SMOKE";
const DISPOSABLE_SMOKE_ENV = "LVIS_ALLOW_DISPOSABLE_WINDOWS_INSTALLER_SMOKE";
const REGISTRY_VIEWS = ["64", "32"];
const UNINSTALL_REGISTRY_PATH =
  "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const PROTOCOL_REGISTRY_ROOT = "SOFTWARE\\Classes\\lvis";
const PROTOCOL_ICON_REGISTRY_PATH = "SOFTWARE\\Classes\\lvis\\DefaultIcon";
const PROTOCOL_REGISTRY_PATH = "SOFTWARE\\Classes\\lvis\\shell\\open\\command";
const USER_DATA_SENTINEL_NAME = "nsis-smoke-sentinel.txt";
const USER_DATA_SENTINEL_CONTENT = "LVIS Windows uninstall smoke\n";
const NSIS_PER_MACHINE_MARKER_NAME = ".lvis-nsis-per-machine-v1";
const WINDOWS_TOAST_ACTIVATOR_CLSID =
  "{62FD3EFB-B3D2-4235-9402-6979F52C0286}";
const TOAST_CLSID_REGISTRY_ROOT = "SOFTWARE\\Classes\\CLSID";

function usage() {
  process.stdout.write(
    [
      "Usage: node scripts/smoke-windows-nsis-installer.mjs [options]",
      "",
      "Options:",
      "  --installer <path>       NSIS setup.exe path",
      "  --release-dir <path>     Release directory to search (default: release)",
      "  --install-timeout-ms <n> Silent install timeout (default: 180000)",
      "  --launch-timeout-ms <n>  App launch health window (default: 12000)",
      "  --uninstall-timeout-ms <n> Silent uninstall timeout (default: 120000)",
      `  --destructive-user-data-smoke  Also verify full uninstall deletes LVIS user-data paths (or set ${DESTRUCTIVE_SMOKE_ENV}=1)`,
      "  --help                   Show this help",
    ].join("\n") + "\n",
  );
}

function parseArgs(argv) {
  const options = {
    installer: null,
    releaseDir: "release",
    installTimeoutMs: 180_000,
    launchTimeoutMs: 12_000,
    uninstallTimeoutMs: 120_000,
    destructiveUserDataSmoke: process.env[DESTRUCTIVE_SMOKE_ENV] === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--installer") {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new Error("--installer requires a path");
      options.installer = value;
      continue;
    }
    if (arg === "--release-dir") {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new Error("--release-dir requires a path");
      options.releaseDir = value;
      continue;
    }
    if (arg === "--install-timeout-ms") {
      options.installTimeoutMs = parsePositiveInt(
        argv[++i],
        "--install-timeout-ms",
      );
      continue;
    }
    if (arg === "--launch-timeout-ms") {
      options.launchTimeoutMs = parsePositiveInt(
        argv[++i],
        "--launch-timeout-ms",
      );
      continue;
    }
    if (arg === "--uninstall-timeout-ms") {
      options.uninstallTimeoutMs = parsePositiveInt(
        argv[++i],
        "--uninstall-timeout-ms",
      );
      continue;
    }
    if (arg === "--destructive-user-data-smoke") {
      options.destructiveUserDataSmoke = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function walkFiles(dir, depth = 0, maxDepth = 3) {
  if (depth > maxDepth || !existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath, depth + 1, maxDepth));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function findInstaller(options) {
  if (options.installer) {
    const installer = resolve(options.installer);
    if (!existsSync(installer))
      throw new Error(`installer not found: ${installer}`);
    return installer;
  }

  const releaseDir = resolve(options.releaseDir);
  const matches = walkFiles(releaseDir, 0, 1).filter((file) => {
    const name = basename(file).toLowerCase();
    return (
      name.startsWith("lvis-") &&
      name.includes("-windows-") &&
      name.endsWith("-setup.exe")
    );
  });
  if (matches.length === 0) {
    throw new Error(`Windows setup.exe not found in ${releaseDir}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `multiple Windows setup.exe files found: ${matches.join(", ")}`,
    );
  }
  return matches[0];
}

function requiredPackageString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`package.json ${field} must be a non-empty string`);
  }
  return value;
}

function localAppDataInstallDir() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is not set");
  return join(
    localAppData,
    "Programs",
    requiredPackageString(packageJson.name, "name"),
  );
}

function programFilesInstallCandidates() {
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ].filter(Boolean);
  if (roots.length === 0) {
    throw new Error("ProgramW6432/ProgramFiles environment roots are missing");
  }
  const appName = requiredPackageString(
    packageJson.build?.productName,
    "build.productName",
  );
  const unique = new Map();
  for (const root of roots) {
    const candidate = join(root, appName);
    unique.set(normalizeComparablePath(candidate), candidate);
  }
  return [...unique.values()];
}

function powershellExecutable() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("SystemRoot/WINDIR is not set");
  return join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function expandWindowsEnvironment(value) {
  return value.replace(/%([^%]+)%/g, (match, name) => {
    const key = Object.keys(process.env).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return key ? (process.env[key] ?? match) : match;
  });
}

function normalizeComparablePath(value) {
  return normalize(
    expandWindowsEnvironment(value).replace(/[\\/]+$/, ""),
  ).toLowerCase();
}

function samePath(left, right) {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function isPathInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function parseExecutableFromCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) return null;
  const expanded = expandWindowsEnvironment(command.trim());
  const quoted = expanded.match(/^"([^"]+\.exe)"/i);
  if (quoted) return quoted[1];
  return expanded.match(/^(.+?\.exe)(?:\s|$)/i)?.[1] ?? null;
}

export function buildPowerShellScript(lines) {
  if (
    !Array.isArray(lines) ||
    lines.length === 0 ||
    !lines.every((line) => typeof line === "string")
  ) {
    throw new TypeError(
      "PowerShell script lines must be a non-empty string array",
    );
  }
  return lines.join("\n");
}

export const REGISTRY_QUERY_SCRIPT = buildPowerShellScript([
  "$ErrorActionPreference = 'Stop'",
  "$hive = switch ($env:LVIS_REGISTRY_HIVE) {",
  "  'HKLM' { [Microsoft.Win32.RegistryHive]::LocalMachine; break }",
  "  'HKCU' { [Microsoft.Win32.RegistryHive]::CurrentUser; break }",
  '  default { throw "unsupported registry hive: $env:LVIS_REGISTRY_HIVE" }',
  "}",
  "$view = switch ($env:LVIS_REGISTRY_VIEW) {",
  "  '64' { [Microsoft.Win32.RegistryView]::Registry64; break }",
  "  '32' { [Microsoft.Win32.RegistryView]::Registry32; break }",
  '  default { throw "unsupported registry view: $env:LVIS_REGISTRY_VIEW" }',
  "}",
  "$prefix = if ($env:LVIS_REGISTRY_HIVE -eq 'HKLM') { 'HKEY_LOCAL_MACHINE' } else { 'HKEY_CURRENT_USER' }",
  "$baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)",
  "$key = $null",
  "try {",
  "  $key = $baseKey.OpenSubKey($env:LVIS_REGISTRY_PATH, $false)",
  "  if ($null -eq $key) {",
  "    [PSCustomObject]@{ keyExists = $false; valueExists = $false; value = $null; valueKind = $null; entries = @() } | ConvertTo-Json -Depth 6 -Compress",
  "    return",
  "  }",
  "  if ($env:LVIS_REGISTRY_MODE -eq 'default' -or $env:LVIS_REGISTRY_MODE -eq 'value') {",
  "    $valueName = if ($env:LVIS_REGISTRY_MODE -eq 'default') { '' } else { $env:LVIS_REGISTRY_VALUE_NAME }",
  "    $valueExists = @($key.GetValueNames()) -contains $valueName",
  "    $valueKind = if ($valueExists) { [string]$key.GetValueKind($valueName) } else { $null }",
  "    $value = if ($valueExists) { [string]$key.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }",
  "    [PSCustomObject]@{ keyExists = $true; valueExists = $valueExists; value = $value; valueKind = $valueKind; entries = @() } | ConvertTo-Json -Depth 6 -Compress",
  "    return",
  "  }",
  "  if ($env:LVIS_REGISTRY_MODE -ne 'tree') { throw \"unsupported registry query mode: $env:LVIS_REGISTRY_MODE\" }",
  '  if ([string]::IsNullOrWhiteSpace($env:LVIS_REGISTRY_DISPLAY_NAME_FILTER)) { throw "LVIS_REGISTRY_DISPLAY_NAME_FILTER is required for tree mode" }',
  "  $entries = @()",
  "  foreach ($subName in $key.GetSubKeyNames()) {",
  "    $child = $null",
  "    try {",
  "      $child = $key.OpenSubKey($subName, $false)",
  '      if ($null -eq $child) { throw "registry subkey disappeared during query: $subName" }',
  "      $displayName = $child.GetValue('DisplayName', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "      if ($null -eq $displayName -or -not ([string]::Equals([string]$displayName, $env:LVIS_REGISTRY_DISPLAY_NAME_FILTER, [System.StringComparison]::Ordinal))) { continue }",
  "      $values = [ordered]@{}",
  "      foreach ($valueName in $child.GetValueNames()) {",
  "        $name = if ($valueName.Length -eq 0) { '(Default)' } else { $valueName }",
  "        $raw = $child.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "        $values[$name] = if ($null -eq $raw) { $null } else { [string]$raw }",
  "      }",
  '      $entries += [PSCustomObject]@{ key = "$prefix\\$env:LVIS_REGISTRY_PATH\\$subName"; view = $env:LVIS_REGISTRY_VIEW; values = $values }',
  "    } finally {",
  "      if ($null -ne $child) { $child.Dispose() }",
  "    }",
  "  }",
  "  [PSCustomObject]@{ keyExists = $true; valueExists = $false; value = $null; valueKind = $null; entries = @($entries) } | ConvertTo-Json -Depth 6 -Compress",
  "} finally {",
  "  if ($null -ne $key) { $key.Dispose() }",
  "  $baseKey.Dispose()",
  "}",
]);

const FOREIGN_PROTOCOL_FIXTURE_VALUE_NAME = "LVIS NSIS Smoke Foreign";
const FOREIGN_PROTOCOL_FIXTURE_SUBKEY_NAME = "foreign-smoke";

export const FOREIGN_PROTOCOL_FIXTURE_SCRIPT = buildPowerShellScript([
  `$ErrorActionPreference = 'Stop'`,
  `$view = switch ($env:LVIS_REGISTRY_VIEW) {`,
  `  '64' { [Microsoft.Win32.RegistryView]::Registry64; break }`,
  `  '32' { [Microsoft.Win32.RegistryView]::Registry32; break }`,
  `  default { throw "unsupported registry view: $env:LVIS_REGISTRY_VIEW" }`,
  `}`,
  `$rootPath = 'SOFTWARE\\Classes\\lvis'`,
  `$commandPath = 'SOFTWARE\\Classes\\lvis\\shell\\open\\command'`,
  `$iconPath = 'SOFTWARE\\Classes\\lvis\\DefaultIcon'`,
  `$subkeyPath = "$rootPath\\$env:LVIS_FOREIGN_PROTOCOL_SUBKEY_NAME"`,
  `$foreignName = $env:LVIS_FOREIGN_PROTOCOL_VALUE_NAME`,
  `if ([string]::IsNullOrWhiteSpace($env:LVIS_FOREIGN_PROTOCOL_TOKEN)) { throw 'fixture token is required' }`,
  `$token = $env:LVIS_FOREIGN_PROTOCOL_TOKEN`,
  `$baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)`,
  `$expectedUrlProtocolKind = switch ($env:LVIS_FOREIGN_PROTOCOL_KIND) {`,
  `  'ExpandString' { [Microsoft.Win32.RegistryValueKind]::ExpandString; break }`,
  `  'Binary' { [Microsoft.Win32.RegistryValueKind]::Binary; break }`,
  `  default { throw "unsupported foreign URL Protocol kind: $env:LVIS_FOREIGN_PROTOCOL_KIND" }`,
  `}`,
  `function Remove-EmptyFixtureKey([string]$path) {`,
  `  $key = $baseKey.OpenSubKey($path, $false)`,
  `  if ($null -eq $key) { return }`,
  `  try { $empty = @($key.GetValueNames()).Count -eq 0 -and @($key.GetSubKeyNames()).Count -eq 0 } finally { $key.Dispose() }`,
  `  if ($empty) { $baseKey.DeleteSubKey($path, $false) }`,
  `}`,
  `try {`,
  `  switch ($env:LVIS_FOREIGN_PROTOCOL_ACTION) {`,
  `    'seed' {`,
  `      $rootKey = $baseKey.CreateSubKey($rootPath, $true)`,
  `      try {`,
  `        if ($env:LVIS_FOREIGN_PROTOCOL_KIND -eq 'ExpandString') {`,
  `          $rootKey.SetValue('URL Protocol', '', [Microsoft.Win32.RegistryValueKind]::ExpandString)`,
  `        } else {`,
  `          $rootKey.SetValue('URL Protocol', [byte[]]@(), [Microsoft.Win32.RegistryValueKind]::Binary)`,
  `        }`,
  `      } finally { $rootKey.Dispose() }`,
  `      $commandKey = $baseKey.CreateSubKey($commandPath, $true)`,
  `      try { $commandKey.SetValue($foreignName, $token, [Microsoft.Win32.RegistryValueKind]::String) } finally { $commandKey.Dispose() }`,
  `      $foreignKey = $baseKey.CreateSubKey($subkeyPath, $true)`,
  `      try { $foreignKey.SetValue('', $token, [Microsoft.Win32.RegistryValueKind]::String) } finally { $foreignKey.Dispose() }`,
  `      break`,
  `    }`,
  `    'assert-preserved' {`,
  `      $rootKey = $baseKey.OpenSubKey($rootPath, $false)`,
  `      if ($null -eq $rootKey) { throw 'foreign fixture root was removed' }`,
  `      try {`,
  `        $names = @($rootKey.GetValueNames())`,
  `        if ($names -contains '') { throw 'owned lvis root marker survived uninstall' }`,
  `        if (-not ($names -contains 'URL Protocol')) { throw 'foreign wrong-typed URL Protocol was removed' }`,
  `        if ($rootKey.GetValueKind('URL Protocol') -ne $expectedUrlProtocolKind) { throw 'foreign URL Protocol kind changed' }`,
  `        if ($env:LVIS_FOREIGN_PROTOCOL_KIND -eq 'ExpandString') {`,
  `          $foreignUrlProtocolValue = [string]$rootKey.GetValue('URL Protocol', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
  `          if (-not [string]::Equals($foreignUrlProtocolValue, '', [System.StringComparison]::Ordinal)) { throw 'foreign URL Protocol value changed' }`,
  `        } elseif (([byte[]]$rootKey.GetValue('URL Protocol')).Length -ne 0) {`,
  `          throw 'foreign URL Protocol value changed'`,
  `        }`,
  `      } finally { $rootKey.Dispose() }`,
  `      $commandKey = $baseKey.OpenSubKey($commandPath, $false)`,
  `      if ($null -eq $commandKey) { throw 'foreign command value key was removed' }`,
  `      try {`,
  `        $commandNames = @($commandKey.GetValueNames())`,
  `        if ($commandNames -contains '') { throw 'owned lvis command survived uninstall' }`,
  `        if (-not ($commandNames -contains $foreignName)) { throw 'foreign named command value was removed' }`,
  `        if ($commandKey.GetValueKind($foreignName) -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'foreign named command value kind changed' }`,
  `        $foreignValue = [string]$commandKey.GetValue($foreignName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
  `        if (-not [string]::Equals($foreignValue, $token, [System.StringComparison]::Ordinal)) { throw 'foreign named command value changed' }`,
  `      } finally { $commandKey.Dispose() }`,
  `      $iconKey = $baseKey.OpenSubKey($iconPath, $false)`,
  `      if ($null -ne $iconKey) { $iconKey.Dispose(); throw 'owned lvis DefaultIcon key survived uninstall' }`,
  `      $foreignKey = $baseKey.OpenSubKey($subkeyPath, $false)`,
  `      if ($null -eq $foreignKey) { throw 'foreign subkey was removed' }`,
  `      try {`,
  `        if ($foreignKey.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'foreign subkey value kind changed' }`,
  `        $foreignSubValue = [string]$foreignKey.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
  `        if (-not [string]::Equals($foreignSubValue, $token, [System.StringComparison]::Ordinal)) { throw 'foreign subkey value changed' }`,
  `      } finally { $foreignKey.Dispose() }`,
  `      break`,
  `    }`,
  `    'cleanup' {`,
  `      $rootKey = $baseKey.OpenSubKey($rootPath, $true)`,
  `      if ($null -ne $rootKey) {`,
  `        try {`,
  `          $names = @($rootKey.GetValueNames())`,
  `          if ($names -contains 'URL Protocol') {`,
  `            if ($rootKey.GetValueKind('URL Protocol') -ne $expectedUrlProtocolKind) { throw 'refusing to clean changed URL Protocol kind' }`,
  `            if ($env:LVIS_FOREIGN_PROTOCOL_KIND -eq 'ExpandString') {`,
  `              $foreignUrlProtocolValue = [string]$rootKey.GetValue('URL Protocol', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
  `              if (-not [string]::Equals($foreignUrlProtocolValue, '', [System.StringComparison]::Ordinal)) { throw 'refusing to clean changed URL Protocol value' }`,
  `            } elseif (([byte[]]$rootKey.GetValue('URL Protocol')).Length -ne 0) {`,
  `              throw 'refusing to clean changed URL Protocol value'`,
  `            }`,
  `            $rootKey.DeleteValue('URL Protocol', $false)`,
  `          }`,
  `        } finally { $rootKey.Dispose() }`,
  `      }`,
  `      $commandKey = $baseKey.OpenSubKey($commandPath, $true)`,
  `      if ($null -ne $commandKey) {`,
  `        try {`,
  `          $commandNames = @($commandKey.GetValueNames())`,
  `          if ($commandNames -contains $foreignName) {`,
  `            if ($commandKey.GetValueKind($foreignName) -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'refusing to clean changed foreign command value kind' }`,
  `            $foreignValue = [string]$commandKey.GetValue($foreignName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
  `            if (-not [string]::Equals($foreignValue, $token, [System.StringComparison]::Ordinal)) { throw 'refusing to clean changed foreign command value' }`,
  `            $commandKey.DeleteValue($foreignName, $false)`,
  `          }`,
  `        } finally { $commandKey.Dispose() }`,
  `      }`,
  `      $foreignKey = $baseKey.OpenSubKey($subkeyPath, $true)`,
  `      if ($null -ne $foreignKey) {`,
  `        try {`,
  `          if (@($foreignKey.GetValueNames()).Count -ne 1 -or -not (@($foreignKey.GetValueNames()) -contains '') -or @($foreignKey.GetSubKeyNames()).Count -ne 0) { throw 'refusing to clean changed foreign subkey' }`,
  `          if ($foreignKey.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'refusing to clean changed foreign subkey kind' }`,
  `          $foreignSubValue = [string]$foreignKey.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
  `          if (-not [string]::Equals($foreignSubValue, $token, [System.StringComparison]::Ordinal)) { throw 'refusing to clean changed foreign subkey value' }`,
  `          $foreignKey.DeleteValue('', $false)`,
  `        } finally { $foreignKey.Dispose() }`,
  `        $baseKey.DeleteSubKey($subkeyPath, $false)`,
  `      }`,
  `      Remove-EmptyFixtureKey $commandPath`,
  `      Remove-EmptyFixtureKey 'SOFTWARE\\Classes\\lvis\\shell\\open'`,
  `      Remove-EmptyFixtureKey 'SOFTWARE\\Classes\\lvis\\shell'`,
  `      $rootKey = $baseKey.OpenSubKey($rootPath, $false)`,
  `      $rootIsEmpty = $false`,
  `      if ($null -ne $rootKey) {`,
  `        try { $rootIsEmpty = @($rootKey.GetValueNames()).Count -eq 0 -and @($rootKey.GetSubKeyNames()).Count -eq 0 } finally { $rootKey.Dispose() }`,
  `      }`,
  `      if ($rootIsEmpty) { $baseKey.DeleteSubKey($rootPath, $false) }`,
  `      break`,
  `    }`,
  `    default { throw "unsupported foreign fixture action: $env:LVIS_FOREIGN_PROTOCOL_ACTION" }`,
  `  }`,
  `  [PSCustomObject]@{ ok = $true; action = $env:LVIS_FOREIGN_PROTOCOL_ACTION; view = $env:LVIS_REGISTRY_VIEW; kind = $env:LVIS_FOREIGN_PROTOCOL_KIND } | ConvertTo-Json -Compress`,
  `} finally { $baseKey.Dispose() }`,
]);

async function registryQuery(
  hive,
  path,
  view,
  mode,
  displayNameFilter,
  valueName,
) {
  if (
    mode === "tree" &&
    (typeof displayNameFilter !== "string" ||
      displayNameFilter.trim().length === 0)
  ) {
    throw new Error(
      "LVIS_REGISTRY_DISPLAY_NAME_FILTER is required for tree mode",
    );
  }
  if (
    mode === "value" &&
    (typeof valueName !== "string" || valueName.length === 0)
  ) {
    throw new Error("LVIS_REGISTRY_VALUE_NAME is required for value mode");
  }
  const env = {
    LVIS_REGISTRY_HIVE: hive,
    LVIS_REGISTRY_PATH: path,
    LVIS_REGISTRY_VIEW: view,
    LVIS_REGISTRY_MODE: mode,
  };
  if (mode === "tree")
    env.LVIS_REGISTRY_DISPLAY_NAME_FILTER = displayNameFilter;
  if (mode === "value") env.LVIS_REGISTRY_VALUE_NAME = valueName;
  const result = await runPowerShellJson(REGISTRY_QUERY_SCRIPT, env);
  return validateRegistryQueryResult(result, { hive, path, view, mode });
}

export function validateRegistryQueryResult(
  result,
  { hive, path, view, mode },
) {
  if (mode !== "tree" && mode !== "default" && mode !== "value") {
    throw new Error(
      `unsupported registry query validation mode: ${String(mode)}`,
    );
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.keyExists !== "boolean" ||
    typeof result.valueExists !== "boolean" ||
    (result.valueKind !== null &&
      (typeof result.valueKind !== "string" ||
        result.valueKind.length === 0)) ||
    !Array.isArray(result.entries)
  ) {
    throw new Error(
      `registry query returned an invalid contract for ${hive} ${view}-bit ${path}: ${JSON.stringify(result)}`,
    );
  }
  if (
    !result.keyExists &&
    (result.valueExists ||
      result.value !== null ||
      result.valueKind !== null ||
      result.entries.length !== 0)
  ) {
    throw new Error(
      `registry query returned an invalid missing-key state for ${hive} ${view}-bit ${path}: ${JSON.stringify(result)}`,
    );
  }
  if (mode === "tree") {
    if (
      result.valueExists ||
      result.value !== null ||
      result.valueKind !== null
    ) {
      throw new Error(
        `registry tree query returned an invalid state for ${hive} ${view}-bit ${path}: ${JSON.stringify(result)}`,
      );
    }
    for (const entry of result.entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.key !== "string" ||
        entry.key.length === 0 ||
        entry.view !== view ||
        !entry.values ||
        typeof entry.values !== "object" ||
        Array.isArray(entry.values) ||
        typeof entry.values.DisplayName !== "string"
      ) {
        throw new Error(
          `registry tree query returned a malformed entry for ${hive} ${view}-bit ${path}: ${JSON.stringify(result)}`,
        );
      }
    }
  } else if (
    result.entries.length !== 0 ||
    (result.valueExists
      ? typeof result.value !== "string" || typeof result.valueKind !== "string"
      : result.value !== null || result.valueKind !== null)
  ) {
    throw new Error(
      `registry ${mode} query returned an invalid state for ${hive} ${view}-bit ${path}: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function queryRegistryTree(hive, path, view, displayNameFilter) {
  const result = await registryQuery(
    hive,
    path,
    view,
    "tree",
    displayNameFilter,
  );
  return result.keyExists ? result.entries : [];
}

async function queryRegistryDefault(hive, path, view) {
  return await registryQuery(hive, path, view, "default");
}

async function queryRegistryValue(hive, path, view, valueName) {
  return await registryQuery(hive, path, view, "value", undefined, valueName);
}

function productDisplayName() {
  return requiredPackageString(
    packageJson.build?.nsis?.uninstallDisplayName ??
      packageJson.build?.productName,
    "build.nsis.uninstallDisplayName",
  );
}

async function productUninstallEntries(hive) {
  const displayName = productDisplayName();
  const entries = [];
  for (const view of REGISTRY_VIEWS) {
    entries.push(
      ...(await queryRegistryTree(
        hive,
        UNINSTALL_REGISTRY_PATH,
        view,
        displayName,
      )),
    );
  }
  return entries.filter((entry) => entry.values.DisplayName === displayName);
}

function machineUninstallExecutable(command, label) {
  const executable = parseExecutableFromCommand(command);
  if (!executable) {
    throw new Error(`${label} does not start with an executable: ${command}`);
  }
  if (
    !/(?:^|\s)\/allusers(?:\s|$)/i.test(command) ||
    /(?:^|\s)\/currentuser(?:\s|$)/i.test(command)
  ) {
    throw new Error(
      `${label} must contain /allusers and must not contain /currentuser: ${command}`,
    );
  }
  return executable;
}

function resolveMachineInstall(entries) {
  if (entries.length !== 1) {
    throw new Error(
      `expected exactly one HKLM uninstall entry across 32/64-bit views; found ${entries.length}: ${entries
        .map((entry) => `${entry.view}:${entry.key}`)
        .join(", ")}`,
    );
  }

  const entry = entries[0];
  const hklmPrefix = "HKEY_LOCAL_MACHINE\\";
  if (!entry.key.toUpperCase().startsWith(hklmPrefix)) {
    throw new Error(
      `HKLM uninstall entry has an unexpected canonical key: ${entry.key}`,
    );
  }
  const registryPath = entry.key.slice(hklmPrefix.length);
  const installLocation = entry.values.InstallLocation?.replace(/^"|"$/g, "");
  const uninstallString = entry.values.UninstallString;
  const quietUninstallString = entry.values.QuietUninstallString;
  if (!installLocation || !uninstallString || !quietUninstallString) {
    throw new Error(
      `HKLM uninstall entry must expose InstallLocation, UninstallString, and QuietUninstallString: ${entry.key}`,
    );
  }
  const uninstallExe = machineUninstallExecutable(
    uninstallString,
    "UninstallString",
  );
  const quietUninstallExe = machineUninstallExecutable(
    quietUninstallString,
    "QuietUninstallString",
  );
  if (
    !samePath(dirname(uninstallExe), installLocation) ||
    !samePath(quietUninstallExe, uninstallExe)
  ) {
    throw new Error(
      `InstallLocation/uninstall commands disagree: ${installLocation} vs ${uninstallExe} vs ${quietUninstallExe}`,
    );
  }

  const programFilesRoots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ].filter(Boolean);
  if (!programFilesRoots.some((root) => isPathInside(root, installLocation))) {
    throw new Error(
      `perMachine install is outside Program Files: ${installLocation} (roots: ${programFilesRoots.join(", ")})`,
    );
  }

  return {
    entry,
    registryPath,
    installDir: installLocation,
    uninstaller: uninstallExe,
    installedExe: join(installLocation, "LVIS.exe"),
    markerPath: join(installLocation, NSIS_PER_MACHINE_MARKER_NAME),
  };
}

export function parseJsonProcessResult(result, label) {
  if (
    !result ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    typeof result.stdoutTruncated !== "boolean" ||
    typeof result.stderrTruncated !== "boolean"
  ) {
    throw new Error(`${label} returned an invalid process output contract`);
  }
  if (result.stdoutTruncated || result.stderrTruncated) {
    const truncatedStreams = [
      result.stdoutTruncated ? "stdout" : null,
      result.stderrTruncated ? "stderr" : null,
    ].filter(Boolean);
    throw new Error(
      `${label} ${truncatedStreams.join(" and ")} exceeded the ${MAX_OUTPUT_CHARS}-character capture limit`,
    );
  }
  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    throw new Error(`${label} returned empty JSON output`);
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${label} returned malformed JSON: ${error.message}; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
}

async function runPowerShellJson(script, env) {
  const result = await runProcess(
    powershellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    { timeoutMs: 30_000, env: { ...process.env, ...env } },
  );
  return parseJsonProcessResult(result, "PowerShell");
}

async function shortcutInfo(shortcutPath) {
  if (!existsSync(shortcutPath)) return null;
  return runPowerShellJson(
    buildPowerShellScript([
      "$shortcutPath = $env:LVIS_SHORTCUT_PATH",
      "$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)",
      "$shell = New-Object -ComObject Shell.Application",
      "$folder = $shell.Namespace([System.IO.Path]::GetDirectoryName($shortcutPath))",
      "if ($null -eq $folder) { throw 'could not open shortcut parent folder' }",
      "$item = $folder.ParseName([System.IO.Path]::GetFileName($shortcutPath))",
      "if ($null -eq $item) { throw 'could not read shortcut property store' }",
      "[PSCustomObject]@{ target = $shortcut.TargetPath; workingDirectory = $shortcut.WorkingDirectory; arguments = $shortcut.Arguments; description = $shortcut.Description; appUserModelId = [string]$item.ExtendedProperty('System.AppUserModel.ID'); toastClsid = [string]$item.ExtendedProperty('System.AppUserModel.ToastActivatorCLSID') } | ConvertTo-Json -Compress",
    ]),
    { LVIS_SHORTCUT_PATH: shortcutPath },
  );
}

async function shortcutTarget(shortcutPath) {
  const result = await shortcutInfo(shortcutPath);
  return typeof result?.target === "string" ? result.target : null;
}

export function normalizeToastActivatorClsid(value) {
  if (typeof value !== "string") return null;
  const match =
    /^(?:\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))$/i.exec(
      value,
    );
  const normalized = match?.[1] ?? match?.[2];
  return normalized ? `{${normalized.toUpperCase()}}` : null;
}

export function isOwnedRuntimeShortcut(shortcut, expected) {
  if (!shortcut || !expected) return false;
  if (
    typeof shortcut.target !== "string" ||
    typeof shortcut.workingDirectory !== "string" ||
    typeof shortcut.arguments !== "string" ||
    typeof shortcut.description !== "string" ||
    typeof shortcut.appUserModelId !== "string" ||
    normalizeToastActivatorClsid(shortcut.toastClsid) === null ||
    typeof expected.installedExe !== "string" ||
    typeof expected.installDir !== "string" ||
    typeof expected.description !== "string" ||
    typeof expected.appUserModelId !== "string"
  ) {
    return false;
  }
  return (
    samePath(shortcut.target, expected.installedExe) &&
    samePath(shortcut.workingDirectory, expected.installDir) &&
    shortcut.arguments === "" &&
    shortcut.description === expected.description &&
    shortcut.appUserModelId === expected.appUserModelId
  );
}

async function waitForRuntimeShortcut(shortcutPath, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const shortcut = lstatSync(shortcutPath, { throwIfNoEntry: false });
    if (shortcut) return shortcut;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return null;
}

async function toastActivatorRegistrations(toastClsid) {
  const normalizedClsid = normalizeToastActivatorClsid(toastClsid);
  if (!normalizedClsid) throw new Error("invalid toast activator CLSID");
  const path = `${TOAST_CLSID_REGISTRY_ROOT}\\${normalizedClsid}`;
  const registrations = [];
  for (const view of REGISTRY_VIEWS) {
    const [rootDefault, customActivator, localServer] = await Promise.all([
      queryRegistryDefault("HKCU", path, view),
      queryRegistryValue("HKCU", path, view, "CustomActivator"),
      queryRegistryDefault("HKCU", `${path}\\LocalServer32`, view),
    ]);
    if (
      rootDefault.keyExists ||
      customActivator.keyExists ||
      localServer.keyExists
    ) {
      registrations.push({ view, rootDefault, customActivator, localServer });
    }
  }
  return registrations;
}

async function assertRuntimeNotificationArtifacts(machineInstall) {
  const provenance = machineInstall.runtimeShortcutProvenance;
  if (!provenance?.absentBeforeLaunch || !provenance.path) {
    throw new Error(
      "runtime notification artifact assertion requires pre-launch absence provenance",
    );
  }

  const shortcutStat = await waitForRuntimeShortcut(provenance.path);
  if (!shortcutStat?.isFile()) {
    throw new Error(
      `Electron runtime shortcut was not created as a regular file: ${provenance.path}`,
    );
  }
  const expected = {
    installedExe: machineInstall.installedExe,
    installDir: machineInstall.installDir,
    description: requiredPackageString(
      packageJson.build?.productName,
      "build.productName",
    ),
    appUserModelId: requiredPackageString(
      packageJson.build?.appId,
      "build.appId",
    ),
  };
  const shortcut = await shortcutInfo(provenance.path);
  if (!isOwnedRuntimeShortcut(shortcut, expected)) {
    throw new Error(
      `Electron runtime shortcut ownership fields do not match: ${provenance.path}`,
    );
  }
  const toastClsid = normalizeToastActivatorClsid(shortcut.toastClsid);
  if (toastClsid !== WINDOWS_TOAST_ACTIVATOR_CLSID) {
    throw new Error(
      `Electron runtime shortcut toast CLSID is not the product-owned fixed value: ${toastClsid}`,
    );
  }

  const registrations = await toastActivatorRegistrations(toastClsid);
  if (registrations.length === 0) {
    throw new Error("Electron runtime toast CLSID registration is missing");
  }
  for (const registration of registrations) {
    if (
      registration.rootDefault.value !== "Electron Notification Activator" ||
      registration.rootDefault.valueKind !== "String" ||
      registration.customActivator.value !== "1" ||
      registration.customActivator.valueKind !== "DWord" ||
      !registration.localServer.valueExists ||
      registration.localServer.valueKind !== "String" ||
      !samePath(registration.localServer.value, machineInstall.installedExe)
    ) {
      throw new Error(
        `Electron runtime toast registration is not exact in HKCU ${registration.view}-bit view`,
      );
    }
  }

  provenance.toastClsid = toastClsid;
  provenance.ownedBeforeUninstall = true;
  process.stdout.write(
    `[windows-installer-smoke] exact current-user notification shortcut and CLSID registration verified: ${toastClsid}\n`,
  );
}

async function cleanupOwnedRuntimeNotificationArtifacts(machineInstall) {
  const provenance = machineInstall.runtimeShortcutProvenance;
  if (!provenance?.absentBeforeLaunch || !provenance.path) {
    throw new Error(
      "refusing failure cleanup without pre-launch absence provenance",
    );
  }
  const cleanupScript = fileURLToPath(
    new URL(
      "../build/uninstall-windows-notification-artifacts.ps1",
      import.meta.url,
    ),
  );
  await runProcess(
    powershellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      cleanupScript,
      "-InstalledExecutable",
      machineInstall.installedExe,
      "-ShortcutName",
      requiredPackageString(packageJson.build?.productName, "build.productName"),
      "-AppUserModelId",
      requiredPackageString(packageJson.build?.appId, "build.appId"),
      "-InstallMarker",
      machineInstall.markerPath,
    ],
    { timeoutMs: 30_000 },
  );
}

export function isExactProtocolCommand(command, executable) {
  if (typeof command !== "string" || typeof executable !== "string") {
    return false;
  }
  const expected = '\"' + executable + '\" \"%1\"';
  return command.toLowerCase() === expected.toLowerCase();
}

export function isExactProtocolIcon(icon, executable) {
  if (typeof icon !== "string" || typeof executable !== "string") {
    return false;
  }
  const expected = '\"' + executable + '\",0';
  return icon.toLowerCase() === expected.toLowerCase();
}

async function protocolRegistrations(hive) {
  const registrations = [];
  for (const view of REGISTRY_VIEWS) {
    const [rootDefault, urlProtocol, command, defaultIcon] = await Promise.all([
      queryRegistryDefault(hive, PROTOCOL_REGISTRY_ROOT, view),
      queryRegistryValue(hive, PROTOCOL_REGISTRY_ROOT, view, "URL Protocol"),
      queryRegistryDefault(hive, PROTOCOL_REGISTRY_PATH, view),
      queryRegistryDefault(hive, PROTOCOL_ICON_REGISTRY_PATH, view),
    ]);
    if (rootDefault.keyExists || command.keyExists || defaultIcon.keyExists) {
      registrations.push({
        view,
        rootDefault: rootDefault.valueExists ? rootDefault.value : null,
        urlProtocol: urlProtocol.valueExists ? urlProtocol.value : null,
        urlProtocolKind: urlProtocol.valueKind,
        command: command.valueExists ? command.value : null,
        defaultIcon: defaultIcon.valueExists ? defaultIcon.value : null,
      });
    }
  }
  return registrations;
}

async function runForeignProtocolFixtureAction(action, fixture) {
  for (const view of REGISTRY_VIEWS) {
    const result = await runPowerShellJson(FOREIGN_PROTOCOL_FIXTURE_SCRIPT, {
      LVIS_FOREIGN_PROTOCOL_ACTION: action,
      LVIS_FOREIGN_PROTOCOL_TOKEN: fixture.token,
      LVIS_FOREIGN_PROTOCOL_KIND: fixture.kind,
      LVIS_FOREIGN_PROTOCOL_VALUE_NAME: FOREIGN_PROTOCOL_FIXTURE_VALUE_NAME,
      LVIS_FOREIGN_PROTOCOL_SUBKEY_NAME: FOREIGN_PROTOCOL_FIXTURE_SUBKEY_NAME,
      LVIS_REGISTRY_VIEW: view,
    });
    if (
      result?.ok !== true ||
      result.action !== action ||
      result.view !== view ||
      result.kind !== fixture.kind
    ) {
      throw new Error(
        `foreign protocol fixture ${action} returned an invalid ${view}-bit result`,
      );
    }
  }
}

function createForeignProtocolFixture(keepAppData) {
  return {
    token: `LVIS-NSIS-SMOKE-FOREIGN-${keepAppData ? "KEEP" : "DELETE"}`,
    kind: keepAppData ? "ExpandString" : "Binary",
  };
}

async function seedForeignProtocolFixture(fixture) {
  await runForeignProtocolFixtureAction("seed", fixture);
}

async function assertForeignProtocolFixturePreserved(fixture) {
  await runForeignProtocolFixtureAction("assert-preserved", fixture);
}

async function cleanupForeignProtocolFixture(fixture) {
  await runForeignProtocolFixtureAction("cleanup", fixture);
}

async function assertNoCurrentUserProtocolHandlers(context) {
  const registrations = await protocolRegistrations("HKCU");
  if (registrations.length !== 0) {
    throw new Error(
      `${context} wrote HKCU lvis protocol handlers: ${registrations
        .map(({ view }) => view)
        .join(", ")}`,
    );
  }
}

async function assertInstalledSurface(machineInstall) {
  const { installDir, installedExe, markerPath, uninstaller } = machineInstall;
  await waitForFile(installedExe, 30_000);
  await waitForFile(uninstaller, 30_000);
  await waitForFile(markerPath, 30_000);
  const marker = statSync(markerPath);
  if (!marker.isFile() || marker.size !== 0) {
    throw new Error(
      `NSIS per-machine marker must be a zero-byte regular file: ${markerPath}`,
    );
  }

  if (existsSync(localAppDataInstallDir())) {
    throw new Error(
      `per-user install residue exists: ${localAppDataInstallDir()}`,
    );
  }

  const hkcuUninstall = await productUninstallEntries("HKCU");
  if (hkcuUninstall.length !== 0) {
    throw new Error(
      `perMachine install wrote HKCU uninstall entries: ${hkcuUninstall.map((entry) => entry.key).join(", ")}`,
    );
  }

  const machineProtocol = await protocolRegistrations("HKLM");
  if (machineProtocol.length === 0) {
    throw new Error(
      "lvis protocol handler is missing from HKLM 32/64-bit registry views",
    );
  }
  for (const registration of machineProtocol) {
    if (registration.rootDefault !== "URL:lvis") {
      throw new Error(
        `HKLM ${registration.view}-bit lvis protocol root default is invalid`,
      );
    }
    if (
      registration.urlProtocol !== "" ||
      registration.urlProtocolKind !== "String"
    ) {
      throw new Error(
        `HKLM ${registration.view}-bit lvis URL Protocol must be an empty REG_SZ`,
      );
    }
    if (!isExactProtocolCommand(registration.command, installedExe)) {
      throw new Error(
        `HKLM ${registration.view}-bit lvis command must exactly equal the quoted installed executable plus \"%1\"`,
      );
    }
    if (!isExactProtocolIcon(registration.defaultIcon, installedExe)) {
      throw new Error(
        `HKLM ${registration.view}-bit lvis DefaultIcon must exactly equal the quoted installed executable plus ,0`,
      );
    }
  }
  await assertNoCurrentUserProtocolHandlers("perMachine install");

  const shortcutName = requiredPackageString(
    packageJson.build?.nsis?.shortcutName,
    "build.nsis.shortcutName",
  );
  const programData = process.env.ProgramData;
  const publicDir = process.env.PUBLIC;
  const appData = process.env.APPDATA;
  const userProfile = process.env.USERPROFILE;
  if (!programData || !publicDir || !appData || !userProfile) {
    throw new Error("ProgramData/PUBLIC/APPDATA/USERPROFILE must be set");
  }

  const machineShortcuts = [
    join(publicDir, "Desktop", `${shortcutName}.lnk`),
    join(
      programData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      `${shortcutName}.lnk`,
    ),
  ];
  for (const shortcut of machineShortcuts) {
    const target = await shortcutTarget(shortcut);
    if (!target || !samePath(target, installedExe)) {
      throw new Error(
        `machine shortcut does not target ${installedExe}: ${shortcut} -> ${target}`,
      );
    }
  }

  const userStartMenuShortcut = join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${shortcutName}.lnk`,
  );
  const userShortcuts = [
    join(userProfile, "Desktop", `${shortcutName}.lnk`),
    userStartMenuShortcut,
  ];
  const userResidue = userShortcuts.filter((shortcut) => existsSync(shortcut));
  if (userResidue.length > 0) {
    throw new Error(
      `perMachine install left per-user shortcuts: ${userResidue.join(", ")}`,
    );
  }

  process.stdout.write(
    `[windows-installer-smoke] perMachine install surface verified from HKLM ${machineInstall.entry.view}-bit view: ${installDir}\n`,
  );
  return {
    path: userStartMenuShortcut,
    absentBeforeLaunch: true,
  };
}

async function assertUninstalledSurface(machineInstall) {
  const { installDir, entry, markerPath, registryPath } = machineInstall;
  await waitForPathRemoved(installDir, 30_000);
  if (existsSync(markerPath)) {
    throw new Error(`uninstall left NSIS per-machine marker: ${markerPath}`);
  }
  for (const view of REGISTRY_VIEWS) {
    const exactEntry = await registryQuery(
      "HKLM",
      registryPath,
      view,
      "default",
    );
    if (exactEntry.keyExists) {
      throw new Error(
        `uninstall left exact HKLM ${view}-bit key (discovered in ${entry.view}-bit view): ${entry.key}`,
      );
    }
  }
  const machineEntries = await productUninstallEntries("HKLM");
  const userEntries = await productUninstallEntries("HKCU");
  if (machineEntries.length !== 0 || userEntries.length !== 0) {
    throw new Error(
      `uninstall registration residue: HKLM=${machineEntries.length} HKCU=${userEntries.length}`,
    );
  }
  if (existsSync(localAppDataInstallDir())) {
    throw new Error(
      `uninstall left per-user install residue: ${localAppDataInstallDir()}`,
    );
  }
  if (
    (await protocolRegistrations("HKLM")).length !== 0 ||
    (await protocolRegistrations("HKCU")).length !== 0
  ) {
    throw new Error("uninstall left lvis protocol handler registry residue");
  }
  const shortcutName = requiredPackageString(
    packageJson.build?.nsis?.shortcutName,
    "build.nsis.shortcutName",
  );
  const {
    ProgramData: programData,
    PUBLIC: publicDir,
    APPDATA: appData,
    USERPROFILE: userProfile,
  } = process.env;
  if (!programData || !publicDir || !appData || !userProfile) {
    throw new Error("ProgramData/PUBLIC/APPDATA/USERPROFILE must be set");
  }
  const shortcutResidue = [
    join(publicDir, "Desktop", `${shortcutName}.lnk`),
    join(
      programData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      `${shortcutName}.lnk`,
    ),
    join(userProfile, "Desktop", `${shortcutName}.lnk`),
    join(
      appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      `${shortcutName}.lnk`,
    ),
  ].filter((shortcut) => existsSync(shortcut));
  if (shortcutResidue.length > 0) {
    throw new Error(
      `uninstall left shortcut residue: ${shortcutResidue.join(", ")}`,
    );
  }

  const toastClsid =
    machineInstall.runtimeShortcutProvenance?.toastClsid ?? null;
  if (toastClsid) {
    const toastResidue = await toastActivatorRegistrations(toastClsid);
    if (toastResidue.length > 0) {
      throw new Error(
        `uninstall left current-user toast CLSID residue: ${toastClsid}`,
      );
    }
  }
}

export function captureOutputChunk(current, chunk) {
  const next = current + chunk.toString("utf8");
  const truncated = next.length > MAX_OUTPUT_CHARS;
  return {
    output: truncated ? next.slice(next.length - MAX_OUTPUT_CHARS) : next,
    truncated,
  };
}

function removeTempDirBestEffort(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `[windows-installer-smoke] warning: could not remove temp dir ${dir}: ${err.message}\n`,
    );
  }
}

function terminateProcessTree(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return "already exited";
  }
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error(`cannot terminate ${label}: child PID is invalid`);
  }

  const reports = [];
  let taskkillRequested = false;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error("SystemRoot/WINDIR is not set");
    try {
      const killer = spawn(
        join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.on("error", (error) => {
        process.stderr.write(
          `[windows-installer-smoke] warning: taskkill failed for ${label} pid ${child.pid}: ${error.message}\n`,
        );
      });
      killer.unref?.();
      reports.push("taskkill /T /F requested");
      taskkillRequested = true;
    } catch (error) {
      reports.push(`taskkill spawn failed: ${error.message}`);
    }
  }
  if (!taskkillRequested && child.kill("SIGKILL")) {
    reports.push("direct SIGKILL requested");
  }
  return reports.join("; ") || "termination request was rejected";
}

async function runProcess(
  command,
  args,
  { timeoutMs, env = process.env, input, allowNonZero = false } = {},
) {
  process.stdout.write(
    `[windows-installer-smoke] $ ${command} ${args.join(" ")}\n`,
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid process timeout for ${command}: ${timeoutMs}`);
  }

  return await new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let terminationReport = "not requested";
    let graceTimer = null;
    const child = spawn(command, args, {
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        terminationReport = terminateProcessTree(
          child,
          `${command} ${args.join(" ")}`,
        );
      } catch (error) {
        terminationReport = `termination failed: ${error.message}`;
      }
      graceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `process timed out after ${timeoutMs}ms and did not exit within the 5s termination grace (pid=${child.pid}; ${terminationReport})\n${stdout + stderr}`,
          ),
        );
      }, 5_000);
    }, timeoutMs);

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      callback(value);
    };

    child.stdout?.on("data", (chunk) => {
      const captured = captureOutputChunk(stdout, chunk);
      stdout = captured.output;
      stdoutTruncated ||= captured.truncated;
    });
    child.stderr?.on("data", (chunk) => {
      const captured = captureOutputChunk(stderr, chunk);
      stderr = captured.output;
      stderrTruncated ||= captured.truncated;
    });
    child.on("error", (error) => {
      if (timedOut) {
        settle(
          reject,
          new Error(
            `process timed out after ${timeoutMs}ms (pid=${child.pid}; ${terminationReport}): ${error.message}\n${stdout + stderr}`,
          ),
        );
      } else {
        settle(reject, error);
      }
    });
    child.on("exit", (code, signal) => {
      const output = stdout + stderr;
      if (timedOut) {
        settle(
          reject,
          new Error(
            `process timed out after ${timeoutMs}ms (pid=${child.pid}; ${terminationReport})\n${output}`,
          ),
        );
        return;
      }
      const result = {
        code,
        signal,
        stdout,
        stderr,
        output,
        stdoutTruncated,
        stderrTruncated,
      };
      if (code === 0 || allowNonZero) {
        settle(resolvePromise, result);
        return;
      }
      settle(
        reject,
        new Error(
          `process exited with code=${code} signal=${signal ?? "none"}\n${output}`,
        ),
      );
    });

    if (input !== undefined) child.stdin?.end(input);
  });
}

async function waitForFile(file, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(file) && statSync(file).isFile()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`timed out waiting for file: ${file}`);
}

async function waitForFileRemoved(file, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!existsSync(file)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`timed out waiting for file removal: ${file}`);
}

async function waitForPathRemoved(file, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!existsSync(file)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`timed out waiting for path removal: ${file}`);
}

function userDataTargets() {
  const { USERPROFILE, APPDATA, LOCALAPPDATA } = process.env;
  if (!USERPROFILE) throw new Error("USERPROFILE is not set");
  if (!APPDATA) throw new Error("APPDATA is not set");
  if (!LOCALAPPDATA) throw new Error("LOCALAPPDATA is not set");
  const appNames = [
    requiredPackageString(packageJson.build?.productName, "build.productName"),
    requiredPackageString(packageJson.name, "name"),
  ];
  const candidates = [
    join(USERPROFILE, ".lvis"),
    ...appNames.flatMap((name) => [
      join(APPDATA, name),
      join(LOCALAPPDATA, name),
    ]),
  ];
  const unique = new Map();
  for (const target of candidates) {
    unique.set(normalizeComparablePath(target), target);
  }
  return [...unique.values()];
}

function userDataSentinel(target) {
  return join(target, USER_DATA_SENTINEL_NAME);
}

function hasExpectedUserDataSentinel(target) {
  const sentinel = userDataSentinel(target);
  return (
    existsSync(sentinel) &&
    readFileSync(sentinel, "utf8") === USER_DATA_SENTINEL_CONTENT
  );
}

function assertNoExistingUserDataTargets() {
  const existing = userDataTargets().filter((target) => existsSync(target));
  if (existing.length > 0) {
    throw new Error(
      [
        "installer smoke requires clean LVIS user-data paths:",
        ...existing.map((target) => `- ${target}`),
        "Run this smoke only in a disposable Windows runner or VM.",
      ].join("\n"),
    );
  }
}

function cleanupSmokeUserDataBestEffort() {
  for (const target of userDataTargets()) {
    if (hasExpectedUserDataSentinel(target)) removeTempDirBestEffort(target);
  }
}

function createUserDataSentinels() {
  for (const target of userDataTargets()) {
    mkdirSync(target, { recursive: true });
    writeFileSync(userDataSentinel(target), USER_DATA_SENTINEL_CONTENT, "utf8");
  }
}

function assertUserDataTargetsExist() {
  const changed = userDataTargets().filter(
    (target) => !hasExpectedUserDataSentinel(target),
  );
  if (changed.length > 0) {
    throw new Error(
      `KEEP_APP_DATA uninstall removed or modified sentinel data: ${changed.join(", ")}`,
    );
  }
}

function assertUserDataTargetsRemoved() {
  const remaining = userDataTargets().filter((target) => existsSync(target));
  if (remaining.length > 0) {
    throw new Error(
      `full uninstall left user data behind: ${remaining.join(", ")}`,
    );
  }
}
export const ACL_QUERY_SCRIPT = buildPowerShellScript([
  "$ErrorActionPreference = 'Stop'",
  "$entries = @((Get-Acl -LiteralPath $env:LVIS_ACL_TARGET).Access | ForEach-Object {",
  "  $rule = $_",
  "  try { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }",
  "  catch { $sid = $rule.IdentityReference.Value }",
  "  [PSCustomObject]@{ sid = $sid; rights = [int64]$rule.FileSystemRights; type = $rule.AccessControlType.ToString(); inheritance = $rule.InheritanceFlags.ToString(); propagation = $rule.PropagationFlags.ToString(); inherited = $rule.IsInherited }",
  "})",
  "ConvertTo-Json -InputObject $entries -Compress",
]);

function resolveSrtWinFromVendor(vendorRoot, label) {
  const candidates = [
    join(vendorRoot, process.arch, "srt-win.exe"),
    join(vendorRoot, "x64", "srt-win.exe"),
    join(vendorRoot, "arm64", "srt-win.exe"),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match)
    throw new Error(`${label} srt-win.exe is missing under ${vendorRoot}`);
  return match;
}

function resolvePackagedSrtWin(installDir) {
  return resolveSrtWinFromVendor(
    join(
      installDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "@anthropic-ai",
      "sandbox-runtime",
      "vendor",
      "srt-win",
    ),
    "packaged",
  );
}

function resolveRepositorySrtWin() {
  return resolveSrtWinFromVendor(
    fileURLToPath(
      new URL(
        "../node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/",
        import.meta.url,
      ),
    ),
    "repository",
  );
}

async function runAsrtJson(srtWin, args) {
  const result = await runProcess(srtWin, args, { timeoutMs: 60_000 });
  return parseJsonProcessResult(result, `srt-win ${args.join(" ")}`);
}

async function readAsrtSystemState(srtWin) {
  return {
    user: await runAsrtJson(srtWin, ["user", "status"]),
    wfp: await runAsrtJson(srtWin, ["wfp", "status"]),
  };
}

async function queryAclEntries(target) {
  const entries = await runPowerShellJson(ACL_QUERY_SCRIPT, {
    LVIS_ACL_TARGET: target,
  });
  if (!Array.isArray(entries)) {
    throw new Error(
      `ACL query returned a non-array contract for ${target}: ${JSON.stringify(entries)}`,
    );
  }
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.sid !== "string" ||
      !Number.isFinite(Number(entry.rights)) ||
      typeof entry.type !== "string" ||
      typeof entry.inheritance !== "string" ||
      typeof entry.propagation !== "string" ||
      typeof entry.inherited !== "boolean"
    ) {
      throw new Error(
        `ACL query returned an invalid entry for ${target}: ${JSON.stringify(entry)}`,
      );
    }
  }
  return entries;
}

function hasReadExecute(entry) {
  const readAndExecute = 131_241;
  return (
    entry.type === "Allow" &&
    Number.isFinite(Number(entry.rights)) &&
    (Number(entry.rights) & readAndExecute) === readAndExecute
  );
}

function hasObjectAndContainerInheritance(entry) {
  const inheritance = new Set(
    String(entry.inheritance)
      .split(",")
      .map((value) => value.trim()),
  );
  return (
    inheritance.has("ObjectInherit") && inheritance.has("ContainerInherit")
  );
}

async function assertAclAllowsReadExecute(
  target,
  sid,
  label,
  { requireInheritance = false } = {},
) {
  const entries = await queryAclEntries(target);
  if (
    !entries.some(
      (entry) =>
        entry.sid === sid &&
        hasReadExecute(entry) &&
        (!requireInheritance || hasObjectAndContainerInheritance(entry)),
    )
  ) {
    throw new Error(`${label} is missing an RX ACL for ${sid}: ${target}`);
  }
}

async function assertAclSidAbsent(target, sid, label) {
  const entries = await queryAclEntries(target);
  if (entries.some((entry) => entry.sid === sid)) {
    throw new Error(
      `${label} left a sandbox-user holder ACL for ${sid}: ${target}`,
    );
  }
}

function assertAsrtUserReady(raw) {
  const user = raw.user ?? {};
  const missing = [
    ["user.exists", user.exists],
    ["user.group_exists", user.group_exists],
    ["user.in_builtin_users", user.in_builtin_users],
    ["user.in_sandbox_group", user.in_sandbox_group],
    ["user.hidden_from_logon", user.hidden_from_logon],
    ["cred_present", raw.cred_present],
    ["marker_version", raw.marker_version === 1],
    [
      "marker_user_sid",
      typeof user.sid === "string" && raw.marker_user_sid === user.sid,
    ],
  ]
    .filter(([, value]) => value !== true)
    .map(([field]) => field);
  if (typeof user.sid !== "string" || user.sid.length === 0)
    missing.push("user.sid");
  if (typeof user.group_sid !== "string" || user.group_sid.length === 0) {
    missing.push("user.group_sid");
  }
  if (missing.length > 0) {
    throw new Error(
      `ASRT provisioning precondition failed: ${missing.join(", ")}`,
    );
  }
}

function assertWfpInstalled(raw, sandboxSid) {
  if (
    raw.state !== "installed" ||
    !Number.isInteger(raw.filters) ||
    raw.filters < 4 ||
    raw.user_sid !== sandboxSid ||
    JSON.stringify(raw.port_range) !== JSON.stringify([60080, 60089])
  ) {
    throw new Error(
      `ASRT WFP precondition failed (run elevated or move this to the manual release gate): ${JSON.stringify(raw)}`,
    );
  }
}

function assertAsrtUserRemoved(raw) {
  const user = raw?.user;
  const violations = [];
  if (!user || typeof user !== "object") {
    violations.push("user object missing");
  } else {
    for (const field of [
      "exists",
      "group_exists",
      "in_builtin_users",
      "in_sandbox_group",
      "hidden_from_logon",
    ]) {
      if (user[field] !== false) violations.push(`user.${field} must be false`);
    }
    if (Object.prototype.hasOwnProperty.call(user, "sid")) {
      violations.push("user.sid must be absent");
    }
    if (Object.prototype.hasOwnProperty.call(user, "group_sid")) {
      violations.push("user.group_sid must be absent");
    }
    if (typeof user.name !== "string" || user.name.length === 0) {
      violations.push("user.name must be nonempty");
    }
  }
  if (raw?.cred_present !== false)
    violations.push("cred_present must be false");
  for (const field of [
    "marker_version",
    "marker_user_sid",
    "ca_cert_thumb",
    "ca_cert_pem",
  ]) {
    if (raw?.[field] !== null) violations.push(`${field} must be null`);
  }
  if (
    typeof raw?.real_user_sid !== "string" ||
    raw.real_user_sid.length === 0
  ) {
    violations.push("real_user_sid must be nonempty");
  }
  if (violations.length > 0) {
    throw new Error(
      `ASRT absent-state contract failed (${violations.join(", ")}): ${JSON.stringify(raw)}`,
    );
  }
}

function assertWfpRemoved(raw) {
  if (raw.state !== "absent" || raw.filters !== 0) {
    throw new Error(
      `genuine uninstall left ASRT WFP state (elevated enumeration required): ${JSON.stringify(raw)}`,
    );
  }
}

function assertDisposableSmokeGate() {
  if (process.env[DISPOSABLE_SMOKE_ENV] !== "1") {
    throw new Error(
      `${DISPOSABLE_SMOKE_ENV}=1 is required because this smoke installs machine-wide state and genuinely uninstalls ASRT; use only a disposable Windows runner or VM`,
    );
  }
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_OS !== "Windows"
  ) {
    throw new Error(
      "GitHub Actions disposable installer smoke requires RUNNER_OS=Windows",
    );
  }
}

async function assertNoPreexistingAsrtState() {
  const state = await readAsrtSystemState(resolveRepositorySrtWin());
  assertAsrtUserRemoved(state.user);
  assertWfpRemoved(state.wfp);
  process.stdout.write(
    "[windows-installer-smoke] clean global ASRT precondition verified\n",
  );
}

async function stopChildProcess(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise, reject) => {
    let settled = false;
    let terminationReport;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      settle(
        reject,
        new Error(
          `timed out stopping ${label} pid ${child.pid} (${terminationReport})`,
        ),
      );
    }, 10_000);
    child.once("error", (error) => {
      settle(reject, error);
    });
    child.once("exit", () => {
      settle(resolvePromise);
    });
    terminationReport = terminateProcessTree(child, label);
  });
}

async function prepareAsrtUninstallProbe(installDir) {
  const srtWin = resolvePackagedSrtWin(installDir);
  const backendRoot = join(
    installDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "@anthropic-ai",
    "sandbox-runtime",
  );
  const state = await readAsrtSystemState(srtWin);
  assertAsrtUserReady(state.user);
  const sandboxSid = state.user.user.sid;
  const groupSid = state.user.user.group_sid;
  assertWfpInstalled(state.wfp, sandboxSid);
  await assertAclAllowsReadExecute(
    backendRoot,
    groupSid,
    "packaged ASRT backend",
    {
      requireInheritance: true,
    },
  );
  await assertAclAllowsReadExecute(
    srtWin,
    groupSid,
    "packaged srt-win executable",
  );

  const probeRoot = mkdtempSync(join(tmpdir(), "lvis-nsis-asrt-teardown-"));
  const holderTarget = join(probeRoot, "holder-acl-target");
  const copiedSrtWin = join(probeRoot, "srt-win.exe");
  mkdirSync(holderTarget, { recursive: true });
  copyFileSync(srtWin, copiedSrtWin);

  const holder = spawn(
    powershellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Sleep -Seconds 300",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  if (holder.pid === undefined) {
    removeTempDirBestEffort(probeRoot);
    throw new Error("failed to start ASRT holder-ACL precondition process");
  }

  try {
    await runProcess(
      srtWin,
      [
        "acl",
        "grant",
        "--holder-pid",
        String(holder.pid),
        "--sandbox-user-sid",
        sandboxSid,
      ],
      {
        timeoutMs: 60_000,
        input: JSON.stringify({ read: [holderTarget], write: [] }),
      },
    );
    await assertAclAllowsReadExecute(
      holderTarget,
      sandboxSid,
      "holder precondition",
    );
  } catch (error) {
    await stopChildProcess(holder, "ACL holder").catch(() => {});
    removeTempDirBestEffort(probeRoot);
    throw error;
  }

  await stopChildProcess(holder, "ACL holder");
  process.stdout.write(
    `[windows-installer-smoke] ASRT positive preconditions verified; dead holder ${holder.pid} must be recovered during uninstall\n`,
  );
  return { copiedSrtWin, holderTarget, probeRoot, sandboxSid };
}

async function assertAsrtTeardown(probe) {
  try {
    const state = await readAsrtSystemState(probe.copiedSrtWin);
    assertAsrtUserRemoved(state.user);
    assertWfpRemoved(state.wfp);
    await assertAclSidAbsent(
      probe.holderTarget,
      probe.sandboxSid,
      "genuine uninstall",
    );
    process.stdout.write(
      "[windows-installer-smoke] genuine uninstall removed ASRT user/group/credential, WFP, and holder ACL state\n",
    );
  } finally {
    removeTempDirBestEffort(probe.probeRoot);
  }
}

async function startInstalledApp(executable, timeoutMs) {
  const userDataDir = mkdtempSync(join(tmpdir(), "lvis-nsis-smoke-user-data-"));
  const env = prepareElectronLaunchEnv({
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    LVIS_DEV_CONSOLE: "0",
    LVIS_USER_DATA_DIR: userDataDir,
  });

  const args = prepareElectronLaunchArgs([], env, {
    profileName: "LVIS",
    platform: "win32",
  });

  try {
    return await new Promise((resolvePromise, reject) => {
      let output = "";
      const child = spawn(executable, [...new Set(args)], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        cleanupListeners();
        process.stdout.write(
          `[windows-installer-smoke] app stayed up for ${timeoutMs}ms; launch smoke passed\n`,
        );
        resolvePromise({
          child,
          async stop() {
            try {
              await stopChildProcess(child, "installed app");
            } finally {
              removeTempDirBestEffort(userDataDir);
            }
          },
        });
      }, timeoutMs);

      const cleanupListeners = () => {
        clearTimeout(timer);
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        child.removeAllListeners("error");
        child.removeAllListeners("exit");
      };

      child.stdout?.on("data", (chunk) => {
        output = captureOutputChunk(output, chunk).output;
      });
      child.stderr?.on("data", (chunk) => {
        output = captureOutputChunk(output, chunk).output;
      });
      child.on("error", (error) => {
        cleanupListeners();
        removeTempDirBestEffort(userDataDir);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        cleanupListeners();
        removeTempDirBestEffort(userDataDir);
        reject(
          new Error(
            `installed app exited early with code=${code} signal=${signal ?? "none"}\n${output}`,
          ),
        );
      });
    });
  } catch (err) {
    removeTempDirBestEffort(userDataDir);
    throw err;
  }
}

async function assertCleanInstallSurface() {
  const machineEntries = await productUninstallEntries("HKLM");
  const userEntries = await productUninstallEntries("HKCU");
  const machineProtocol = await protocolRegistrations("HKLM");
  const userProtocol = await protocolRegistrations("HKCU");
  const programFilesResidue = programFilesInstallCandidates().filter((target) =>
    existsSync(target),
  );
  if (
    machineEntries.length !== 0 ||
    userEntries.length !== 0 ||
    machineProtocol.length !== 0 ||
    userProtocol.length !== 0 ||
    existsSync(localAppDataInstallDir()) ||
    programFilesResidue.length !== 0
  ) {
    throw new Error(
      `installer smoke requires a clean install surface: HKLM=${machineEntries.length} HKCU=${userEntries.length} protocol(HKLM/HKCU)=${machineProtocol.length}/${userProtocol.length} LocalAppData=${existsSync(localAppDataInstallDir())} ProgramFiles=${programFilesResidue.join(", ") || "absent"}`,
    );
  }
}

async function waitForMachineInstall(timeoutMs) {
  const startedAt = Date.now();
  let lastCount = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const entries = await productUninstallEntries("HKLM");
    lastCount = entries.length;
    if (entries.length === 1) return resolveMachineInstall(entries);
    if (entries.length > 1) return resolveMachineInstall(entries);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `timed out waiting for the HKLM uninstall entry in 32/64-bit views (last count ${lastCount})`,
  );
}

async function installAndDiscover(installer, timeoutMs) {
  await runProcess(installer, ["/S", "/allusers"], { timeoutMs });
  const machineInstall = await waitForMachineInstall(30_000);
  machineInstall.runtimeShortcutProvenance =
    await assertInstalledSurface(machineInstall);
  return machineInstall;
}

async function uninstallAndVerify(
  machineInstall,
  keepAppData,
  timeoutMs,
  probe,
  foreignProtocolFixture,
) {
  const args = ["/S", "/allusers", ...(keepAppData ? ["/KEEP_APP_DATA"] : [])];
  await runProcess(machineInstall.uninstaller, args, { timeoutMs });
  await waitForFileRemoved(machineInstall.installedExe, 30_000);
  await assertForeignProtocolFixturePreserved(foreignProtocolFixture);
  await cleanupForeignProtocolFixture(foreignProtocolFixture);
  await assertUninstalledSurface(machineInstall);
  await assertAsrtTeardown(probe);
  process.stdout.write(
    `[windows-installer-smoke] ${keepAppData ? "KEEP_APP_DATA" : "DELETE"} genuine uninstall pass completed\n`,
  );
}

async function cleanupFailedInstallerPass(state, timeoutMs) {
  const notes = [];
  const failures = [];
  const step = async (label, action) => {
    try {
      await action();
      notes.push(`${label}: ok`);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  };

  if (state.runningApp) {
    await step("stop installed app process tree", async () => {
      await state.runningApp.stop();
      state.runningApp = null;
    });
  }

  if (!state.machineInstall) {
    await step("discover partial machine install", async () => {
      const entries = await productUninstallEntries("HKLM");
      if (entries.length > 0) {
        state.machineInstall = resolveMachineInstall(entries);
        notes.push(`discovered ${state.machineInstall.installDir} for cleanup`);
      }
    });
  }

  if (state.machineInstall?.runtimeShortcutProvenance?.absentBeforeLaunch) {
    await step("exact-owner notification artifact failure cleanup", async () => {
      await cleanupOwnedRuntimeNotificationArtifacts(state.machineInstall);
    });
  }

  if (state.machineInstall && existsSync(state.machineInstall.uninstaller)) {
    await step(
      `genuine ${state.keepAppData ? "KEEP" : "DELETE"} uninstaller process exit`,
      async () => {
        const args = [
          "/S",
          "/allusers",
          ...(state.keepAppData ? ["/KEEP_APP_DATA"] : []),
        ];
        await runProcess(state.machineInstall.uninstaller, args, { timeoutMs });
      },
    );
  } else {
    notes.push(
      "genuine uninstaller process exit: skipped (no runnable uninstaller discovered)",
    );
  }

  if (state.foreignProtocolFixture) {
    await step("foreign protocol fixture cleanup", async () => {
      await cleanupForeignProtocolFixture(state.foreignProtocolFixture);
      state.foreignProtocolFixture = null;
    });
  }

  await step("machine install surface absent", async () => {
    if (state.machineInstall) {
      await assertUninstalledSurface(state.machineInstall);
    } else {
      await assertCleanInstallSurface();
    }
  });

  await step("global ASRT state absent", async () => {
    const asrtState = await readAsrtSystemState(resolveRepositorySrtWin());
    assertAsrtUserRemoved(asrtState.user);
    assertWfpRemoved(asrtState.wfp);
  });

  if (state.probe) {
    await step("holder ACL residue absent", async () => {
      if (existsSync(state.probe.holderTarget)) {
        await assertAclSidAbsent(
          state.probe.holderTarget,
          state.probe.sandboxSid,
          "failed-pass cleanup",
        );
      }
    });
    removeTempDirBestEffort(state.probe.probeRoot);
    state.probe = null;
  }

  if (state.keepAppData) {
    await step("KEEP sentinel content preserved", async () => {
      assertUserDataTargetsExist();
    });
  } else {
    const remaining = userDataTargets().filter((target) => existsSync(target));
    if (remaining.length > 0) {
      cleanupSmokeUserDataBestEffort();
      notes.push(
        `DELETE sentinel fallback cleanup removed: ${remaining.join(", ")}`,
      );
    }
    await step("DELETE userData absent", async () => {
      assertUserDataTargetsRemoved();
    });
  }

  return [
    ...notes.map((note) => `- ${note}`),
    ...failures.map((failure) => `- RESIDUE: ${failure}`),
  ].join("\n");
}

async function runInstallerPass(
  installer,
  options,
  { keepAppData, launchInstalledApp },
) {
  const state = {
    keepAppData,
    machineInstall: null,
    probe: null,
    runningApp: null,
    foreignProtocolFixture: null,
  };
  try {
    state.machineInstall = await installAndDiscover(
      installer,
      options.installTimeoutMs,
    );

    let launchError = null;
    if (launchInstalledApp) {
      try {
        state.runningApp = await startInstalledApp(
          state.machineInstall.installedExe,
          options.launchTimeoutMs,
        );
      } catch (error) {
        launchError = error;
      }
      if (state.runningApp) {
        await state.runningApp.stop();
        state.runningApp = null;
        await assertNoCurrentUserProtocolHandlers("installed app launch");
        await assertRuntimeNotificationArtifacts(state.machineInstall);
      }
    }

    state.foreignProtocolFixture = createForeignProtocolFixture(keepAppData);
    await seedForeignProtocolFixture(state.foreignProtocolFixture);
    state.probe = await prepareAsrtUninstallProbe(
      state.machineInstall.installDir,
    );
    await uninstallAndVerify(
      state.machineInstall,
      keepAppData,
      options.uninstallTimeoutMs,
      state.probe,
      state.foreignProtocolFixture,
    );
    state.foreignProtocolFixture = null;
    state.machineInstall = null;
    state.probe = null;
    if (keepAppData) assertUserDataTargetsExist();
    else assertUserDataTargetsRemoved();
    if (launchError) throw launchError;
  } catch (error) {
    const report = await cleanupFailedInstallerPass(
      state,
      options.uninstallTimeoutMs,
    );
    if (error instanceof Error) {
      error.message = `${error.message}\n[windows-installer-smoke] cleanup report\n${report}`;
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (process.platform !== "win32") {
    throw new Error(
      "Windows NSIS installer smoke requires process.platform === win32",
    );
  }

  assertDisposableSmokeGate();
  const installer = findInstaller(options);
  await assertCleanInstallSurface();
  await assertNoPreexistingAsrtState();
  assertNoExistingUserDataTargets();
  createUserDataSentinels();

  await runInstallerPass(installer, options, {
    keepAppData: true,
    launchInstalledApp: true,
  });

  if (!options.destructiveUserDataSmoke) {
    cleanupSmokeUserDataBestEffort();
    process.stdout.write(
      `[windows-installer-smoke] DELETE pass skipped; set ${DESTRUCTIVE_SMOKE_ENV}=1 only on a disposable runner\n`,
    );
    return;
  }

  await runInstallerPass(installer, options, {
    keepAppData: false,
    launchInstalledApp: false,
  });
  process.stdout.write(
    "[windows-installer-smoke] full uninstall removed LVIS user data paths\n",
  );
}

function failSmoke(error) {
  process.stderr.write(`[windows-installer-smoke] FAILED: ${error.message}\n`);
  process.exit(1);
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) main().catch(failSmoke);
