[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$statePath = Join-Path $projectRoot 'output/local-service/service.json'
$servicePort = 5173
# Import only read-only process inspection commands without propagating WhatIf
# into the module's own alias initialization.
& { $WhatIfPreference = $false; Import-Module CimCmdlets -ErrorAction Stop }

function Get-CesiumStopListeners {
  $lines = & (Join-Path $env:SystemRoot 'System32/netstat.exe') -ano -p tcp
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect listening ports with netstat.' }
  return @($lines | ForEach-Object {
    if ($_ -match '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$' -and [int]$Matches[2] -eq $servicePort) {
      [pscustomobject]@{ LocalAddress = $Matches[1]; OwningProcess = [int]$Matches[3] }
    }
  })
}

function Get-CesiumStopFullPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
    throw 'Service identity contains a missing or relative path. No process was stopped.'
  }
  return [IO.Path]::GetFullPath($Value)
}

# Parse the actual Windows process command line; do not match loose substrings.
if (-not ('CesiumStopCommandLine' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class CesiumStopCommandLine {
  [DllImport("shell32.dll", SetLastError = true)]
  private static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int count);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder buffer, uint length, uint flags);
  public static string RealPath(string path) {
    using (SafeFileHandle handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception();
      StringBuilder buffer = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
      if (length == 0 || length >= buffer.Capacity) throw new System.ComponentModel.Win32Exception();
      string value = buffer.ToString();
      if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + value.Substring(8);
      if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) return value.Substring(4);
      return value;
    }
  }
  public static string[] Parse(string commandLine) {
    int count;
    IntPtr pointer = CommandLineToArgvW(commandLine, out count);
    if (pointer == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      string[] values = new string[count];
      for (int i = 0; i < count; ++i) values[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size));
      return values;
    } finally { LocalFree(pointer); }
  }
}
"@
}

function Get-CesiumStopRealPath([string]$Value) {
  return [CesiumStopCommandLine]::RealPath((Get-CesiumStopFullPath $Value))
}

function Get-CesiumStopOption([string[]]$Arguments, [string]$Name) {
  $value = $null
  for ($index = 0; $index -lt $Arguments.Length; $index++) {
    if ($Arguments[$index] -eq $Name) {
      if ($index + 1 -ge $Arguments.Length) { throw "Missing value for $Name in the live command line." }
      $value = $Arguments[$index + 1]
    } elseif ($Arguments[$index].StartsWith($Name + '=')) {
      $value = $Arguments[$index].Substring($Name.Length + 1)
    }
  }
  return $value
}

function Get-CesiumStopIdentity([int]$ProcessId, [string]$StartedAt, [string]$EntryPath, [string]$NodePath, [string]$Kind) {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  $details = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  if ($null -eq $process -or $null -eq $details) { return $null }
  $expectedTicks = ([datetime]::Parse($StartedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).ToUniversalTime().Ticks
  if ($process.StartTime.ToUniversalTime().Ticks -ne $expectedTicks -or
      (Get-CesiumStopFullPath ([string]$details.ExecutablePath)) -ne $NodePath) {
    throw "PID $ProcessId has changed identity. No process was stopped."
  }
  $arguments = [CesiumStopCommandLine]::Parse([string]$details.CommandLine)
  if ($Kind -eq 'Vite' -and ($arguments.Length -lt 2 -or
      -not (Get-CesiumStopFullPath $arguments[1]).StartsWith($projectRoot + '\node_modules\', [StringComparison]::OrdinalIgnoreCase))) {
    throw "PID $ProcessId does not load a Vite entry inside this project's node_modules. No process was stopped."
  }
  if ($arguments.Length -lt 3 -or (Get-CesiumStopRealPath $arguments[1]) -ne $EntryPath -or
      $arguments -notcontains '--strictPort' -or
      (Get-CesiumStopOption $arguments '--port') -ne '5173' -or
      (Get-CesiumStopOption $arguments '--host') -ne '127.0.0.1') {
    throw "PID $ProcessId does not have the expected absolute $Kind entry, host, strictPort and port. No process was stopped."
  }
  if ($Kind -eq 'pnpm') {
    $expectedScript = if ($state.mode -eq 'Preview') { 'preview' } else { 'dev' }
    if ($arguments[2] -ne $expectedScript) { throw "PID $ProcessId has an unexpected pnpm script. No process was stopped." }
  } elseif (($state.mode -eq 'Preview' -and $arguments[2] -ne 'preview') -or
            ($state.mode -eq 'Development' -and $arguments -contains 'preview')) {
    throw "PID $ProcessId has an unexpected Vite mode. No process was stopped."
  }
  return [pscustomobject]@{ Process = $process; Details = $details; CommandLine = [string]$details.CommandLine }
}

$listeners = @(Get-CesiumStopListeners)
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
  if ($listeners.Count -eq 0) { Write-Host 'No Cesium service state or port 5173 listener was found. Nothing was stopped.'; return }
  throw 'Port 5173 is occupied, but the Cesium service state is missing. Inspect the process manually. Nothing was stopped.'
}
$state = Get-Content -Raw -LiteralPath $statePath -Encoding UTF8 | ConvertFrom-Json
if ((Get-CesiumStopFullPath ([string]$state.projectRoot)) -ne $projectRoot -or
    $state.hostName -ne '127.0.0.1' -or [int]$state.port -ne $servicePort -or
    $state.mode -notin @('Preview', 'Development') -or
    [int]$state.pid -le 0 -or [int]$state.launcherPid -le 0 -or
    [int]$state.pid -eq [int]$state.launcherPid) {
  throw 'Service state does not identify this project and its expected host/port. Nothing was stopped.'
}
$nodePath = Get-CesiumStopFullPath ([string]$state.nodePath)
$pnpmPath = Get-CesiumStopRealPath ([string]$state.pnpmEntry)
$vitePath = Get-CesiumStopRealPath (Join-Path $projectRoot 'node_modules/vite/bin/vite.js')
$realProjectRoot = Get-CesiumStopRealPath $projectRoot
if (-not $vitePath.StartsWith($realProjectRoot + '\node_modules\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The real Vite entry is outside this project node_modules. Nothing was stopped.'
}
$launcher = Get-CesiumStopIdentity ([int]$state.launcherPid) ([string]$state.launcherStartedAt) $pnpmPath $nodePath 'pnpm'
$service = Get-CesiumStopIdentity ([int]$state.pid) ([string]$state.startedAt) $vitePath $nodePath 'Vite'
if ($null -eq $launcher -and $null -eq $service -and $listeners.Count -eq 0) {
  Write-Host 'The recorded Cesium service is already stopped. No process was stopped; logs and state were preserved.'
  return
}
if ($null -eq $launcher -or $null -eq $service) {
  throw 'The recorded Cesium process pair is incomplete. Inspect the remaining process manually. Nothing was stopped.'
}
$owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -ne 1 -or [int]$owners[0] -ne [int]$state.pid) {
  throw 'Port 5173 is absent or is not owned solely by the recorded Cesium Vite process. Nothing was stopped.'
}
$ancestor = $service.Details
$hasParent = $false
for ($step = 0; $step -lt 8; $step++) {
  if ([int]$ancestor.ParentProcessId -eq [int]$state.launcherPid) { $hasParent = $true; break }
  if ([int]$ancestor.ParentProcessId -le 0) { break }
  $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ancestor.ParentProcessId)" -ErrorAction Stop
  if ($null -eq $ancestor) { break }
}
if (-not $hasParent) { throw 'Vite is not a descendant of the recorded pnpm process. Nothing was stopped.' }
Write-Host "Verified project: $projectRoot"
Write-Host "Verified Node: $nodePath"
Write-Host "Verified Vite PID: $($state.pid); pnpm PID: $($state.launcherPid); port: $servicePort"
Write-Host "Vite command: $($service.CommandLine)"
Write-Host "State and logs are retained: $statePath"
if ($PSCmdlet.ShouldProcess("$projectRoot Vite PID $($state.pid), pnpm PID $($state.launcherPid)", 'Stop the verified local Cesium service')) {
  # Recheck identities immediately before mutation. Use held process objects,
  # never broad taskkill/node matching and never stop an unverified process tree.
  $serviceNow = Get-CesiumStopIdentity ([int]$state.pid) ([string]$state.startedAt) $vitePath $nodePath 'Vite'
  $launcherNow = Get-CesiumStopIdentity ([int]$state.launcherPid) ([string]$state.launcherStartedAt) $pnpmPath $nodePath 'pnpm'
  if ($null -eq $serviceNow -or $null -eq $launcherNow) { throw 'Service identity changed before stop. Nothing was stopped.' }
  Stop-Process -InputObject $serviceNow.Process -ErrorAction Stop
  $remainingLauncher = Get-CesiumStopIdentity ([int]$state.launcherPid) ([string]$state.launcherStartedAt) $pnpmPath $nodePath 'pnpm'
  if ($null -ne $remainingLauncher) { Stop-Process -InputObject $remainingLauncher.Process -ErrorAction Stop }
  $deadline = (Get-Date).AddSeconds(5)
  while (@(Get-CesiumStopListeners).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (@(Get-CesiumStopListeners).Count -gt 0) { throw 'A listener remains on port 5173 after stopping the verified service. Inspect it manually; no additional process was stopped.' }
  Write-Host 'Cesium has stopped. Port 5173 is free. Project data, logs and service state were preserved.'
}