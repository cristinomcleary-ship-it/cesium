param([ValidateRange(1024,65535)][int]$Port = 5173, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dashboardUrl = "http://127.0.0.1:$Port/?screen=safety"
function Test-DashboardSessionResponse([int]$Status, [string]$ContentType, [string]$Content) {
  if ($ContentType -notmatch '^application/json(?:;|$)') { return $false }
  try { $session = $Content | ConvertFrom-Json } catch { return $false }
  if ($Status -eq 200) {
    return ($session.authMode -in @('local-owner', 'local-account') -and
      -not [string]::IsNullOrWhiteSpace([string]$session.userId) -and
      $session.roles -is [array] -and $session.permissions -is [array])
  }
  # A protected, initialized instance is ready even before this launcher has a browser session.
  return ($Status -eq 401 -and $session.code -in @('AUTH_REQUIRED', 'SESSION_EXPIRED') -and
    -not [string]::IsNullOrWhiteSpace([string]$session.error))
}
function Test-DashboardService {
  try {
    $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/__management/session" -TimeoutSec 2
    return (Test-DashboardSessionResponse ([int]$response.StatusCode) ([string]$response.Headers['Content-Type']) ([string]$response.Content))
  } catch {
    $response = $_.Exception.Response
    if ($null -eq $response) { return $false }
    $content = [string]$_.ErrorDetails.Message
    $contentType = [string]$response.Headers['Content-Type']
    # Windows PowerShell exposes a WebResponse stream; PowerShell 7 exposes HttpResponseMessage.
    if ([string]::IsNullOrWhiteSpace($content)) {
      try {
        if ($response.PSObject.Methods.Name -contains 'GetResponseStream') {
          $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
          try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } elseif ($null -ne $response.Content) {
          $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
      } catch { return $false }
    }
    if ([string]::IsNullOrWhiteSpace($contentType) -and $null -ne $response.Content) { $contentType = [string]$response.Content.Headers.ContentType }
    return (Test-DashboardSessionResponse ([int]$response.StatusCode) $contentType $content)
  }
}
function Find-DashboardNode {
  $nodeCandidates = @((Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }),
    (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')) |
    ForEach-Object { $_ } | Where-Object { $_ } | Select-Object -Unique
  $probe = "try { if (+process.versions.node.split('.')[0] < 24) process.exit(1); const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE readiness (id INTEGER)'); db.close(); process.stdout.write(process.versions.node); } catch { process.exit(1); }"
  foreach ($candidate in $nodeCandidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $nodeVersion = & $candidate --no-warnings --eval $probe 2>$null
      if ($LASTEXITCODE -eq 0 -and $nodeVersion -match '^\d+\.\d+\.\d+$') { return $candidate }
    } catch { continue }
  }
  throw 'A Node.js 24+ runtime with working node:sqlite is required. Install Node.js 24 and ensure node.exe is on PATH. The Codex bundled runtime is checked as a fallback.'
}
if (-not (Test-DashboardService)) {
  $nodePath = Find-DashboardNode
  Write-Host "Using Node.js: $nodePath"
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
