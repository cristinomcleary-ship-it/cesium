@echo off
setlocal
if "%~2"=="" exit /b 2

set "SKETCHUP=F:\2.Software\SKUP2021\SketchUp.exe"
set "RUBY_SCRIPT=%~dp0sketchup_export_glb.rb"
set "CESIUM_SKP_INPUT=%~f1"
set "CESIUM_SKP_OUTPUT=%~f2"
set "STATUS_FILE=%~f2.status"

if not exist "%SKETCHUP%" exit /b 3
if not exist "%RUBY_SCRIPT%" exit /b 4
if not exist "%CESIUM_SKP_INPUT%" exit /b 5
if exist "%CESIUM_SKP_OUTPUT%" del /q "%CESIUM_SKP_OUTPUT%"
if exist "%STATUS_FILE%" del /q "%STATUS_FILE%"

start "" /wait /b "%SKETCHUP%" "%CESIUM_SKP_INPUT%" -RubyStartup "%RUBY_SCRIPT%"

if not exist "%STATUS_FILE%" exit /b 6
for /f "usebackq delims=" %%S in ("%STATUS_FILE%") do set "CONVERSION_STATUS=%%S"
if /i not "%CONVERSION_STATUS%"=="ok" (
  type "%STATUS_FILE%" 1>&2
  exit /b 7
)
if not exist "%CESIUM_SKP_OUTPUT%" exit /b 8
del /q "%STATUS_FILE%"
exit /b 0
