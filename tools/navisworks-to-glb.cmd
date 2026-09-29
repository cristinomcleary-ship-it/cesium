@echo off
setlocal
if "%~2"=="" exit /b 2
set "PROJECT_ROOT=%~dp0.."
set "BRIDGE=%~dp0NavisworksBridge\bin\BridgeRunner.exe"
set "PLUGIN=%~dp0NavisworksBridge\bin\BridgePlugin.dll"
set "BLENDER=F:\2.Software\Blender Foundation\Blender 4.3\blender.exe"
set "FBX=%~dpn2.intermediate.fbx"

if not exist "%BRIDGE%" exit /b 3
if not exist "%PLUGIN%" exit /b 4
if not exist "%BLENDER%" exit /b 5

"%BRIDGE%" "%~1" "%FBX%" "%PLUGIN%"
if errorlevel 1 exit /b %errorlevel%
if not exist "%FBX%" exit /b 6

"%BLENDER%" --background --python "%~dp0blender_fbx_to_glb.py" -- "%FBX%" "%~2"
if errorlevel 1 exit /b %errorlevel%
if not exist "%~2" exit /b 7
exit /b 0
