@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title DJI Video Metadata Extractor

set "PYTHON_EXE=%DJI_EXTRACTOR_PYTHON%"
if not defined PYTHON_EXE set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
set "EXTRACTOR_SCRIPT=%~dp0dji_video_extractor.py"
set "LAUNCHER_LOG=%~dp0dji_extractor_launcher.log"
set "LOCAL_TCL_ROOT=%~dp0.venv\tcl_runtime"
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
>>"%LAUNCHER_LOG%" echo Tcl library: "%TCL_LIBRARY%"
>>"%LAUNCHER_LOG%" echo Tk library: "%TK_LIBRARY%"

echo DJI Video Metadata Extractor
echo Launcher log: "%LAUNCHER_LOG%"
echo.

if not exist "%EXTRACTOR_SCRIPT%" (
  set "EXIT_CODE=2"
  echo [ERROR] Missing extractor script:
  echo         "%EXTRACTOR_SCRIPT%"
  >>"%LAUNCHER_LOG%" echo [%date% %time%] [ERROR] Missing extractor script: "%EXTRACTOR_SCRIPT%"
  goto :finish
)

if not exist "%PYTHON_EXE%" (
  set "EXIT_CODE=2"
  echo [ERROR] Missing project Python environment:
  echo         "%PYTHON_EXE%"
  >>"%LAUNCHER_LOG%" echo [%date% %time%] [ERROR] Missing Python: "%PYTHON_EXE%"
  goto :finish
)

echo [1/3] Checking Python...
"%PYTHON_EXE%" --version >>"%LAUNCHER_LOG%" 2>&1
if errorlevel 1 (
  set "EXIT_CODE=3"
  echo [ERROR] The project Python executable could not start.
  >>"%LAUNCHER_LOG%" echo [%date% %time%] [ERROR] Python startup failed
  goto :finish
)

echo [2/3] Checking the Tk GUI runtime...
"%PYTHON_EXE%" -c "import tkinter as tk; root=tk.Tk(); root.withdraw(); root.update_idletasks(); root.destroy(); print('Tk GUI', tk.TkVersion, 'OK')" >>"%LAUNCHER_LOG%" 2>&1
if errorlevel 1 (
  set "EXIT_CODE=4"
  echo [ERROR] Tkinter/Tk is unavailable in the project Python environment.
  >>"%LAUNCHER_LOG%" echo [%date% %time%] [ERROR] Tkinter import failed
  goto :finish
)

echo [3/3] Checking extractor dependencies...
"%PYTHON_EXE%" -c "import dji_video_extractor as app; print('Extractor', app.APP_VERSION, 'OK')" >>"%LAUNCHER_LOG%" 2>&1
if errorlevel 1 (
  set "EXIT_CODE=5"
  echo [ERROR] The extractor or one of its dependencies could not be imported.
  >>"%LAUNCHER_LOG%" echo [%date% %time%] [ERROR] Extractor import failed
  goto :finish
)

if "%SELF_TEST%"=="1" (
  echo SELFTEST_OK
  >>"%LAUNCHER_LOG%" echo [%date% %time%] SELFTEST_OK
  exit /b 0
)

echo.
echo Opening the graphical extractor. Keep this diagnostic window open.
>>"%LAUNCHER_LOG%" echo [%date% %time%] Self-check passed; starting GUI
"%PYTHON_EXE%" "%EXTRACTOR_SCRIPT%" --gui >>"%LAUNCHER_LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo [ERROR] The extractor exited with code %EXIT_CODE%.
  echo See the launcher log above for the complete traceback.
  >>"%LAUNCHER_LOG%" echo [%date% %time%] [ERROR] GUI exited with code %EXIT_CODE%
) else (
  echo The graphical extractor was closed normally.
  >>"%LAUNCHER_LOG%" echo [%date% %time%] GUI closed normally
)

:finish
echo.
if defined DJI_LAUNCHER_HOSTED (
  echo This window is intentionally being kept open.
  echo Type exit and press Enter when you want to close it.
) else (
  echo Press any key to close this window.
  pause >nul
)
exit /b %EXIT_CODE%
