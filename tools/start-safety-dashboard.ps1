param([ValidateRange(1024,65535)][int]$Port = 5173, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dashboardUrl = "http://127.0.0.1:$Port/?screen=safety"
function Test-DashboardService {
  try {
    $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/__library/records" -TimeoutSec 2
    $listing = $response.Content | ConvertFrom-Json
    return ($response.StatusCode -eq 200 -and $null -ne $listing.records)
  } catch { return $false }
}
if (-not (Test-DashboardService)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
  if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js is missing. Install Node.js 22 or newer first.' }
  $vitePath = Join-Path $projectRoot 'node_modules/vite/bin/vite.js'
  if (-not (Test-Path -LiteralPath $vitePath)) { throw 'Dependencies are missing. Run pnpm install --store-dir .pnpm-store in the project first.' }
  $logDirectory = Join-Path $projectRoot 'output/safety-dashboard'
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  $viteArguments = @(('"' + $vitePath + '"'), '--host', '127.0.0.1', '--port', [string]$Port, '--strictPort')
  $service = Start-Process -FilePath $nodePath -ArgumentList $viteArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'server.log') -RedirectStandardError (Join-Path $logDirectory 'server-error.log')
  $service.Id | Set-Content -LiteralPath (Join-Path $logDirectory 'server.pid') -Encoding ascii
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-DashboardService)) {
    $service.Refresh()
    if ($service.HasExited -or (Get-Date) -gt $deadline) { throw "Dashboard did not start. Inspect $logDirectory/server-error.log." }
    Start-Sleep -Milliseconds 300
  }
  Write-Host "Cesium service PID: $($service.Id)"
} else { Write-Host 'Reusing the running Cesium service.' }
Write-Host $dashboardUrl
if (-not $NoBrowser) { Start-Process $dashboardUrl }
