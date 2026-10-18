@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
cd /d "%~dp0"
echo [1/4] Checking Node.js 24+ and pnpm...
node -e "if(Number(process.versions.node.split('.')[0]) < 24)process.exit(1)"
if errorlevel 1 goto :failed
call pnpm --version
if errorlevel 1 goto :failed
echo [2/4] Stopping this project's Cesium service...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-cesium.ps1"
if errorlevel 1 goto :failed
echo [3/4] Installing locked dependencies...
call pnpm install --frozen-lockfile
if errorlevel 1 goto :failed
echo [4/4] Building Cesium...
call pnpm build
if errorlevel 1 goto :failed
echo.
echo Update build completed. Start Cesium using your usual launcher.
echo SKP imports require the standalone SketchUp SDK. See the included guide.
pause
exit /b 0
:failed
echo.
echo Update stopped. Review the error above. Do not start an old build as the new version.
pause
exit /b 1
