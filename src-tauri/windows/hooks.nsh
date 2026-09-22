; Always ask for an installer UI language, even when a previous choice is remembered.
!define MUI_LANGDLL_ALWAYSSHOW

; Clear Download Manager startup registration is installed for the current user only.
; The app still exposes the setting to disable it and removes the value on uninstall.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Clear Download Manager" '"$INSTDIR\cacatools-desktop.exe" --background'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Clear Download Manager"
!macroend
