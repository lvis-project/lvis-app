; LVIS NSIS installer hook — branded assisted installer + LVIS data home.
;
; electron-builder wires this via `nsis.include`. The base installer remains
; electron-builder's signed NSIS template; this file only adds LVIS-specific
; pages/hooks:
;
;   - customPageAfterChangeDir: after the install-location wizard step, ask for
;     the LVIS data home (`LVIS_HOME`) and show a branded 16:9 waiting image.
;   - customInstall: persist the selected home as HKCU Environment\LVIS_HOME so
;     the launched app sees `process.env.LVIS_HOME` on first run.
;   - customUnInstall: optionally remove LVIS data roots outside
;     electron-builder's `%APPDATA%\LVIS` cleanup.
;
; Intentionally do NOT set HOME, USERPROFILE, or uvx cache variables. Plugin and
; MCP subprocesses keep their OS/user tool home semantics.

!include LogicLib.nsh
!include MUI2.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

; electron-builder defines this in multiUser.nsh for the main installer path,
; but the uninstaller prebuild can include custom hooks before that template.
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!ifndef IMAGE_BITMAP
  !define IMAGE_BITMAP 0
!endif
!ifndef LR_LOADFROMFILE
  !define LR_LOADFROMFILE 0x0010
!endif
!ifndef LR_CREATEDIBSECTION
  !define LR_CREATEDIBSECTION 0x2000
!endif
!ifndef LR_LOADFROMFILE_DIB
  !define LR_LOADFROMFILE_DIB 0x2010
!endif
!ifndef LVIS_HOME_MARKER
  !define LVIS_HOME_MARKER ".lvis-data-home"
!endif

Var LvisHomeSelected

!ifndef BUILD_UNINSTALLER
Var LvisHomePage
Var LvisHomeInput
Var LvisHomeBrowseButton
Var LvisHomeProgressImage

Function lvisReadHomeDefault
  ReadRegStr $LvisHomeSelected SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "LvisHome"
  ${If} $LvisHomeSelected == ""
    StrCpy $LvisHomeSelected "$PROFILE\.lvis"
  ${EndIf}
FunctionEnd

Function lvisIsUnsafeHomePath
  StrCpy $0 "0"
  StrLen $1 "$LvisHomeSelected"
  ${If} $LvisHomeSelected == ""
  ${OrIf} $1 <= 3
  ${OrIf} $LvisHomeSelected == "$PROFILE"
  ${OrIf} $LvisHomeSelected == "$APPDATA"
  ${OrIf} $LvisHomeSelected == "$LOCALAPPDATA"
    StrCpy $0 "1"
  ${EndIf}
FunctionEnd

Function lvisWriteHomeMarker
  StrCpy $0 "0"
  ClearErrors
  FileOpen $1 "$LvisHomeSelected\${LVIS_HOME_MARKER}" w
  ${If} ${Errors}
  ${OrIf} $1 == ""
    Return
  ${EndIf}
  FileWrite $1 "LVIS data home$\r$\n"
  ${IfNot} ${Errors}
    StrCpy $0 "1"
  ${EndIf}
  FileClose $1
FunctionEnd

Function lvisIsLegacyDefaultHome
  StrCpy $0 "0"
  ${If} $LvisHomeSelected == "$PROFILE\.lvis"
    StrCpy $0 "1"
  ${EndIf}
FunctionEnd

Function lvisCanUseHomePath
  StrCpy $0 "0"
  Call lvisIsUnsafeHomePath
  ${If} $0 == "1"
    Return
  ${EndIf}

  ${If} ${FileExists} "$LvisHomeSelected\${LVIS_HOME_MARKER}"
    StrCpy $0 "1"
    Return
  ${EndIf}

  Call lvisIsLegacyDefaultHome
  ${If} $0 == "1"
    Return
  ${EndIf}

  ${IfNot} ${FileExists} "$LvisHomeSelected\*"
    StrCpy $0 "1"
  ${EndIf}
FunctionEnd

Function lvisBrowseHome
  ${NSD_GetText} $LvisHomeInput $LvisHomeSelected
  nsDialogs::SelectFolderDialog "LVIS data home" "$LvisHomeSelected"
  Pop $0
  ${If} $0 != "error"
    ${If} ${FileExists} "$0\${LVIS_HOME_MARKER}"
    ${OrIf} $0 == "$PROFILE\.lvis"
      StrCpy $LvisHomeSelected $0
    ${Else}
      StrCpy $LvisHomeSelected "$0\LVIS"
    ${EndIf}
    ${NSD_SetText} $LvisHomeInput "$LvisHomeSelected"
  ${EndIf}
FunctionEnd

Function lvisHomePageCreate
  !insertmacro MUI_HEADER_TEXT "Choose LVIS data home" "Select where LVIS stores chats, settings, plugins, and runtime data."
  nsDialogs::Create 1018
  Pop $LvisHomePage
  ${If} $LvisHomePage == error
    Abort
  ${EndIf}

  Call lvisReadHomeDefault

  ${NSD_CreateLabel} 0u 0u 300u 22u "LVIS stores conversations, settings, plugin installs, and host-managed Python runtime data in this folder."
  Pop $0
  ${NSD_CreateLabel} 0u 30u 300u 10u "LVIS data home"
  Pop $0
  ${NSD_CreateText} 0u 43u 224u 14u "$LvisHomeSelected"
  Pop $LvisHomeInput
  ${NSD_CreateButton} 232u 42u 68u 16u "Browse..."
  Pop $LvisHomeBrowseButton
  ${NSD_OnClick} $LvisHomeBrowseButton lvisBrowseHome

  InitPluginsDir
  File /oname=$PLUGINSDIR\installer-progress.bmp "${__FILEDIR__}\installer-progress.bmp"
  ${NSD_CreateBitmap} 0u 68u 300u 112u ""
  Pop $LvisHomeProgressImage
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\installer-progress.bmp", i ${IMAGE_BITMAP}, i 0, i 0, i ${LR_LOADFROMFILE_DIB})p.r0'
  SendMessage $LvisHomeProgressImage ${STM_SETIMAGE} ${IMAGE_BITMAP} $0

  nsDialogs::Show
FunctionEnd

Function lvisHomePageLeave
  ${NSD_GetText} $LvisHomeInput $LvisHomeSelected
  Call lvisCanUseHomePath
  ${If} $0 != "1"
    MessageBox MB_ICONEXCLAMATION|MB_OK "Choose a new LVIS data folder or an existing LVIS data folder. Existing non-LVIS folders are not allowed; when browsing, LVIS will create a child folder named LVIS under the selected parent."
    Abort
  ${EndIf}
FunctionEnd

Function lvisPersistHome
  ${If} $LvisHomeSelected == ""
    Call lvisReadHomeDefault
  ${EndIf}

  Call lvisCanUseHomePath
  ${If} $0 != "1"
    MessageBox MB_ICONSTOP|MB_OK "LVIS cannot use the selected data folder:$\n$\n$LvisHomeSelected"
    Abort
  ${EndIf}

  ClearErrors
  CreateDirectory "$LvisHomeSelected"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP|MB_OK "LVIS cannot create the selected data folder:$\n$\n$LvisHomeSelected"
    Abort
  ${EndIf}

  Call lvisWriteHomeMarker
  ${If} $0 != "1"
    MessageBox MB_ICONSTOP|MB_OK "LVIS cannot mark the selected data folder as LVIS-owned:$\n$\n$LvisHomeSelected"
    Abort
  ${EndIf}

  ClearErrors
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "LvisHome" "$LvisHomeSelected"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP|MB_OK "LVIS cannot persist the selected data folder:$\n$\n$LvisHomeSelected"
    Abort
  ${EndIf}

  ClearErrors
  WriteRegExpandStr HKCU "Environment" "LVIS_HOME" "$LvisHomeSelected"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP|MB_OK "LVIS cannot persist LVIS_HOME for the current user:$\n$\n$LvisHomeSelected"
    Abort
  ${EndIf}

  System::Call 'Kernel32::SetEnvironmentVariableW(w "LVIS_HOME", w "$LvisHomeSelected")'
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
FunctionEnd

!macro customPageAfterChangeDir
  PageEx custom
    PageCallbacks lvisHomePageCreate lvisHomePageLeave
    Caption " "
  PageExEnd
!macroend

!macro customInstall
  Call lvisPersistHome
!macroend
!endif

!ifdef BUILD_UNINSTALLER
Function un.lvisReadInstalledHome
  ReadRegStr $LvisHomeSelected SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "LvisHome"
  ${If} $LvisHomeSelected == ""
    StrCpy $LvisHomeSelected "$PROFILE\.lvis"
  ${EndIf}
FunctionEnd

Function un.lvisIsUnsafeHomePath
  StrCpy $0 "0"
  StrLen $1 "$LvisHomeSelected"
  ${If} $LvisHomeSelected == ""
  ${OrIf} $1 <= 3
  ${OrIf} $LvisHomeSelected == "$PROFILE"
  ${OrIf} $LvisHomeSelected == "$APPDATA"
  ${OrIf} $LvisHomeSelected == "$LOCALAPPDATA"
    StrCpy $0 "1"
  ${EndIf}
FunctionEnd

Function un.lvisIsLegacyDefaultHome
  StrCpy $0 "0"
  ${If} $LvisHomeSelected == "$PROFILE\.lvis"
    StrCpy $0 "1"
  ${EndIf}
FunctionEnd

Function un.lvisCanRemoveHome
  StrCpy $0 "0"
  Call un.lvisIsUnsafeHomePath
  ${If} $0 == "1"
    Return
  ${EndIf}

  ${If} ${FileExists} "$LvisHomeSelected\${LVIS_HOME_MARKER}"
    StrCpy $0 "1"
    Return
  ${EndIf}

  Call un.lvisIsLegacyDefaultHome
FunctionEnd

Function un.lvisRemoveHomeEnvIfOwned
  ReadRegStr $0 HKCU "Environment" "LVIS_HOME"
  ${If} $0 == $LvisHomeSelected
    DeleteRegValue HKCU "Environment" "LVIS_HOME"
    System::Call 'Kernel32::SetEnvironmentVariableW(w "LVIS_HOME", p 0)'
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
FunctionEnd

!macro customUnInstall
  ${If} ${isUpdated}
    Goto lvis_skip_userdata
  ${EndIf}

  ${If} ${Silent}
  ${AndIfNot} ${isDeleteAppData}
    Goto lvis_skip_userdata
  ${EndIf}

  Call un.lvisReadInstalledHome
  Call un.lvisCanRemoveHome
  ${If} $0 != "1"
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION|MB_OK "LVIS data home was not removed because the saved path is not a dedicated LVIS data folder:$\n$\n$LvisHomeSelected"
    ${EndIf}
    Goto lvis_skip_userdata
  ${EndIf}

  ${If} ${Silent}
    Goto lvis_delete_userdata
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "LVIS user data will be removed too.$\n$\n[Yes]: permanently delete chats, settings, memories, plugin data, runtime data, and demo activation state.$\n[No]: preserve user data for a future reinstall.$\n$\nData home:$\n$LvisHomeSelected" \
    /SD IDNO IDNO lvis_skip_userdata

  lvis_delete_userdata:
  ClearErrors
  RMDir /r "$LvisHomeSelected"
  ${If} ${Errors}
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION|MB_OK "LVIS data home could not be fully removed, so LVIS_HOME was preserved:$\n$\n$LvisHomeSelected"
    ${EndIf}
    Goto lvis_skip_userdata
  ${EndIf}

  RMDir /r "$LOCALAPPDATA\LVIS"
  Call un.lvisRemoveHomeEnvIfOwned

  lvis_skip_userdata:
!macroend
!endif
