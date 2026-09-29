@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title DJI Video SRT Detector and Exporter

set "PYTHON_EXE=%DJI_EXTRACTOR_PYTHON%"
if not defined PYTHON_EXE set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
set "EXTRACTOR_SCRIPT=%~dp0dji_srt_extractor.py"
set "LAUNCHER_LOG=%~dp0dji_srt_extractor_launcher.log"
set "LOCAL_TCL_ROOT=%~dp0.venv\tcl_runtime"
set "FFMPEG_EXE=%~dp0tools\FFmpeg\bin\ffmpeg.exe"
set "FFPROBE_EXE=%~dp0tools\FFmpeg\bin\ffprobe.exe"
set "EXIT_CODE=0"
set "SELF_TEST=0"
if /i "%~1"=="--self-test" set "SELF_TEST=1"

if exist "%LOCAL_TCL_ROOT%\tcl8.6\init.tcl" set "TCL_LIBRARY=%LOCAL_TCL_ROOT%\tcl8.6"
if exist "%LOCAL_TCL_ROOT%\tk8.6\tk.tcl" set "TK_LIBRARY=%LOCAL_TCL_ROOT%\tk8.6"

>>"%LAUNCHER_LOG%" echo.
>>"%LAUNCHER_LOG%" echo ============================================================
>>"%LAUNCHER_LOG%" echo [%date% %time%] Launcher started
>>"%LAUNCHER_LOG%" echo Launcher: "%~f0"
>>"%LAUNCHER_LOG%" echo Working directory: "%CD%"

echo DJI Video SRT Detector and Exporter
echo Launcher log: "%LAUNCHER_LOG%"
echo.

if not exist "%EXTRACTOR_SCRIPT%" (
  set "EXIT_CODE=2"
  echo [ERROR] Missing SRT extractor script:
  echo         "%EXTRACTOR_SCRIPT%"
  >>"%LAUNCHER_LOG%" echo [%date% %time%] [ERROR] Missing script: "%EXTRACTOR_SCRIPT%"
  goto :finish
)

if not exist "%PYTHON_EXE%" (
  set "EXIT_CODE=2"
  echo [ERROR] Missing project Python environment:
  echo         "%PYTHON_EXE%"
  >>"%LAUNCHER_LOG%" echo [%date% %time%] [ERROR] Missing Python: "%PYTHON_EXE%"
  goto :finish
)

if not exist "%FFMPEG_EXE%" (
  set "EXIT_CODE=2"
  echo [ERROR] Missing bundled ffmpeg.exe:
  echo         "%FFMPEG_EXE%"
  >>"%LAUNCHER_LOG%" echo [%date% %time%] [ERROR] Missing FFmpeg: "%FFMPEG_EXE%"
  goto :finish
)

if not exist "%FFPROBE_EXE%" (
  set "EXIT_CODE=2"
  echo [ERROR] Missing bundled ffprobe.exe:
  echo         "%FFPROBE_EXE%"
  >>"%LAUNCHER_LOG%" echo [%date% %time%] [ERROR] Missing FFprobe: "%FFPROBE_EXE%"
  goto :finish
)

echo [1/4] Checking Python...
"%PYTHON_EXE%" --version >>"%LAUNCHER_LOG%" 2>&1
if errorlevel 1 (
  set "EXIT_CODE=3"
  echo [ERROR] Python could not start.
  goto :finish
)

echo [2/4] Checking Tk GUI...
"%PYTHON_EXE%" -c "import tkinter as tk; root=tk.Tk(); root.withdraw(); root.update_idletasks(); root.destroy(); print('Tk GUI', tk.TkVersion, 'OK')" >>"%LAUNCHER_LOG%" 2>&1
if errorlevel 1 (
  set "EXIT_CODE=4"
  echo [ERROR] Tkinter/Tk is unavailable.
  goto :finish
)

echo [3/4] Checking bundled FFmpeg...
"%FFPROBE_EXE%" -v error -version >>"%LAUNCHER_LOG%" 2>&1
if errorlevel 1 (
  set "EXIT_CODE=5"
  echo [ERROR] Bundled ffprobe could not start.
  goto :finish
)
"%FFMPEG_EXE%" -hide_banner -version >>"%LAUNCHER_LOG%" 2>&1
if errorlevel 1 (
  set "EXIT_CODE=5"
  echo [ERROR] Bundled ffmpeg could not start.
  goto :finish
)

echo [4/4] Checking SRT extractor...
"%PYTHON_EXE%" -c "import dji_srt_extractor as app; print('DJI SRT Extractor', app.APP_VERSION, 'OK')" >>"%LAUNCHER_LOG%" 2>&1
if errorlevel 1 (
  set "EXIT_CODE=6"
  echo [ERROR] The SRT extractor could not be imported.
  goto :finish
)

if "%SELF_TEST%"=="1" (
  echo SELFTEST_OK
  >>"%LAUNCHER_LOG%" echo [%date% %time%] SELFTEST_OK
  exit /b 0
)

echo.
echo Opening the graphical SRT detector. Keep this diagnostic window open.
>>"%LAUNCHER_LOG%" echo [%date% %time%] Self-check passed; starting GUI
"%PYTHON_EXE%" "%EXTRACTOR_SCRIPT%" --gui >>"%LAUNCHER_LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [ERROR] The SRT extractor exited with code %EXIT_CODE%.
  echo See the launcher log for details.
) else (
  echo The graphical SRT detector was closed normally.
)

:finish
echo.
if defined DJI_SRT_LAUNCHER_HOSTED (
  echo This window is intentionally being kept open.
  echo Type exit and press Enter when you want to close it.
) else (
  echo Press any key to close this window.
  pause >nul
)
exit /b %EXIT_CODE%
