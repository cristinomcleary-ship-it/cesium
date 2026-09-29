@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "DJI_LAUNCHER_HOSTED=1"
if /i "%~1"=="--self-test" goto :self_test
"%ComSpec%" /d /k call "%~dp0DJI_Extractor_Launcher.cmd"
exit /b

:self_test
"%ComSpec%" /d /c call "%~dp0DJI_Extractor_Launcher.cmd" --self-test
exit /b %ERRORLEVEL%
