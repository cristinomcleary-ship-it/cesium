@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
set "NODE_EXE="

if exist "%BUNDLED_NODE%" set "NODE_EXE=%BUNDLED_NODE%"
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"

if not defined NODE_EXE (
  echo.
  echo [ERROR] Node.js was not found.
  echo Install Node.js 20 or newer, then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist ".\node_modules\vite\bin\vite.js" (
  echo.
  echo [ERROR] Project dependencies are missing.
  echo Run pnpm install in this folder first.
  echo.
  pause
  exit /b 1
)

echo Starting Cesium at http://localhost:5173/ ...
start "Cesium Server - keep running" /min "%NODE_EXE%" ".\node_modules\vite\bin\vite.js" --host 127.0.0.1 --port 5173

powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(20); do { try { $r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:5173/' -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0} } catch {}; Start-Sleep -Milliseconds 300 } while((Get-Date)-lt $deadline); exit 1"
if errorlevel 1 (
  echo [ERROR] Cesium did not start. Check the minimized server window.
  pause
  exit /b 1
)

start "" "http://localhost:5173/"
echo Cesium is running. Keep the minimized server window open while using it.
timeout /t 3 /nobreak >nul
endlocal
