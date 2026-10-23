@echo off
setlocal DisableDelayedExpansion
if "%~2"=="" exit /b 2
rem Compatibility entrypoint for existing model-converters.json installations.
rem The official standalone SDK is loaded in a Node worker. No desktop app opens.
node "%~dp0sketchup-headless.mjs" "%~f1" "%~f2"
exit /b %errorlevel%

