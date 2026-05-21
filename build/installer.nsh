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

!macro customUnInstall
  Push $R0
  Push $R1

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
