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
