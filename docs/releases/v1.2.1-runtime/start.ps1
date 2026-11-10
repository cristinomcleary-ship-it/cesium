param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$nodePath = 'F:\Node.js\node.exe'
$serverPath = Join-Path $PSScriptRoot 'server.mjs'
$runRoot = $PSScriptRoot
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$buildRoot = Join-Path $sourceRoot 'dist'
$dataRoot = Join-Path $runRoot 'workspace\project-data'
$expectedCommit = 'c697c0d0443af779329275a898383f68c4ab96a8'
$expectedIndex = 'e566fdc4414e978097420db4926eade52de75ee7e8ca52b489efdf8fc8353ffd'
$serviceUrl = 'http://127.0.0.1:5289/'
$statePath = Join-Path $PSScriptRoot 'service.json'

function Get-Listeners {
  $lines = & (Join-Path $env:SystemRoot 'System32\netstat.exe') -ano
  if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect local ports.' }
  return @($lines | ForEach-Object {
    if ($_ -match '^\s*TCP\s+(\S+):5289\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      [pscustomobject]@{ Address = $Matches[1]; ProcessId = [int]$Matches[2] }
    }
  })
}

function Get-VerifiedIdentity {
  $listeners = @(Get-Listeners)
  if ($listeners.Count -ne 1 -or $listeners[0].Address -ne '127.0.0.1') { return $null }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0].ProcessId)"
  if ($null -eq $owner -or $owner.ExecutablePath -ne $nodePath -or
      $owner.CommandLine -notlike ('*"' + $serverPath + '" --variant candidate*')) { return $null }
  try {
    $identity = Invoke-RestMethod ($serviceUrl + '__acceptance/identity') -TimeoutSec 3
    if ($identity.acceptanceOnly -ne $true -or $identity.variant -ne 'candidate' -or
        $identity.pid -ne $owner.ProcessId -or $identity.source -ne $sourceRoot -or
        $identity.sourceCommit -ne $expectedCommit -or $identity.build -ne $buildRoot -or
        $identity.indexSha256 -ne $expectedIndex -or $identity.dataRoot -ne $dataRoot) { return $null }
    return $identity
  } catch { return $null }
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

function Assert-ApiReady {
  if (-not (Test-CesiumReady)) { throw 'Candidate APIs are not ready. Inspect the local logs.' }
}

# Serialize repeated desktop clicks, including the first cold start.
$startMutex = New-Object Threading.Mutex($false, 'Local\CesiumDesignedSurfacesDesktop5289')
$locked = $false
try {
  try { $locked = $startMutex.WaitOne(50000) }
  catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another candidate launcher is still starting. Try again shortly.' }
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Required local Node.js is missing.' }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $indexHash = [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes((Join-Path $buildRoot 'index.html')))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  if ($indexHash -ne $expectedIndex) {
    throw 'Candidate build identity changed. The shortcut was not redirected to another version.'
  }
  $gitPath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe'
  if (-not (Test-Path -LiteralPath $gitPath -PathType Leaf)) { throw "Required local Git is missing: $gitPath" }
  $actualCommit = & $gitPath -C $sourceRoot rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $expectedCommit) { throw 'Candidate source identity changed.' }
  $version = & $nodePath --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.close();if(+process.versions.node.split('.')[0]<24)process.exit(1);console.log(process.versions.node)"
  if ($LASTEXITCODE -ne 0) { throw 'Node.js 24+ with node:sqlite is required.' }

  $listeners = @(Get-Listeners)
  $identity = Get-VerifiedIdentity
  if ($listeners.Count -gt 0 -and $null -eq $identity) {
    throw 'Port 5289 is occupied by a different or unready service. No process was stopped.'
  }
  $reused = $null -ne $identity
  if (-not $reused) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdoutLog = Join-Path $PSScriptRoot "server-$stamp.log"
    $stderrLog = Join-Path $PSScriptRoot "server-$stamp-error.log"
    $service = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $serverPath + '"'), '--variant', 'candidate') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    $deadline = (Get-Date).AddSeconds(45)
    do {
      $service.Refresh()
      if ($service.HasExited) { throw "Candidate exited with code $($service.ExitCode). See $stderrLog" }
      $identity = Get-VerifiedIdentity
      if ($null -ne $identity) { break }
      if ((Get-Date) -gt $deadline) { throw "Candidate did not become ready. See $stdoutLog and $stderrLog" }
      Start-Sleep -Milliseconds 300
    } while ($true)
  }
  Assert-ApiReady
  $liveProcess = Get-Process -Id ([int]$identity.pid)
  [ordered]@{
    pid = $identity.pid; startedAt = $liveProcess.StartTime.ToUniversalTime().ToString('o')
    sourceCommit = $identity.sourceCommit; build = $identity.build; dataRoot = $identity.dataRoot
    url = $serviceUrl; server = $serverPath; lastVerifiedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
  Write-Host "Temporary Facilities 1.0 PREVIEW ready: $serviceUrl"
  Write-Host "PID: $($identity.pid); reused: $reused; Node: $version"
  Write-Host 'This version saves to its independent data copy and browser origin.'
  if (-not $NoBrowser) { Start-Process $serviceUrl }
} finally {
  if ($locked) { $startMutex.ReleaseMutex() }
  $startMutex.Dispose()
}
