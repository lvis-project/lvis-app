; LVIS NSIS installer hook — user-data cleanup on uninstall.
;
; electron-builder의 `nsis.include` 로 wiring. `deleteAppDataOnUninstall: true`
; 가 `%APPDATA%\LVIS\` (Electron userData = Roaming\LVIS\) 자동 제거를 처리하므로,
; 이 hook 은 *그 범위 밖* 의 사용자 데이터 정리만 책임진다:
;
;   - `%USERPROFILE%\.lvis\`   — LVIS_HOME (sessions, memories, secrets, plugins data)
;   - `%LOCALAPPDATA%\LVIS\`   — Local AppData (Chromium GPU cache 등 Electron 잔여)
;
; 사용자 confirmation:
;   - GUI 설치 제거 → MessageBox 로 "Yes/No" 묻기. Default 는 Yes.
;   - Silent uninstall (`/S` flag) → /SD IDYES 라서 자동 Yes (스크립트/MDM 운영 정합).
;
; 제거 사유 / 보존 사유:
;   - 사용자 명시 directive (2026-05-20): "삭제 코드를 추가했는데 Roaming 폴더 / 홈
;     디렉토리 하위 .lvis 가 잔여로 남음 — 완전 제거되도록 수정". 즉 *default 완전
;     제거* 가 원래 의도. 단 *되돌리기 불가* 손실이라 [아니오] 선택 시 보존 path 도 제공.

; ─────────────────────────────────────────────────────────────────────────────
; Resolve the packaged srt-win.exe (ASRT Windows OS-sandbox backend) under
; $INSTDIR into the caller-supplied register. Empty string when neither arch is
; present. electron-after-pack (scripts/electron-after-pack.cjs) keeps at least
; the packed arch's vendor dir, so try x64 then arm64 and use whichever exists —
; this works regardless of which arch was packed. Relative jumps (+2/+3) count
; NSIS instructions and mirror the IfFileExists/StrCpy pattern already used in
; customRemoveFiles below.
!macro resolveSrtWinPath _out
  StrCpy ${_out} ""
  IfFileExists "$INSTDIR\resources\app.asar.unpacked\node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\x64\srt-win.exe" 0 +2
    StrCpy ${_out} "$INSTDIR\resources\app.asar.unpacked\node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\x64\srt-win.exe"
  StrCmp ${_out} "" 0 +3
  IfFileExists "$INSTDIR\resources\app.asar.unpacked\node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\arm64\srt-win.exe" 0 +2
    StrCpy ${_out} "$INSTDIR\resources\app.asar.unpacked\node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\arm64\srt-win.exe"
!macroend

; ─────────────────────────────────────────────────────────────────────────────
; ASRT (OS execution sandbox) — provision the Windows srt-win backend at
; install time so the sandbox is ready at first launch (issue #1608). Runs after
; installApplicationFiles (electron-builder installSection.nsh inserts
; customInstall last), so srt-win.exe is present.
;
; A bundled srt-win.exe is NOT the same as a provisioned sandbox: provisioning
; creates a hidden `srt-sandbox` Windows user + user-SID-keyed WFP network-filter
; rules + filesystem ACLs. This makes the runtime Settings panel a repair-only
; fallback instead of the primary "Install now" path.
;
; TWO things are required for the sandbox to actually WORK (not just provision):
;   1. ELEVATION. This app ships oneClick:true + perMachine:true (package.json
;      build.nsis) — an all-users Program Files install that self-elevates once.
;      srt-win.exe self-elevates too, but invoked from the already-elevated
;      installer it detects admin and proceeds WITHOUT a second UAC. (Confirm on
;      a real install run; we pass no unverified skip-elevation flag.)
;   2. FILE ACL (owner-diagnosed 2026-07-13 — the real root cause of the earlier
;      `CreateProcessWithLogonW(srt-sandbox)` 0x80070005 access-denied). The
;      sandbox runs the egress-probe / tool runner AS the low-privilege
;      `srt-sandbox` user, which cannot read/execute srt-win.exe (or the ASRT
;      package files) unless the path's ACL grants it. Program Files grants Users
;      read+execute by default, but we ALSO grant `sandbox-runtime-users` RX
;      explicitly (below) so it is robust regardless of the packed ACL. Without
;      this the sandbox provisions but never initializes.
;
; NON-FATAL in ALL cases — provisioning/ACL failure must NEVER Abort the app
; install (matches the non-bricking sandbox posture: win32-not-ready does not
; hard-throw; the runtime repair panel + README recovery are the fallback).
!macro customInstall
  Push $0
  Push $R0

  !insertmacro resolveSrtWinPath $R0
  ${if} $R0 == ""
    DetailPrint "LVIS: srt-win.exe not found under $INSTDIR — skipping OS sandbox provisioning (runtime repair panel remains available)."
    Goto lvis_srtwin_install_done
  ${endif}

  DetailPrint "LVIS: provisioning the Windows OS sandbox (srt-win install)…"
  ; --proxy-port-range MUST equal ASRT's DEFAULT_WINDOWS_PROXY_PORT_RANGE
  ; ([60080, 60089]): the WFP rule stamped here must cover exactly the range the
  ; srt-win egress proxy binds at runtime, or all egress hard-fails. A vitest
  ; drift guard (src/permissions/__tests__/installer-nsh-proxy-port-drift.test.ts)
  ; pins this literal against ASRT's real export so an upstream range change
  ; fails CI instead of silently desyncing the two paths.
  nsExec::ExecToLog '"$R0" install --proxy-port-range 60080-60089'
  Pop $0

  ${if} $0 == 0
    DetailPrint "LVIS: OS sandbox provisioned (srt-sandbox user + WFP rules + FS ACLs)."
  ${elseif} $0 == 13
    ; Already provisioned with a DIFFERENT config. Do NOT auto-pass --force — a
    ; differing port range / sandbox-user is the owner's call. Treat as
    ; already-provisioned (success-ish) and just log for the audit trail.
    DetailPrint "LVIS: OS sandbox already provisioned with a different config (exit 13) — left as-is (no --force). Re-provision from Settings → 권한 if needed."
  ${elseif} $0 == 10
    DetailPrint "LVIS: OS sandbox provisioning cancelled at the UAC prompt (exit 10). Provision later from Settings → 권한."
  ${elseif} $0 == 12
    DetailPrint "LVIS: OS sandbox WFP filter install failed (exit 12). Repair later from Settings → 권한."
  ${elseif} $0 == 14
    DetailPrint "LVIS: OS sandbox user provisioning failed (exit 14). Repair later from Settings → 권한."
  ${else}
    DetailPrint "LVIS: OS sandbox provisioning did not complete (exit $0). Repair later from Settings → 권한."
  ${endif}

  ; FILE-ACL grant (root-cause fix — see header). srt-sandbox must be able to
  ; read/execute the packaged ASRT backend, or the runtime egress probe spawns
  ; access-denied (0x80070005) and the sandbox never initializes. Grant the
  ; ASRT-created `sandbox-runtime-users` group (srt-sandbox is a member) RX on
  ; the packaged ASRT dir, recursively. Non-fatal; harmless if the group is
  ; absent (provisioning failed above).
  DetailPrint "LVIS: granting srt-sandbox read+execute on the ASRT backend (ACL)…"
  nsExec::ExecToLog 'icacls "$INSTDIR\resources\app.asar.unpacked\node_modules\@anthropic-ai\sandbox-runtime" /grant "sandbox-runtime-users:(OI)(CI)(RX)" /T /C'
  Pop $0
  ${if} $0 != 0
    DetailPrint "LVIS: ACL grant to sandbox-runtime-users returned $0 (non-fatal). If the OS sandbox reports access-denied at runtime, re-run the icacls grant — see README → 'ASRT sandbox access denied' recovery."
  ${endif}

  lvis_srtwin_install_done:
  Pop $R0
  Pop $0
!macroend

!macro customUnInstall
  Push $R0
  Push $R1
  Push $R2
  Push $R3

  ; electron-builder invokes the old uninstaller with /KEEP_APP_DATA and
  ; --updated during upgrades. Preserve user state on that path; manual
  ; uninstall still asks below.
  ${if} ${isUpdated}
    Goto lvis_skip_userdata
  ${endif}

  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${ifNot} ${Errors}
    Goto lvis_skip_userdata
  ${endif}

  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${ifNot} ${Errors}
    Goto lvis_skip_userdata
  ${endif}

  ; ── ASRT OS sandbox teardown (genuine uninstall only) ──
  ; Remove the machine-level srt-sandbox user + user-SID-keyed WFP rules that
  ; customInstall provisioned. Placed AFTER the upgrade guards above so an
  ; upgrade (isUpdated / KEEP_APP_DATA / --updated) does NOT tear the sandbox
  ; down, and BEFORE customRemoveFiles deletes $INSTDIR (electron-builder
  ; uninstaller.nsh inserts customUnInstall first) so srt-win.exe is still
  ; present. Deliberately BEFORE the user-data MessageBox: removing the
  ; system-level provisioning is orthogonal to whether the user keeps their chat
  ; data. Non-fatal + idempotent ({cancelled:true} on UAC dismiss).
  !insertmacro resolveSrtWinPath $R2
  ${if} $R2 != ""
    DetailPrint "LVIS: removing the Windows OS sandbox (srt-win uninstall)…"
    nsExec::ExecToLog '"$R2" uninstall'
    Pop $R3
    ${if} $R3 == 0
      DetailPrint "LVIS: OS sandbox removed (srt-sandbox user + WFP rules)."
    ${else}
      DetailPrint "LVIS: OS sandbox removal returned exit $R3 (non-fatal; srt-win uninstall is idempotent)."
    ${endif}
  ${endif}

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "LVIS 사용자 데이터를 함께 삭제하시겠습니까?$\n$\n[예]: 모든 채팅 기록, 설정, 메모리, plugin 데이터, 데모 활성 상태가 영구 삭제됩니다.$\n[아니오]: 사용자 데이터는 보존됩니다 — 같은 사용자가 LVIS 를 재설치하면 이어서 사용할 수 있습니다." \
    /SD IDYES IDNO lvis_skip_userdata

  ; LVIS_HOME — sessions / memories / secrets / plugins / audit / .env.demo
  RMDir /r "$PROFILE\.lvis"

  ; Local AppData 잔여 (Chromium GPU cache, partition cache 등). Roaming\LVIS\ 는
  ; electron-builder 의 `deleteAppDataOnUninstall: true` 가 별도 처리하므로 여기서
  ; 다시 손대지 않는다.
  RMDir /r "$LOCALAPPDATA\LVIS"

  lvis_skip_userdata:
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customRemoveFiles
  Push $R0
  Push $R1
  Push $R2

  ; Keep electron-builder's update-time atomic replacement behavior. Updates
  ; must remove old app files without treating user-data cleanup as uninstall.
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${endif}

  ; Move out of $INSTDIR before deleting it; otherwise Windows can keep the
  ; running uninstaller's current directory locked.
  SetOutPath "$TEMP"
  ClearErrors
  RMDir /r "$INSTDIR"

  StrCpy $R2 ""
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 +2
    StrCpy $R2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  IfFileExists "$INSTDIR\resources\app.asar" 0 +2
    StrCpy $R2 "$INSTDIR\resources\app.asar"
  ${if} $R2 == ""
    IfFileExists "$INSTDIR\*.*" 0 lvis_remove_files_done
    StrCpy $R2 "$INSTDIR"
  ${endif}

  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/LVIS_ELEVATED_RETRY" $R1
  ${ifNot} ${Errors}
    Goto lvis_remove_files_failed
  ${endif}

  ${if} ${Silent}
    Goto lvis_remove_files_failed
  ${endif}

  MessageBox MB_YESNO|MB_ICONEXCLAMATION \
    "LVIS 설치 파일을 제거하지 못했습니다.$\n$\n남은 경로: $R2$\n$\n파일이 잠겨 있거나 삭제 권한이 부족할 수 있습니다. 관리자 권한으로 한 번 더 시도하시겠습니까?" \
    IDYES lvis_retry_elevated IDNO lvis_remove_files_failed

  lvis_retry_elevated:
    ; Elevated retry is only for app files. Keep user-data cleanup bound to the
    ; original user context so UAC does not switch $PROFILE/$APPDATA.
    ExecShell "runas" "$EXEPATH" "$R0 /KEEP_APP_DATA /LVIS_ELEVATED_RETRY"
    IfErrors lvis_remove_files_failed
    Pop $R2
    Pop $R1
    Pop $R0
    Quit

  lvis_remove_files_failed:
    SetErrorLevel 1
    ${ifNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "LVIS 설치 파일을 제거하지 못했습니다.$\n$\n남은 경로: $R2$\n$\nLVIS가 실행 중이면 종료한 뒤 다시 시도해 주세요."
    ${endif}
    Abort "LVIS uninstall failed: app files remain at $R2"

  lvis_remove_files_done:
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
