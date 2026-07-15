; LVIS NSIS installer hook — user-data cleanup on uninstall.
;
; electron-builder의 `nsis.include` 로 wiring. `/KEEP_APP_DATA`가 모든 userData를
; 실제로 보존할 수 있도록 `deleteAppDataOnUninstall: false`를 사용하고, 이 hook이
; Roaming/Local/홈 데이터 삭제를 한 분기에서 책임진다:
;
;   - `%USERPROFILE%\.lvis\`   — LVIS_HOME (sessions, memories, secrets, plugins data)
;   - `%APPDATA%\${APP_*}\`    — Electron userData/cache의 현재/과거 이름
;   - `%LOCALAPPDATA%\${APP_*}\` — Chromium GPU cache 등 Electron 잔여
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

; Query URL Protocol with Win32 type+data constraints. ReadRegStr also accepts
; REG_EXPAND_SZ, so it cannot enforce the per-value ownership rule by itself.
!define LVIS_RRF_RT_REG_SZ 0x00000002
!define LVIS_RRF_SUBKEY_WOW6464KEY 0x00010000
!define LVIS_RRF_SUBKEY_WOW6432KEY 0x00020000
!define LVIS_RRF_NOEXPAND 0x10000000
!define LVIS_RRF_ZEROONFAILURE 0x20000000
!define LVIS_NSIS_PER_MACHINE_MARKER ".lvis-nsis-per-machine-v1"
!define LVIS_NOTIFICATION_CLEANUP_SCRIPT "uninstall-windows-notification-artifacts.ps1"

; _root is a predefined HKEY handle. _out becomes 1 only for exactly one
; terminating NUL stored as REG_SZ in electron-builder's selected view.
!macro lvisIsExactEmptyUrlProtocolRegSz _root _out
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy ${_out} "0"

  StrCpy $0 ${LVIS_RRF_RT_REG_SZ}
  IntOp $0 $0 | ${LVIS_RRF_NOEXPAND}
  IntOp $0 $0 | ${LVIS_RRF_ZEROONFAILURE}
  StrCpy $1 ${LVIS_RRF_SUBKEY_WOW6432KEY}
  !ifdef APP_ARM64
    ${If} ${RunningX64}
    ${OrIf} ${IsNativeARM64}
      StrCpy $1 ${LVIS_RRF_SUBKEY_WOW6464KEY}
    ${EndIf}
  !else
    !ifdef APP_64
      ${If} ${RunningX64}
        StrCpy $1 ${LVIS_RRF_SUBKEY_WOW6464KEY}
      ${EndIf}
    !endif
  !endif
  IntOp $0 $0 | $1

  ; Sentinel plus size/type checks reject malformed strings and every foreign
  ; registry kind. RegGetValueW includes the terminating UTF-16 NUL in size.
  System::Call '*(&i2 65535) p .r2'
  ${If} $2 != 0
    StrCpy $4 2
    System::Call 'advapi32::RegGetValueW(p ${_root}, w "Software\Classes\lvis", w "URL Protocol", i r0, *i .r3, p r2, *i r4r4) i .r5'
    ${If} $5 = 0
    ${AndIf} $3 = 1
    ${AndIf} $4 = 2
      System::Call '*$2(&i2 .r6)'
      ${If} $6 = 0
        StrCpy ${_out} "1"
      ${EndIf}
    ${EndIf}
    System::Free $2
  ${EndIf}

  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
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
  Push $R1
  Push $R2
  Push $R3

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
  ; This installer-only marker distinguishes a completed elevated NSIS install
  ; from a ZIP/win-unpacked launch. Remove a stale marker first so every
  ; subsequent failure is represented by its absence.
  ClearErrors
  Delete "$INSTDIR\${LVIS_NSIS_PER_MACHINE_MARKER}"
  IfFileExists "$INSTDIR\${LVIS_NSIS_PER_MACHINE_MARKER}" 0 lvis_machine_marker_absent
    StrCpy $R3 "could not remove the stale per-machine install marker"
    Goto lvis_machine_install_contract_failed

  lvis_machine_marker_absent:
  ; Keep the error flag sticky across the complete registry write set.
  ClearErrors
  ; electron-builder 26.x does not consume build.protocols for NSIS. Own the
  ; packaged lvis:// association explicitly in the all-users shell context.
  WriteRegStr SHELL_CONTEXT "Software\Classes\lvis" "" "URL:lvis"
  WriteRegStr SHELL_CONTEXT "Software\Classes\lvis" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\lvis\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\lvis\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ; electron-builder writes InstallLocation only to its private install key.
  ; Mirror it into Apps & Features so smoke/enterprise inventory can discover
  ; and cross-check the machine install without guessing a Program Files path.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
  ${If} ${Errors}
    StrCpy $R3 "could not write the per-machine registry contract"
    Goto lvis_machine_install_contract_failed
  ${EndIf}

  ; Verify exact values and types before attesting completion with the marker.
  StrCpy $R3 "per-machine registry readback did not match the install contract"
  ClearErrors
  ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\lvis" ""
  ${If} ${Errors}
    Goto lvis_machine_install_contract_failed
  ${EndIf}
  StrCmpS $R1 "URL:lvis" 0 lvis_machine_install_contract_failed

  !insertmacro lvisIsExactEmptyUrlProtocolRegSz 0x80000002 $R1
  StrCmp $R1 "1" 0 lvis_machine_install_contract_failed

  ClearErrors
  ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\lvis\DefaultIcon" ""
  ${If} ${Errors}
    Goto lvis_machine_install_contract_failed
  ${EndIf}
  StrCmpS $R1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0' 0 lvis_machine_install_contract_failed

  ClearErrors
  ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\lvis\shell\open\command" ""
  ${If} ${Errors}
    Goto lvis_machine_install_contract_failed
  ${EndIf}
  StrCmpS $R1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"' 0 lvis_machine_install_contract_failed

  ClearErrors
  ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} ${Errors}
    Goto lvis_machine_install_contract_failed
  ${EndIf}
  StrCmpS $R1 "$INSTDIR" 0 lvis_machine_install_contract_failed

  ; Create a zero-byte regular file as the final successful install action.
  ; No runtime code reads marker contents; existence and file type are the
  ; complete contract.
  StrCpy $R3 "could not create the per-machine install marker"
  ClearErrors
  FileOpen $R1 "$INSTDIR\${LVIS_NSIS_PER_MACHINE_MARKER}" w
  ${If} ${Errors}
    Goto lvis_machine_install_contract_failed
  ${EndIf}
  FileClose $R1

  StrCpy $R2 "-1"
  ClearErrors
  FileOpen $R1 "$INSTDIR\${LVIS_NSIS_PER_MACHINE_MARKER}" r
  ${If} ${Errors}
    Goto lvis_machine_install_contract_failed
  ${EndIf}
  FileSeek $R1 0 END $R2
  FileClose $R1
  ${If} ${Errors}
    Goto lvis_machine_install_contract_failed
  ${EndIf}
  StrCmp $R2 "0" lvis_machine_install_contract_verified

  StrCpy $R3 "per-machine install marker is not a zero-byte regular file"
  Goto lvis_machine_install_contract_failed

  lvis_machine_install_contract_failed:
  ClearErrors
  Delete "$INSTDIR\${LVIS_NSIS_PER_MACHINE_MARKER}"
  IfFileExists "$INSTDIR\${LVIS_NSIS_PER_MACHINE_MARKER}" 0 +3
    SetErrorLevel 1
    Abort "LVIS install failed: $R3; the incomplete marker could not be removed"
  SetErrorLevel 1
  Abort "LVIS install failed: $R3"

  lvis_machine_install_contract_verified:
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $0
!macroend

!ifdef BUILD_UNINSTALLER
Function un.lvisCleanupCurrentUserNotificationArtifacts
  InitPluginsDir
  File /oname=$PLUGINSDIR\${LVIS_NOTIFICATION_CLEANUP_SCRIPT} "${BUILD_RESOURCES_DIR}\${LVIS_NOTIFICATION_CLEANUP_SCRIPT}"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\${LVIS_NOTIFICATION_CLEANUP_SCRIPT}" -InstalledExecutable "$R0" -ShortcutName "$R1" -AppUserModelId "$R2" -InstallMarker "$R3"'
  Pop $R4
  Pop $R5
  Delete "$PLUGINSDIR\${LVIS_NOTIFICATION_CLEANUP_SCRIPT}"
FunctionEnd
!endif

!macro customUnInstall
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5

  ClearErrors
  ${GetParameters} $R0

  ; Only electron-builder's updater uninstall may preserve machine-level ASRT.
  ; /KEEP_APP_DATA is a genuine uninstall choice and controls userData only.
  ${if} ${isUpdated}
    Goto lvis_skip_genuine_uninstall
  ${endif}

  ClearErrors
  ${GetOptions} $R0 "--updated" $R2
  ${ifNot} ${Errors}
    Goto lvis_skip_genuine_uninstall
  ${endif}

  ; Electron 43 creates a current-user notification shortcut and HKCU toast
  ; activator registration even for a per-machine app. Genuine uninstall must
  ; remove only the exact invoking-user artifacts. In the normal alternate-
  ; admin UAC path, execute synchronously in electron-builder's retained outer
  ; user process; an already-elevated invocation runs as its current identity.
  StrCpy $R0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  StrCpy $R1 "${PRODUCT_NAME}"
  StrCpy $R2 "${APP_ID}"
  StrCpy $R3 "$INSTDIR\${LVIS_NSIS_PER_MACHINE_MARKER}"
  ; Fail closed if the UAC outer-process call itself fails before the cleanup
  ; function can overwrite its synchronized result registers.
  StrCpy $R4 "1"
  StrCpy $R5 "LVIS notification cleanup did not run"
  ${if} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_Call Function un.lvisCleanupCurrentUserNotificationArtifacts ${UAC_SYNCREGISTERS}
  ${else}
    Call un.lvisCleanupCurrentUserNotificationArtifacts
  ${endif}
  DetailPrint "$R5"
  ${if} $R4 != 0
    SetErrorLevel 1
    Abort "LVIS uninstall failed: current-user notification artifact cleanup returned exit $R4"
  ${endif}

  ClearErrors
  ${GetParameters} $R0
  StrCpy $R1 "0"
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R2
  ${ifNot} ${Errors}
    StrCpy $R1 "1"
  ${endif}

  ; ── ASRT OS sandbox teardown (every genuine uninstall) ──
  ; Recover dead holder-PID grants before deleting the sandbox principal, then
  ; remove the WFP filters, sandbox user/group, credential and setup marker.
  ; Both operations are fail-closed here: silently deleting app files while
  ; leaving machine security state behind would make a green smoke misleading.
  !insertmacro resolveSrtWinPath $R2
  ${if} $R2 != ""
    DetailPrint "LVIS: recovering stranded ASRT holder ACLs…"
    nsExec::ExecToLog '"$R2" acl recover --force'
    Pop $R3
    ${if} $R3 != 0
      SetErrorLevel 1
      Abort "LVIS uninstall failed: ASRT holder ACL recovery returned exit $R3"
    ${endif}

    DetailPrint "LVIS: removing the Windows OS sandbox (srt-win uninstall)…"
    nsExec::ExecToLog '"$R2" uninstall'
    Pop $R3
    ${if} $R3 != 0
      SetErrorLevel 1
      Abort "LVIS uninstall failed: ASRT teardown returned exit $R3"
    ${endif}
    DetailPrint "LVIS: OS sandbox removed (holder ACLs + srt-sandbox user/group + credential + WFP rules)."
  ${else}
    SetErrorLevel 1
    Abort "LVIS uninstall failed: packaged srt-win.exe is missing; ASRT teardown cannot be verified"
  ${endif}

  ; KEEP_APP_DATA is evaluated only after ASRT teardown.
  ${if} $R1 == "1"
    Goto lvis_skip_userdata
  ${endif}

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "LVIS 사용자 데이터를 함께 삭제하시겠습니까?$\n$\n[예]: 모든 채팅 기록, 설정, 메모리, plugin 데이터, 데모 활성 상태가 영구 삭제됩니다.$\n[아니오]: 사용자 데이터는 보존됩니다 — 같은 사용자가 LVIS 를 재설치하면 이어서 사용할 수 있습니다." \
    /SD IDYES IDNO lvis_skip_userdata

  ; A perMachine uninstaller normally has all-users shell context. User data
  ; belongs to the original interactive user, matching electron-builder's own
  ; deletion template, so switch only inside the DELETE branch and restore it.
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}

  ; LVIS_HOME — sessions / memories / secrets / plugins / audit / .env.demo
  RMDir /r "$PROFILE\.lvis"

  ; Keep electron-builder's current/legacy APPDATA candidates together with
  ; their Local AppData counterparts. KEEP_APP_DATA skips this whole block.
  RMDir /r "$APPDATA\${APP_FILENAME}"
  RMDir /r "$LOCALAPPDATA\${APP_FILENAME}"
  !ifdef APP_PRODUCT_FILENAME
    RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    RMDir /r "$LOCALAPPDATA\${APP_PRODUCT_FILENAME}"
  !endif
  !ifdef APP_PACKAGE_NAME
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}"
  !endif

  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}

  lvis_skip_userdata:
  lvis_skip_genuine_uninstall:
  Pop $R5
  Pop $R4
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
  ; Updater uninstalls must preserve the association across atomic replacement.
  ; Explicit --updated is checked independently because not every updater path
  ; exposes electron-builder's compile-time isUpdated branch.
  ${if} ${isUpdated}
    Goto lvis_protocol_cleanup_done
  ${endif}

  ClearErrors
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${ifNot} ${Errors}
    Goto lvis_protocol_cleanup_done
  ${endif}

  ; A genuine uninstall removes protocol values only when the full exact
  ; quoted command is still owned by this exact install. Each additional value
  ; is compared independently so user/foreign changes survive; parent keys are
  ; removed only when no values or subkeys remain.
  StrCpy $R2 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  StrCpy $R0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'

  ClearErrors
  ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\lvis\shell\open\command" ""
  StrCmp $R1 $R2 0 lvis_protocol_cleanup_hkcu
  DeleteRegValue SHELL_CONTEXT "Software\Classes\lvis\shell\open\command" ""
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\lvis\shell\open\command"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\lvis\shell\open"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\lvis\shell"

  ClearErrors
  ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\lvis\DefaultIcon" ""
  StrCmp $R1 $R0 0 +2
    DeleteRegValue SHELL_CONTEXT "Software\Classes\lvis\DefaultIcon" ""
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\lvis\DefaultIcon"

  !insertmacro lvisIsExactEmptyUrlProtocolRegSz 0x80000002 $R1
  StrCmp $R1 "1" 0 +2
    DeleteRegValue SHELL_CONTEXT "Software\Classes\lvis" "URL Protocol"
  ClearErrors
  ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\lvis" ""
  StrCmpS $R1 "URL:lvis" 0 +2
    DeleteRegValue SHELL_CONTEXT "Software\Classes\lvis" ""
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\lvis"

  lvis_protocol_cleanup_hkcu:
  ClearErrors
  ReadRegStr $R1 HKEY_CURRENT_USER "Software\Classes\lvis\shell\open\command" ""
  StrCmp $R1 $R2 0 lvis_protocol_cleanup_done
  DeleteRegValue HKEY_CURRENT_USER "Software\Classes\lvis\shell\open\command" ""
  DeleteRegKey /ifempty HKEY_CURRENT_USER "Software\Classes\lvis\shell\open\command"
  DeleteRegKey /ifempty HKEY_CURRENT_USER "Software\Classes\lvis\shell\open"
  DeleteRegKey /ifempty HKEY_CURRENT_USER "Software\Classes\lvis\shell"

  ClearErrors
  ReadRegStr $R1 HKEY_CURRENT_USER "Software\Classes\lvis\DefaultIcon" ""
  StrCmp $R1 $R0 0 +2
    DeleteRegValue HKEY_CURRENT_USER "Software\Classes\lvis\DefaultIcon" ""
  DeleteRegKey /ifempty HKEY_CURRENT_USER "Software\Classes\lvis\DefaultIcon"

  !insertmacro lvisIsExactEmptyUrlProtocolRegSz 0x80000001 $R1
  StrCmp $R1 "1" 0 +2
    DeleteRegValue HKEY_CURRENT_USER "Software\Classes\lvis" "URL Protocol"
  ClearErrors
  ReadRegStr $R1 HKEY_CURRENT_USER "Software\Classes\lvis" ""
  StrCmpS $R1 "URL:lvis" 0 +2
    DeleteRegValue HKEY_CURRENT_USER "Software\Classes\lvis" ""
  DeleteRegKey /ifempty HKEY_CURRENT_USER "Software\Classes\lvis"

  lvis_protocol_cleanup_done:
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
