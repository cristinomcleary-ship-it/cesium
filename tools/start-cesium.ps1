param(
  [ValidateSet('Preview', 'Development')][string]$Mode = 'Preview',
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$serviceHost = '127.0.0.1'
$servicePort = 5173
$serviceUrl = 'http://127.0.0.1:5173/'
$logDirectory = Join-Path $projectRoot 'output/local-service'
$statePath = Join-Path $logDirectory 'service.json'
$pidPath = Join-Path $logDirectory 'server.pid'
$vitePath = Join-Path $projectRoot 'node_modules/vite/bin/vite.js'

function Find-CesiumNode {
  $candidates = @()
  if ($env:CESIUM_NODE_EXE) { $candidates += $env:CESIUM_NODE_EXE }
  $candidates += @(Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  $candidates += Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
  $probe = "try { if (+process.versions.node.split('.')[0] < 24) process.exit(1); const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE readiness (id INTEGER)'); db.close(); process.stdout.write(process.versions.node); } catch { process.exit(1); }"
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $version = & $candidate --no-warnings --eval $probe 2>$null
      if ($LASTEXITCODE -eq 0 -and $version -match '^\d+\.\d+\.\d+$') {
        return @{ Path = [IO.Path]::GetFullPath($candidate); Version = [string]$version }
      }
    } catch { continue }
  }
  throw 'Node.js 24+ with working node:sqlite is required. Install Node.js 24+ on PATH or set CESIUM_NODE_EXE to its node.exe.'
}

function Find-CesiumPnpmEntry {
  # Avoid wrappers that force another Node; run the existing pnpm CLI with the
  # verified Node. Do not download or upgrade the package manager.
  $candidates = @()
  if ($env:CESIUM_PNPM_JS) { $candidates += $env:CESIUM_PNPM_JS }
  foreach ($command in @(Get-Command pnpm.cmd -All -ErrorAction SilentlyContinue)) {
    $base = Split-Path -Parent $command.Source
    $candidates += Join-Path $base 'node_modules/pnpm/bin/pnpm.cjs'
    $candidates += Join-Path $base 'node_modules/pnpm/bin/pnpm.mjs'
    $candidates += Join-Path $base '../../node/node_modules/pnpm/bin/pnpm.mjs'
    $candidates += Join-Path $base '../../node/node_modules/pnpm/bin/pnpm.cjs'
  }
  $candidates += Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs'
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
  }
  throw 'The pnpm CLI entry was not found. Install pnpm or set CESIUM_PNPM_JS to its pnpm.cjs/pnpm.mjs entry.'
}

function Get-CesiumJson([string]$Path) {
  $status = 0
  $content = ''
  $contentType = ''
  try {
    $response = Invoke-WebRequest -UseBasicParsing ($serviceUrl.TrimEnd('/') + $Path) -TimeoutSec 2
    $status = [int]$response.StatusCode
    $content = [string]$response.Content
    $contentType = [string]$response.Headers['Content-Type']
  } catch {
    $response = $_.Exception.Response
    if ($null -eq $response) { return $null }
    $status = [int]$response.StatusCode
    $contentType = [string]$response.Headers['Content-Type']
    $content = [string]$_.ErrorDetails.Message
    if ([string]::IsNullOrWhiteSpace($content)) {
      try {
        if ($response.PSObject.Methods.Name -contains 'GetResponseStream') {
          $reader = New-Object IO.StreamReader($response.GetResponseStream())
          try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } elseif ($null -ne $response.Content) {
          $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
      } catch { return $null }
    }
    if ([string]::IsNullOrWhiteSpace($contentType) -and $null -ne $response.Content) {
      $contentType = [string]$response.Content.Headers.ContentType
    }
  }
  if ($contentType -notmatch '^application/json(?:;|$)') { return $null }
  try { return @{ Status = $status; Body = ($content | ConvertFrom-Json) } } catch { return $null }
}

function Test-CesiumAuthChallenge($Response) {
  return ($null -ne $Response -and $Response.Status -eq 401 -and
    $Response.Body.code -in @('AUTH_REQUIRED', 'SESSION_EXPIRED') -and
    -not [string]::IsNullOrWhiteSpace([string]$Response.Body.error))
}

function Test-CesiumReady {
  $session = Get-CesiumJson '/__management/session'
  if ($null -eq $session) { return $false }
  $sessionReady = $session.Status -eq 200 -and
    $session.Body.authMode -in @('local-owner', 'local-account') -and
    -not [string]::IsNullOrWhiteSpace([string]$session.Body.userId) -and
    $session.Body.roles -is [array] -and $session.Body.permissions -is [array]
  if (-not $sessionReady -and -not (Test-CesiumAuthChallenge $session)) { return $false }
  $library = Get-CesiumJson '/__library/records'
  if ($null -eq $library) { return $false }
  if ($library.Status -eq 200) {
    return ($library.Body.records -is [array] -and $library.Body.problems -is [array])
  }
  return (Test-CesiumAuthChallenge $library)
}

function Get-CesiumListeners {
  # netstat avoids a slow CIM network-provider scan on some Windows hosts.
  # Parse TCP listeners on every address family, including wildcard bindings.
  $lines = & (Join-Path $env:SystemRoot 'System32/netstat.exe') -ano
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect listening ports with netstat.' }
  return @($lines | ForEach-Object {
    if ($_ -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$' -and [int]$Matches[2] -eq $servicePort) {
      [pscustomobject]@{ LocalAddress = $Matches[1]; LocalPort = [int]$Matches[2]; OwningProcess = [int]$Matches[3] }
    }
  })
}

function Get-CesiumChild($LauncherId, $Listeners, $NodePath) {
  $owners = @($Listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($owners.Count -ne 1) { return $null }
  $child = Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])" -ErrorAction Stop
  if ($null -eq $child -or $child.ExecutablePath -ne $NodePath) { return $null }
  $command = ([string]$child.CommandLine).Replace('/', '\')
  if ($command -notmatch [regex]::Escape($projectRoot + '\node_modules\') -or
      $command -notmatch 'vite\\bin\\vite\.js' -or
      $command -notmatch '--strictPort' -or
      $command -notmatch '--port"?\s+"?5173"?(?:\s|$)') { return $null }
  $ancestor = $child
  for ($step = 0; $step -lt 8; $step++) {
    if ([int]$ancestor.ParentProcessId -eq [int]$LauncherId) { return $child }
    if ([int]$ancestor.ParentProcessId -le 0) { break }
    $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ancestor.ParentProcessId)" -ErrorAction Stop
    if ($null -eq $ancestor) { break }
  }
  return $null
}

function Test-CesiumOwner($State, $Listeners, $Node, $DataDirectories) {
  if ($null -eq $State -or $State.projectRoot -ne $projectRoot -or
      $State.mode -ne $Mode -or $State.hostName -ne $serviceHost -or
      $State.port -ne $servicePort -or $State.nodePath -ne $Node.Path) { return $false }
  foreach ($key in $DataDirectories.Keys) {
    if ($State.dataDirectories.$key -ne $DataDirectories[$key]) { return $false }
  }
  $launcher = Get-Process -Id ([int]$State.launcherPid) -ErrorAction SilentlyContinue
  $details = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$State.launcherPid)" -ErrorAction Stop
  if ($null -eq $launcher -or $null -eq $details -or
      $launcher.StartTime.ToUniversalTime().Ticks -ne ([datetime]$State.launcherStartedAt).ToUniversalTime().Ticks -or
      $details.ExecutablePath -ne $Node.Path -or
      $details.CommandLine -notlike ('*"' + $State.pnpmEntry + '"*')) { return $false }
  $child = Get-CesiumChild $State.launcherPid $Listeners $Node.Path
  if ($null -eq $child -or [int]$child.ProcessId -ne [int]$State.pid) { return $false }
  $service = Get-Process -Id ([int]$State.pid) -ErrorAction SilentlyContinue
  # The recorded parent was created with the project working directory; its live
  # descendant must load the project's absolute Vite entry and match start time.
  return ($null -ne $service -and $service.StartTime.ToUniversalTime().Ticks -eq ([datetime]$State.startedAt).ToUniversalTime().Ticks)
}

Push-Location -LiteralPath $projectRoot
try {
  $node = Find-CesiumNode
  $env:PATH = (Split-Path -Parent $node.Path) + [IO.Path]::PathSeparator + $env:PATH
  $dataDirectories = [ordered]@{}
  foreach ($key in @('CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR')) {
    $value = [Environment]::GetEnvironmentVariable($key, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) {
      if ($key -eq 'CESIUM_MANAGEMENT_DATA_DIR') { $value = $dataDirectories['CESIUM_DATA_DIR'] }
      else { $value = Join-Path $projectRoot 'project-data' }
    }
    if (-not [IO.Path]::IsPathRooted($value)) { $value = Join-Path $projectRoot $value }
    $value = [IO.Path]::GetFullPath($value)
    [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    $dataDirectories[$key] = $value
  }
  Write-Host "Project: $projectRoot"
  Write-Host "Node.js $($node.Version), node:sqlite verified: $($node.Path)"
  foreach ($key in $dataDirectories.Keys) { Write-Host "$($key): $($dataDirectories[$key])" }
  $listeners = @(Get-CesiumListeners)
  $state = $null
  if (Test-Path -LiteralPath $statePath) {
    try { $state = Get-Content -Raw -LiteralPath $statePath -Encoding UTF8 | ConvertFrom-Json } catch { $state = $null }
  }
  if ($listeners.Count -gt 0) {
    if (-not (Test-CesiumOwner $state $listeners $node $dataDirectories)) {
      $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
      throw "Port 5173 is occupied (PID: $owners). This launcher cannot verify the requested project/mode/data directories. Inspect those processes before stopping or reusing them. No other port was selected."
    }
    if (-not (Test-CesiumReady)) { throw "Known service PID $($state.pid) is not API-ready. Inspect $logDirectory. It was not replaced or stopped." }
    Write-Host "Reusing verified $Mode service. PID: $($state.pid); pnpm PID: $($state.launcherPid)"
    Write-Host "Logs: $($state.stdoutLog), $($state.stderrLog)"
  } else {
    $pnpmEntry = Find-CesiumPnpmEntry
    if (-not (Test-Path -LiteralPath $vitePath -PathType Leaf)) {
      Write-Host "Installing dependencies: pnpm install --frozen-lockfile ($pnpmEntry)"
      & $node.Path $pnpmEntry install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { throw 'pnpm install --frozen-lockfile failed. The service was not started.' }
    }
    if ($Mode -eq 'Preview' -and -not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist/index.html') -PathType Leaf)) {
      throw 'The production build is missing. Use Node.js 24+ to run pnpm build in this project, then rerun this launcher.'
    }
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdoutLog = Join-Path $logDirectory "server-$stamp.log"
    $stderrLog = Join-Path $logDirectory "server-$stamp-error.log"
    $scriptName = if ($Mode -eq 'Preview') { 'preview' } else { 'dev' }
    $arguments = @(('"' + $pnpmEntry + '"'), $scriptName, '--host', $serviceHost, '--port', [string]$servicePort, '--strictPort')
    Write-Host "Starting: pnpm $scriptName --host 127.0.0.1 --port 5173 --strictPort"
    $launcher = Start-Process -FilePath $node.Path -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    $state = [ordered]@{
      launcherPid = $launcher.Id; launcherStartedAt = $launcher.StartTime.ToUniversalTime().ToString('o')
      pid = 0; startedAt = $null; pnpmEntry = $pnpmEntry
      projectRoot = $projectRoot; mode = $Mode; hostName = $serviceHost; port = $servicePort
      nodePath = $node.Path; nodeVersion = $node.Version; dataDirectories = $dataDirectories
      stdoutLog = $stdoutLog; stderrLog = $stderrLog; arguments = $arguments
    }
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
    $deadline = (Get-Date).AddSeconds(45)
    while ($true) {
      $launcher.Refresh()
      if ($launcher.HasExited) { throw "pnpm exited with code $($launcher.ExitCode). Inspect $stderrLog. No other port was selected." }
      $listeners = @(Get-CesiumListeners)
      $child = Get-CesiumChild $launcher.Id $listeners $node.Path
      if ($null -ne $child) {
        $service = Get-Process -Id ([int]$child.ProcessId) -ErrorAction Stop
        $state.pid = $service.Id
        $state.startedAt = $service.StartTime.ToUniversalTime().ToString('o')
        if (Test-CesiumReady) { break }
      }
      if ((Get-Date) -gt $deadline) { throw "Cesium did not become API-ready within 45 seconds. pnpm PID: $($launcher.Id). Inspect $stderrLog and $stdoutLog. The process was left available for diagnosis." }
      Start-Sleep -Milliseconds 300
    }
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
    $state.pid | Set-Content -LiteralPath $pidPath -Encoding ascii
    Write-Host "Started $Mode service. PID: $($state.pid); pnpm PID: $($state.launcherPid)"
    Write-Host "Logs: $stdoutLog, $stderrLog"
  }
  Write-Host 'API checks passed: /__management/session and /__library/records'
  Write-Host "URL: $serviceUrl"
  Write-Host "Process record: $statePath"
  if (-not $NoBrowser) { Start-Process $serviceUrl }
} finally {
  Pop-Location
}
