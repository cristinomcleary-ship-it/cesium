[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()
$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot 'service.json'
$serverPath = Join-Path $PSScriptRoot 'server.mjs'
$nodePath = 'F:\Node.js\node.exe'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$serviceUrl = 'http://127.0.0.1:5289/'
$mutex = New-Object Threading.Mutex($false, 'Local\CesiumDesignedSurfacesDesktop5289')
$locked = $false
try {
  try { $locked = $mutex.WaitOne(50000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'The launcher is busy. Try again shortly.' }
  if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No current service state. No process was stopped.'; return }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
  if ($null -eq $process) { Write-Host 'The recorded service is already stopped.'; return }
  $startedAt = [datetime]$state.startedAt
  $details = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)"
  $commandPattern = '^"?' + [regex]::Escape($nodePath) + '"?\s+"' + [regex]::Escape($serverPath) + '"\s+--variant\s+candidate\s*$'
  if ($process.StartTime.ToUniversalTime().Ticks -ne $startedAt.ToUniversalTime().Ticks -or
      $null -eq $details -or $details.ExecutablePath -ne $nodePath -or
      $details.CommandLine -notmatch $commandPattern -or $state.server -ne $serverPath) {
    throw 'Recorded PID does not match the current service. No process was stopped.'
  }
  $identity = Invoke-RestMethod ($serviceUrl + '__acceptance/identity') -TimeoutSec 3
  if ($identity.pid -ne $state.pid -or $identity.source -ne $sourceRoot -or
      $identity.sourceCommit -ne 'c697c0d0443af779329275a898383f68c4ab96a8' -or
      $identity.build -ne (Join-Path $sourceRoot 'dist') -or
      $identity.dataRoot -ne (Join-Path $PSScriptRoot 'workspace\project-data') -or
      $identity.variant -ne 'candidate') { throw 'Live service identity mismatch. No process was stopped.' }
  if ($PSCmdlet.ShouldProcess("Temporary Facilities 1.0 PID $($state.pid), $serviceUrl", 'Stop verified local service')) {
    $process.Refresh()
    if ($process.StartTime.ToUniversalTime().Ticks -ne $startedAt.ToUniversalTime().Ticks) { throw 'Process identity changed.' }
    Stop-Process -InputObject $process -Force -Confirm:$false
    if (-not $process.WaitForExit(10000)) { throw 'The verified service did not exit.' }
    Copy-Item -LiteralPath $statePath -Destination (Join-Path $PSScriptRoot 'last-stopped-service.json') -Force
    Remove-Item -LiteralPath $statePath -Force
    Write-Host 'Temporary Facilities 1.0 stopped. Project data is retained.'
  }
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}