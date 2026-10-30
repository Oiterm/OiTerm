; OiTerm 설치/제거 추가 동작
; 제거할 때(업데이트가 아닐 때만): OiTerm이 등록했던 telnet:// vnc:// rdp:// 링크 연동을 원래대로 되돌림
; 세션·설정(%APPDATA%\OiTerm)과 로그는 지우지 않음
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 +2
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --unregister-links'
  ${endIf}
!macroend
