#!/usr/bin/env pwsh
# Windows (사내망) launcher that guarantees UTF-8 end-to-end.
#
# `npm run start:npm` already wraps Electron in `cmd.exe /s /c "chcp 65001 &
# electron …"` so the cmd-side console is UTF-8, but PowerShell 5.x caches
# `[Console]::OutputEncoding` at session start (cp949 on Korean locale) and
# can still mangle child-process stdout on the display layer. There is no
# way to change a parent PowerShell's encoding from a Node subprocess, so
# users hit by this run this script instead — it sets the session encoding
# first, then delegates to the normal `start:npm`.
#
# Usage (from lvis-app/):
#   .\scripts\start-windows.ps1
#   # or via npm (uses PowerShell regardless of the caller shell):
#   npm run start:win

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$null = chcp 65001

$ErrorActionPreference = "Stop"
npm run start:npm @args
exit $LASTEXITCODE
