@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-cesium.ps1" -Mode Preview %*
set "CESIUM_START_EXIT=%ERRORLEVEL%"
if not "%CESIUM_START_EXIT%"=="0" (
  echo [ERROR] Cesium did not start. See the error and log paths above.
  if "%~1"=="" pause
)
exit /b %CESIUM_START_EXIT%
