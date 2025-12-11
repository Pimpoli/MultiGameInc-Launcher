!macro customInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "¿Deseas crear un acceso directo en el escritorio?" IDYES create_shortcut IDNO done

  create_shortcut:
    ; Create shortcut using the exe itself as icon resource (index 0)
    CreateShortCut "$DESKTOP\\MultiGameInc-Launcher.lnk" "$INSTDIR\\MultiGameInc-Launcher.exe" "" "$INSTDIR\\MultiGameInc-Launcher.exe" 0
    ; Also create Start Menu shortcut (optional)
    CreateShortCut "$SMPROGRAMS\\MultiGameInc-Launcher.lnk" "$INSTDIR\\MultiGameInc-Launcher.exe" "" "$INSTDIR\\MultiGameInc-Launcher.exe" 0
    Goto done

  done:
!macroend

!macro customUnInstall
  Delete "$DESKTOP\\MultiGameInc-Launcher.lnk"
  Delete "$SMPROGRAMS\\MultiGameInc-Launcher.lnk"
!macroend
