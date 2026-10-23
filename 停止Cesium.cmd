@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-cesium.ps1" %*
set "CESIUM_STOP_EXIT=%ERRORLEVEL%"
if not "%CESIUM_STOP_EXIT%"=="0" (
  echo [ERROR] Cesium was not safely stopped. Review the identity check above.
  if "%~1"=="" pause
)
exit /b %CESIUM_STOP_EXIT%