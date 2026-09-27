; Extra steps for the uninstaller. electron-builder's own removes the program,
; its shortcuts and registry entries, and - with deleteAppDataOnUninstall -
; %APPDATA%\Took. Whatever the app keeps anywhere else is cleared here.
;
; None of it happens during an update: the old version is uninstalled with
; --updated first, and settings, Start with Windows and the updater's cache
; all have to survive that.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; These all live in the user's own folders, even for an install made for
    ; every user - the same switch electron-builder makes for app data.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    ; Start with Windows. Left behind, Windows would try to launch an exe that
    ; is no longer there on every boot.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Took"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Took"

    ; The updater's cache (named after the package: "<name>-updater"): this
    ; version's installer, kept to diff the next update against, and any update
    ; downloaded but never installed.
    RMDir /r "$LOCALAPPDATA\took-updater"

    ; A recording waiting in the editor, and those that versions before 0.1.2
    ; left loose in the temp folder.
    RMDir /r "$TEMP\Took"
    Delete "$TEMP\took_*.mp4"
    Delete "$TEMP\took_*.gif"
    Delete "$TEMP\took_*.webm"

    ; The default save folder - only if it is empty. Never the captures in it.
    RMDir "$PICTURES\Took"

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
