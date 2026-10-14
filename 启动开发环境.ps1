param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
# The shared launcher validates Node.js 24 / SQLite, installs only with the frozen
# lockfile when dependencies are absent, and keeps development on strict port 5173.
& (Join-Path $PSScriptRoot 'tools/start-cesium.ps1') -Mode Development -NoBrowser:$NoBrowser
