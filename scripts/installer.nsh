!ifndef BUILD_UNINSTALLER
  !ifdef allowToChangeInstallationDirectory
    !macro customPageAfterChangeDir
      !undef MUI_PAGE_CUSTOMFUNCTION_PRE
      !define MUI_PAGE_CUSTOMFUNCTION_PRE cloudeInstFilesPre

      Function cloudeInstFilesPre
        Push $0
        ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${If} $0 != ""
        ${AndIf} $INSTDIR == $0
          ClearErrors
          Pop $0
          Return
        ${EndIf}
        ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${If} $0 != ""
        ${AndIf} $INSTDIR == $0
          ClearErrors
          Pop $0
          Return
        ${EndIf}
        ClearErrors
        Pop $0
        # Keep electron-builder's directory handling for new or changed locations.
        Call instFilesPre
      FunctionEnd
    !macroend
  !endif
!endif
