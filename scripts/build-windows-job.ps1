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
# Import the compiler environment without passing checkout paths through cmd.
# UTF-16 preserves environment values containing non-ASCII user/profile paths.
$setup = New-Object System.Diagnostics.ProcessStartInfo
$setup.FileName = $env:ComSpec
$setup.Arguments = '/d /u /s /c ""%LVIS_JOB_VSDEVCMD%" -no_logo -arch=' + $Arch + ' -host_arch=x64 >nul && set"'
$setup.EnvironmentVariables["LVIS_JOB_VSDEVCMD"] = $devcmd
$setup.WorkingDirectory = $installation
$setup.UseShellExecute = $false
$setup.RedirectStandardOutput = $true
$setup.StandardOutputEncoding = [System.Text.Encoding]::Unicode
$setupProcess = [System.Diagnostics.Process]::Start($setup)
$environmentText = $setupProcess.StandardOutput.ReadToEnd()
$setupProcess.WaitForExit()
$setupExitCode = $setupProcess.ExitCode
$setupProcess.Dispose()
if ($setupExitCode -ne 0) { throw "C++ compiler environment setup failed ($setupExitCode)" }
foreach ($line in ($environmentText -split "`r?`n")) {
    $separator = $line.IndexOf('=')
    if ($separator -gt 0) {
        [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1), "Process")
    }
}
$compilerArgs = @("/nologo", "/std:c++17", "/O2", "/MT", "/W4", "/WX", "/EHsc")
if ($FailureFixture) { $compilerArgs += "/DLVIS_TEST_INVALID_JOB" }
$compilerArgs += @($source, "/Fo:$out/launcher.obj", "/Fe:$out/$name", "/link", "/INCREMENTAL:NO", "/Brepro")
# Direct argument passing preserves Unicode, spaces, and literal percent signs.
& cl.exe @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "Windows job launcher build failed ($LASTEXITCODE)" }
Remove-Item -LiteralPath (Join-Path $out "launcher.obj") -ErrorAction SilentlyContinue
