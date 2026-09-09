param([string]$Arch = "x64", [switch]$FailureFixture)
$ErrorActionPreference = "Stop"
if ($Arch -notin @("x64", "arm64")) { throw "Unsupported job launcher architecture: $Arch" }
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root "resources/windows-job/$Arch"
New-Item -ItemType Directory -Force $out | Out-Null
$vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
if (!(Test-Path $vswhere)) { throw "Windows job launcher requires the C++ build tools" }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw "Windows job launcher requires the C++ build tools" }
$devcmd = Join-Path $installation "Common7/Tools/VsDevCmd.bat"
$source = Join-Path $root "native/windows-job/launcher.cpp"
$name = if ($FailureFixture) { "lvis-job-failure.exe" } else { "lvis-job.exe" }
$define = if ($FailureFixture) { "/DLVIS_TEST_INVALID_JOB" } else { "" }
$command = "`"$devcmd`" -no_logo -arch=$Arch -host_arch=x64 && cl /nologo /std:c++17 /O2 /MT /W4 /WX /EHsc $define `"$source`" /Fo:`"$out/launcher.obj`" /Fe:`"$out/$name`" /link /INCREMENTAL:NO /Brepro"
$batch = Join-Path $out "build-launcher.cmd"
Set-Content -Path $batch -Value "@echo off`r`ncall $command" -Encoding ASCII
& $env:ComSpec /d /c $batch
if ($LASTEXITCODE -ne 0) { throw "Windows job launcher build failed ($LASTEXITCODE)" }
Remove-Item (Join-Path $out "launcher.obj") -ErrorAction SilentlyContinue

Remove-Item $batch -ErrorAction SilentlyContinue
