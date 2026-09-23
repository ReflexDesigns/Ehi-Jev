; ponytail: 0.2.2/0.2.3 installed models under _up_\ (wrong path). Drop the orphan copy.
!macro NSIS_HOOK_POSTINSTALL
  RMDir /r "$INSTDIR\_up_"
!macroend
