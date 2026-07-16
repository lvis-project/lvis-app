[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$InstalledExecutable,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ShortcutName,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$AppUserModelId,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$InstallMarker
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

function Get-NormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Value)

  $full = [System.IO.Path]::GetFullPath($Value)
  while (
    $full.Length -gt 3 -and
    ($full.EndsWith("\", [System.StringComparison]::Ordinal) -or
      $full.EndsWith("/", [System.StringComparison]::Ordinal))
  ) {
    $full = $full.Substring(0, $full.Length - 1)
  }
  return $full
}

function Test-SamePath {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )

  try {
    return [string]::Equals(
      (Get-NormalizedPath $Left),
      (Get-NormalizedPath $Right),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  }
  catch {
    return $false
  }
}

function Write-CleanupEvent {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("removed", "foreign-preserved", "verified-absent", "contract-failed")]
    [string]$Status,
    [Parameter(Mandatory = $true)][string]$Artifact,
    [Parameter(Mandatory = $true)][string]$Detail
  )

  [PSCustomObject]@{
    component = "lvis-notification-cleanup"
    status = $Status
    artifact = $Artifact
    detail = $Detail
  } | ConvertTo-Json -Compress
}

function Release-ComObject {
  param($Value)

  if (
    $null -ne $Value -and
    [System.Runtime.InteropServices.Marshal]::IsComObject($Value)
  ) {
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value)
  }
}

function Get-ShortcutRecord {
  param([Parameter(Mandatory = $true)][string]$Path)

  $wscript = $null
  $shortcut = $null
  $shell = $null
  $folder = $null
  $item = $null
  try {
    $wscript = New-Object -ComObject WScript.Shell
    $shortcut = $wscript.CreateShortcut($Path)
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.Namespace([System.IO.Path]::GetDirectoryName($Path))
    if ($null -eq $folder) {
      throw "could not open the shortcut parent folder"
    }
    $item = $folder.ParseName([System.IO.Path]::GetFileName($Path))
    if ($null -eq $item) {
      throw "could not read the shortcut property store"
    }

    return [PSCustomObject]@{
      Target = [string]$shortcut.TargetPath
      WorkingDirectory = [string]$shortcut.WorkingDirectory
      Arguments = [string]$shortcut.Arguments
      Description = [string]$shortcut.Description
      AppUserModelId = [string]$item.ExtendedProperty("System.AppUserModel.ID")
      ToastClsid = [string]$item.ExtendedProperty(
        "System.AppUserModel.ToastActivatorCLSID"
      )
    }
  }
  finally {
    Release-ComObject $item
    Release-ComObject $folder
    Release-ComObject $shell
    Release-ComObject $shortcut
    Release-ComObject $wscript
  }
}

function Get-ShortcutOwnershipMismatches {
  param(
    [Parameter(Mandatory = $true)]$Record,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
    [Parameter(Mandatory = $true)][string]$ExpectedWorkingDirectory,
    [Parameter(Mandatory = $true)][string]$ExpectedDescription,
    [Parameter(Mandatory = $true)][string]$ExpectedAppUserModelId
  )

  $mismatches = @()
  if (-not (Test-SamePath $Record.Target $ExpectedExecutable)) {
    $mismatches += "target"
  }
  if (-not (Test-SamePath $Record.WorkingDirectory $ExpectedWorkingDirectory)) {
    $mismatches += "workingDirectory"
  }
  if (-not [string]::Equals(
      $Record.Arguments,
      "",
      [System.StringComparison]::Ordinal
    )) {
    $mismatches += "arguments"
  }
  if (-not [string]::Equals(
      $Record.Description,
      $ExpectedDescription,
      [System.StringComparison]::Ordinal
    )) {
    $mismatches += "description"
  }
  if (-not [string]::Equals(
      $Record.AppUserModelId,
      $ExpectedAppUserModelId,
      [System.StringComparison]::Ordinal
    )) {
    $mismatches += "appUserModelId"
  }
  $parsedClsid = [System.Guid]::Empty
  if (-not [System.Guid]::TryParse($Record.ToastClsid, [ref]$parsedClsid)) {
    $mismatches += "toastClsid"
  }
  return @($mismatches)
}

function Get-RegistryViews {
  if ([Environment]::Is64BitOperatingSystem) {
    return @(
      [Microsoft.Win32.RegistryView]::Registry64,
      [Microsoft.Win32.RegistryView]::Registry32
    )
  }
  return @([Microsoft.Win32.RegistryView]::Registry32)
}

function Test-ExactToastRegistrationHandles {
  param(
    [Parameter(Mandatory = $true)]$RootKey,
    [Parameter(Mandatory = $true)]$ServerKey,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
  )

  try {
    if ($RootKey.GetValueKind("") -ne [Microsoft.Win32.RegistryValueKind]::String) {
      return $false
    }
    $rootDefault = $RootKey.GetValue(
      "",
      $null,
      [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
    if (
      -not [string]::Equals(
        [string]$rootDefault,
        "Electron Notification Activator",
        [System.StringComparison]::Ordinal
      )
    ) {
      return $false
    }
    if (
      $RootKey.GetValueKind("CustomActivator") -ne
      [Microsoft.Win32.RegistryValueKind]::DWord
    ) {
      return $false
    }
    if ([int64]$RootKey.GetValue("CustomActivator", 0) -ne 1) {
      return $false
    }
    if ($ServerKey.GetValueKind("") -ne [Microsoft.Win32.RegistryValueKind]::String) {
      return $false
    }
    $serverDefault = $ServerKey.GetValue(
      "",
      $null,
      [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
    return (
      $null -ne $serverDefault -and
      (Test-SamePath ([string]$serverDefault) $ExpectedExecutable)
    )
  }
  catch {
    return $false
  }
}

function Test-ExactToastRegistration {
  param(
    [Parameter(Mandatory = $true)]$View,
    [Parameter(Mandatory = $true)][string]$Clsid,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
  )

  $base = $null
  $root = $null
  $server = $null
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Microsoft.Win32.RegistryHive]::CurrentUser,
      $View
    )
    $root = $base.OpenSubKey("Software\Classes\CLSID\$Clsid", $false)
    if ($null -eq $root) { return $false }
    $server = $root.OpenSubKey("LocalServer32", $false)
    if ($null -eq $server) { return $false }
    return Test-ExactToastRegistrationHandles $root $server $ExpectedExecutable
  }
  finally {
    if ($null -ne $server) { $server.Dispose() }
    if ($null -ne $root) { $root.Dispose() }
    if ($null -ne $base) { $base.Dispose() }
  }
}

function Remove-ExactToastRegistration {
  param(
    [Parameter(Mandatory = $true)]$View,
    [Parameter(Mandatory = $true)][string]$Clsid,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
  )

  $base = $null
  $root = $null
  $server = $null
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Microsoft.Win32.RegistryHive]::CurrentUser,
      $View
    )
    $root = $base.OpenSubKey("Software\Classes\CLSID\$Clsid", $true)
    if ($null -eq $root) { return $false }
    $server = $root.OpenSubKey("LocalServer32", $true)
    if ($null -eq $server) { return $false }

    # Recheck exact types and data on writable handles immediately before
    # deleting only Electron's known values.
    if (-not (Test-ExactToastRegistrationHandles $root $server $ExpectedExecutable)) {
      return $false
    }

    $server.DeleteValue("", $false)
    $server.Dispose()
    $server = $null
    $serverCheck = $root.OpenSubKey("LocalServer32", $false)
    if ($null -ne $serverCheck) {
      try {
        if ($serverCheck.ValueCount -eq 0 -and $serverCheck.SubKeyCount -eq 0) {
          $serverCheck.Dispose()
          $serverCheck = $null
          $root.DeleteSubKey("LocalServer32", $false)
        }
      }
      finally {
        if ($null -ne $serverCheck) { $serverCheck.Dispose() }
      }
    }

    $root.DeleteValue("CustomActivator", $false)
    $root.DeleteValue("", $false)
    $root.Dispose()
    $root = $null

    $rootCheck = $base.OpenSubKey("Software\Classes\CLSID\$Clsid", $false)
    if ($null -ne $rootCheck) {
      try {
        if ($rootCheck.ValueCount -eq 0 -and $rootCheck.SubKeyCount -eq 0) {
          $rootCheck.Dispose()
          $rootCheck = $null
          $base.DeleteSubKey("Software\Classes\CLSID\$Clsid", $false)
        }
      }
      finally {
        if ($null -ne $rootCheck) { $rootCheck.Dispose() }
      }
    }
    return $true
  }
  finally {
    if ($null -ne $server) { $server.Dispose() }
    if ($null -ne $root) { $root.Dispose() }
    if ($null -ne $base) { $base.Dispose() }
  }
}

function Find-ExactToastRegistrations {
  param([Parameter(Mandatory = $true)][string]$ExpectedExecutable)

  $matches = @()
  foreach ($view in (Get-RegistryViews)) {
    $base = $null
    $clsidRoot = $null
    try {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::CurrentUser,
        $view
      )
      $clsidRoot = $base.OpenSubKey("Software\Classes\CLSID", $false)
      if ($null -eq $clsidRoot) { continue }
      foreach ($name in $clsidRoot.GetSubKeyNames()) {
        $parsed = [System.Guid]::Empty
        if (-not [System.Guid]::TryParse($name, [ref]$parsed)) { continue }
        if (Test-ExactToastRegistration $view $name $ExpectedExecutable) {
          $matches += [PSCustomObject]@{ View = $view; Clsid = $name }
        }
      }
    }
    finally {
      if ($null -ne $clsidRoot) { $clsidRoot.Dispose() }
      if ($null -ne $base) { $base.Dispose() }
    }
  }
  return @($matches)
}

try {
  if (-not [System.IO.Path]::IsPathRooted($InstalledExecutable)) {
    throw "InstalledExecutable must be an absolute path"
  }
  if (
    $ShortcutName.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
    -not [string]::Equals(
      [System.IO.Path]::GetFileName($ShortcutName),
      $ShortcutName,
      [System.StringComparison]::Ordinal
    )
  ) {
    throw "ShortcutName must be one filename segment"
  }

  $installedExe = Get-NormalizedPath $InstalledExecutable
  $installDir = Get-NormalizedPath ([System.IO.Path]::GetDirectoryName($installedExe))
  $expectedMarker = Join-Path $installDir ".lvis-nsis-per-machine-v1"
  if (-not (Test-SamePath $InstallMarker $expectedMarker)) {
    throw "InstallMarker must be the fixed NSIS marker under the install directory"
  }
  $markerItem = Get-Item -LiteralPath $expectedMarker -Force -ErrorAction SilentlyContinue
  if (
    $null -eq $markerItem -or
    $markerItem.PSIsContainer -or
    (($markerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
    $markerItem.Length -ne 0
  ) {
    throw "the exact zero-byte regular NSIS marker contract is unavailable: $expectedMarker"
  }
  $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
  if ([string]::IsNullOrWhiteSpace($programs)) {
    throw "the current user's Programs known folder is unavailable"
  }
  $shortcutPath = Join-Path $programs ($ShortcutName + ".lnk")

  $shortcutItem = Get-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
  if ($null -ne $shortcutItem) {
    if (
      $shortcutItem.PSIsContainer -or
      (($shortcutItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    ) {
      Write-CleanupEvent "foreign-preserved" "shortcut" (
        "preserved non-regular or reparse-point candidate: $shortcutPath"
      )
    }
    else {
      $record = Get-ShortcutRecord $shortcutPath
      if (-not (Test-SamePath $record.Target $installedExe)) {
        Write-CleanupEvent "foreign-preserved" "shortcut" (
          "preserved different-target shortcut: $shortcutPath"
        )
      }
      else {
        $mismatches = @(
          Get-ShortcutOwnershipMismatches $record $installedExe $installDir $ShortcutName $AppUserModelId
        )
        if ($mismatches.Count -ne 0) {
          Write-CleanupEvent "foreign-preserved" "shortcut" (
            "preserved same-target partial-owned shortcut; mismatched fields: {0}" -f
            ($mismatches -join ",")
          )
        }
        else {

          # Move within the same directory first, then recheck the moved identity.
          # A path swap before Move is quarantined and preserved after mismatch;
          # a path created after Move is never the object we delete.
          $quarantinePath = Join-Path $programs (
            ".{0}.lvis-uninstall-{1}.lnk" -f
            $ShortcutName,
            [System.Guid]::NewGuid().ToString("N")
          )
          [System.IO.File]::Move($shortcutPath, $quarantinePath)
          try {
            $quarantinedItem = Get-Item -LiteralPath $quarantinePath -Force
            if (
              $quarantinedItem.PSIsContainer -or
              (($quarantinedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
            ) {
              throw "the shortcut changed to a non-regular or reparse-point object before quarantine"
            }
            $quarantinedRecord = Get-ShortcutRecord $quarantinePath
            $quarantinedMismatches = @(
              Get-ShortcutOwnershipMismatches $quarantinedRecord $installedExe $installDir $ShortcutName $AppUserModelId
            )
            if ($quarantinedMismatches.Count -ne 0) {
              throw (
                "the shortcut changed before atomic quarantine; mismatched fields: {0}" -f
                ($quarantinedMismatches -join ",")
              )
            }

            [System.IO.File]::Delete($quarantinePath)
            if (Test-Path -LiteralPath $quarantinePath) {
              throw "the quarantined owned shortcut survived cleanup"
            }
          }
          catch {
            $quarantineFailure = $_
            if (Test-Path -LiteralPath $quarantinePath) {
              if (-not (Test-Path -LiteralPath $shortcutPath)) {
                [System.IO.File]::Move($quarantinePath, $shortcutPath)
                Write-CleanupEvent "foreign-preserved" "shortcut" (
                  "restored the quarantined shortcut after ownership changed"
                )
              }
              else {
                Write-CleanupEvent "contract-failed" "shortcut-quarantine" (
                  "preserved the changed candidate at $quarantinePath because the original path was reoccupied"
                )
              }
            }
            throw $quarantineFailure
          }
          Write-CleanupEvent "removed" "shortcut" (
            "removed exact current-user LVIS notification shortcut: $shortcutPath"
          )
        }
      }
    }
  }
  else {
    Write-CleanupEvent "verified-absent" "shortcut" (
      "current-user LVIS notification shortcut was already absent: $shortcutPath"
    )
  }

  foreach ($registration in @(Find-ExactToastRegistrations $installedExe)) {
    if (Remove-ExactToastRegistration $registration.View $registration.Clsid $installedExe) {
      Write-CleanupEvent "removed" "toast-registration" (
        "Removed exact current-user LVIS toast registration {0} ({1})." -f
        $registration.Clsid,
        $registration.View
      )
    }
  }

  $remaining = @(Find-ExactToastRegistrations $installedExe)
  if ($remaining.Count -ne 0) {
    throw "one or more exact LVIS toast registrations survived cleanup"
  }
  Write-CleanupEvent "verified-absent" "toast-registration" (
    "no exact current-user LVIS toast registrations remain"
  )

  $shortcutResidue = Get-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
  if (
    $null -ne $shortcutResidue -and
    -not $shortcutResidue.PSIsContainer -and
    (($shortcutResidue.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)
  ) {
    $residueRecord = Get-ShortcutRecord $shortcutPath
    if (Test-SamePath $residueRecord.Target $installedExe) {
      $residueMismatches = @(
        Get-ShortcutOwnershipMismatches $residueRecord $installedExe $installDir $ShortcutName $AppUserModelId
      )
      if ($residueMismatches.Count -eq 0) {
        throw "the exact owned shortcut survived the final cleanup postcondition"
      }
      Write-CleanupEvent "foreign-preserved" "shortcut" (
        "preserved same-target partial-owned shortcut at final postcondition; mismatched fields: {0}" -f
        ($residueMismatches -join ",")
      )
    }
  }
  exit 0
}
catch {
  $failureMessage = $_.Exception.Message
  Write-CleanupEvent "contract-failed" "notification-artifacts" $failureMessage
  [Console]::Error.WriteLine(
    "LVIS current-user notification artifact cleanup failed: {0}",
    $failureMessage
  )
  exit 1
}
