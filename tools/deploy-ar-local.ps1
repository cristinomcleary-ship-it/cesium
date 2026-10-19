[CmdletBinding()]
param(
  [string]$ProjectPath,
  [string]$Branch = 'codex/machinery-integration-20261013',
  [ValidatePattern('^$|^[0-9a-fA-F]{40}$')][string]$ExpectedCommit = '',
  [ValidateSet('Preview', 'Development')][string]$Mode = 'Preview',
  [switch]$CheckOnly,
  [switch]$SkipRestart,
  [switch]$InstallDependencies,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$requestedMode = $PSBoundParameters.ContainsKey('Mode')
$repository = 'cristinomcleary-ship-it/cesium'
$git = (Get-Command git.exe -ErrorAction Stop).Source
$originalLocation = Get-Location
$backupRoot = $null
$report = $null
$serviceWasStopped = $false

function Invoke-ProjectGit([string[]]$Arguments) {
  # Native Git writes normal progress to stderr. Decide success by its exit code.
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $lines = @(& $git -C $script:projectRoot @Arguments 2>&1); $resultCode = $LASTEXITCODE }
  finally { $ErrorActionPreference = $savedPreference }
  if ($resultCode -ne 0) { throw "git $($Arguments -join ' ') failed ($resultCode): $($lines -join [Environment]::NewLine)" }
  return ($lines -join [Environment]::NewLine).Trim()
}

function Find-ProjectRoot {
  $candidates = @()
  if ($ProjectPath) { $candidates += $ProjectPath }
  elseif ($env:CESIUM_PROJECT_DIR) { $candidates += $env:CESIUM_PROJECT_DIR }
  else { $candidates += $originalLocation.Path; $candidates += (Split-Path -Parent $PSScriptRoot) }
  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $found = & $git -C $candidate rev-parse --show-toplevel 2>$null; $foundCode = $LASTEXITCODE }
    finally { $ErrorActionPreference = $savedPreference }
    if ($foundCode -ne 0 -or -not $found) { continue }
    $candidateRoot = [IO.Path]::GetFullPath([string]$found)
    $packagePath = Join-Path $candidateRoot 'package.json'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { continue }
    $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($package.name -eq 'cesium-cad-photogrammetry-viewer') { return $candidateRoot }
  }
  throw 'Cannot identify the existing Cesium Git project. Pass -ProjectPath with its actual folder. No project was created.'
}

function Find-ProjectNode {
  $candidates = @()
  if ($env:CESIUM_NODE_EXE) { $candidates += $env:CESIUM_NODE_EXE }
  $candidates += @(Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  if ($env:USERPROFILE) { $candidates += Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $version = & $candidate --no-warnings --eval 'process.stdout.write(process.versions.node)'
    if ($LASTEXITCODE -eq 0 -and $version -match '^\d+\.\d+\.\d+$' -and [int]($version.Split('.')[0]) -ge 24) {
      return [IO.Path]::GetFullPath($candidate)
    }
  }
  throw 'Node.js 24+ is required. Install it or set CESIUM_NODE_EXE to the existing node.exe.'
}

function Write-DeployReport {
  if ($null -ne $backupRoot -and $null -ne $report) {
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backupRoot 'deployment.json') -Encoding UTF8
  }
}

function Backup-ProjectChanges {
  # Node preserves arbitrary UTF-8 Git filenames, NUL separators and binary diffs.
  # It copies only Git-visible work; project-data, credentials and node_modules stay local.
  $backupProgram = @'
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = process.argv[1], backup = process.argv[2];
const git = (...args) => cp.execFileSync('git', ['-C', root, ...args], {maxBuffer: 128 * 1024 * 1024});
git('diff', '--binary', '--no-ext-diff', '--output=' + path.join(backup, 'working-tree.patch'));
git('diff', '--cached', '--binary', '--no-ext-diff', '--output=' + path.join(backup, 'staged.patch'));
fs.writeFileSync(path.join(backup, 'status-porcelain.bin'), git('status', '--porcelain=v1', '-z'));
const names = new Set([
  ...git('diff', '--name-only', '-z').toString('utf8').split('\0'),
  ...git('diff', '--cached', '--name-only', '-z').toString('utf8').split('\0'),
  ...git('ls-files', '--others', '--exclude-standard', '-z').toString('utf8').split('\0'),
].filter(Boolean));
const files = [];
for (const name of names) {
  const source = path.resolve(root, name);
  if (!source.startsWith(root + path.sep)) throw new Error('Unsafe Git path: ' + name);
  if (!fs.existsSync(source)) { files.push({path: name, deleted: true}); continue; }
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Back up this changed symlink manually: ' + name);
  const target = path.resolve(backup, 'working-files', name);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.cpSync(source, target, {recursive: true, errorOnExist: true});
  files.push({path: name, deleted: false});
}
fs.writeFileSync(path.join(backup, 'working-files.json'), JSON.stringify(files, null, 2));
'@
  & $script:node --eval $backupProgram $script:projectRoot $backupRoot
  if ($LASTEXITCODE -ne 0) { throw 'Working-tree backup failed. No Git update or service restart was performed.' }
}

try {
  $projectRoot = Find-ProjectRoot
  Set-Location -LiteralPath $projectRoot
  $originUrl = Invoke-ProjectGit -Arguments @('remote', 'get-url', 'origin')
  $normalizedRemote = $originUrl.TrimEnd('/').Replace('git@github.com:', 'https://github.com/').Replace('ssh://git@github.com/', 'https://github.com/') -replace '\.git$', ''
  if ($normalizedRemote -ine ('https://github.com/' + $repository)) { throw "Origin is not $repository. Review this checkout before deployment: $originUrl" }
  & $git check-ref-format --branch $Branch *> $null
  if ($LASTEXITCODE -ne 0 -or $Branch.StartsWith('-')) { throw 'Invalid target branch.' }
  $currentBranch = Invoke-ProjectGit -Arguments @('branch', '--show-current')
  if ($currentBranch -ne $Branch) { throw "Current branch is '$currentBranch', target is '$Branch'. Let local Codex review branch history and local commits before switching. No branch was changed." }
  $beforeCommit = Invoke-ProjectGit -Arguments @('rev-parse', 'HEAD')
  $dirty = Invoke-ProjectGit -Arguments @('status', '--porcelain=v1', '--untracked-files=normal')
  Write-Host "Project: $projectRoot"
  Write-Host "Repository: $originUrl"
  Write-Host "Branch: $currentBranch; current commit: $beforeCommit"
  Write-Host "Working tree clean: $([string]::IsNullOrWhiteSpace($dirty))"
  $stopScript = Join-Path $projectRoot 'tools/stop-cesium.ps1'
  $startScript = Join-Path $projectRoot 'tools/start-cesium.ps1'
  $statePath = Join-Path $projectRoot 'output/local-service/service.json'
  $runningMode = $null
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $existingState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($existingState.mode -in @('Preview', 'Development')) {
      $runningMode = $existingState.mode
      if (-not $requestedMode) { $Mode = $runningMode }
    }
    if ($existingState.projectRoot -eq $projectRoot) {
      foreach ($key in @('CESIUM_DATA_DIR', 'CESIUM_MANAGEMENT_DATA_DIR', 'CESIUM_SAFETY_DATA_DIR')) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key, 'Process')) -and $existingState.dataDirectories.$key) {
          [Environment]::SetEnvironmentVariable($key, [string]$existingState.dataDirectories.$key, 'Process')
        }
      }
    }
  }
  if (-not $SkipRestart) {
    if (-not (Test-Path -LiteralPath $stopScript -PathType Leaf) -or -not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
      throw 'Verified service lifecycle scripts are missing. Local Codex must inspect the running service first; use -SkipRestart only for a reviewed build without restart.'
    }
    # This existing script verifies the live PID, start time, exact entry, project,
    # host, port and parent process. WhatIf never stops it during preflight.
    & $stopScript -WhatIf
  }
  if ($CheckOnly) {
    Write-Host (Invoke-ProjectGit -Arguments @('ls-remote', '--heads', 'origin', ('refs/heads/' + $Branch)))
    Write-Host 'Preflight finished. No source update, dependency install, build or service stop was performed.'
    return
  }
  $node = Find-ProjectNode
  $env:PATH = (Split-Path -Parent $node) + [IO.Path]::PathSeparator + $env:PATH
  $env:CESIUM_NODE_EXE = $node
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $backupRoot = Join-Path $projectRoot ('.local-backups/ar-local-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  New-Item -ItemType Directory -Path $backupRoot -ErrorAction Stop | Out-Null
  $report = [ordered]@{ projectRoot = $projectRoot; branch = $Branch; beforeCommit = $beforeCommit; targetCommit = $null; startedAt = (Get-Date).ToUniversalTime().ToString('o'); mode = $Mode; status = 'preparing'; restarted = $false; error = $null }
  Write-DeployReport
  Backup-ProjectChanges
  if (-not [string]::IsNullOrWhiteSpace($dirty)) {
    throw "Local changes were backed up to $backupRoot. Resolve them with local Codex before retrying. No stash, reset, checkout, clean, pull or service stop was performed."
  }
  Invoke-ProjectGit -Arguments @('fetch', '--no-tags', 'origin', $Branch) | Write-Host
  $fetchedCommit = Invoke-ProjectGit -Arguments @('rev-parse', 'FETCH_HEAD^{commit}')
  if ($ExpectedCommit -and $fetchedCommit -ine $ExpectedCommit) { throw "Remote HEAD $fetchedCommit differs from expected $ExpectedCommit. Review the new remote commits before deployment." }
  & $git merge-base --is-ancestor HEAD $fetchedCommit
  if ($LASTEXITCODE -ne 0) { throw 'This checkout has local commits or diverged history. Local Codex must review and integrate them; no forced update was attempted.' }
  # A running development server would consume source changes during the pull.
  if (-not $SkipRestart -and $runningMode -eq 'Development') {
    & $stopScript -Confirm:$false
    $serviceWasStopped = $true
  }
  if (-not [string]::IsNullOrWhiteSpace((Invoke-ProjectGit -Arguments @('status', '--porcelain=v1', '--untracked-files=normal')))) { throw 'Working tree changed after backup. Review those changes before continuing.' }
  if ($ExpectedCommit) {
    # Pin the reviewed commit; the second network request of git pull could race.
    Invoke-ProjectGit -Arguments @('merge', '--ff-only', $fetchedCommit) | Write-Host
  } else {
    Invoke-ProjectGit -Arguments @('pull', '--ff-only', '--no-rebase', 'origin', $Branch) | Write-Host
  }
  $targetCommit = Invoke-ProjectGit -Arguments @('rev-parse', 'HEAD')
  $report.targetCommit = $targetCommit
  $report.status = 'building'
  Write-DeployReport
  $dependencyChanges = Invoke-ProjectGit -Arguments @('diff', '--name-only', $beforeCommit, $targetCommit, '--', 'package.json', 'package-lock.json')
  if ($InstallDependencies -or $dependencyChanges -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/vite/bin/vite.js'))) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package-lock.json'))) { throw 'package-lock.json is missing; local Codex must choose the project package manager.' }
    if (-not $SkipRestart -and -not $serviceWasStopped) {
      & $stopScript -Confirm:$false
      $serviceWasStopped = $true
    }
    & $npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. The existing dist was not replaced.' }
  }
  $buildDirectory = Join-Path $backupRoot 'build-dist'
  # Vite builds into a separate directory, keeping the currently served dist whole.
  & $npm run build -- --outDir $buildDirectory --emptyOutDir
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $buildDirectory 'index.html') -PathType Leaf)) { throw 'Build failed. The previous dist was not replaced; inspect compiler output above.' }
  if (-not [string]::IsNullOrWhiteSpace((Invoke-ProjectGit -Arguments @('status', '--porcelain=v1', '--untracked-files=normal')))) { throw 'Working tree changed during update/build. Review it before replacing the served build.' }
  if (-not $SkipRestart -and -not $serviceWasStopped) {
    & $stopScript -Confirm:$false
    $serviceWasStopped = $true
  }
  $distPath = Join-Path $projectRoot 'dist'
  if (Test-Path -LiteralPath $distPath) { Move-Item -LiteralPath $distPath -Destination (Join-Path $backupRoot 'previous-dist') }
  try { Move-Item -LiteralPath $buildDirectory -Destination $distPath }
  catch {
    if (Test-Path -LiteralPath (Join-Path $backupRoot 'previous-dist')) { Move-Item -LiteralPath (Join-Path $backupRoot 'previous-dist') -Destination $distPath }
    throw
  }
  if (-not $SkipRestart) {
    & $startScript -Mode $Mode -NoBrowser
    $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:5173/' -TimeoutSec 10
    if ([int]$response.StatusCode -ne 200) { throw 'The restarted service homepage did not return HTTP 200.' }
    $report.restarted = $true
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5173/' }
  }
  $report.status = if ($SkipRestart) { 'built-restart-skipped' } else { 'ready-awaiting-browser-acceptance' }
  $report.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  Write-DeployReport
  Write-Host "Built commit: $targetCommit"
  Write-Host "Backup and deployment report: $backupRoot"
  if ($SkipRestart) { Write-Host 'Restart was skipped. Do not report this version as running until the local service is restarted and checked.' }
  else { Write-Host 'Service and API checks passed. Complete the AR playback and exit performance checks in CODEX_LOCAL_DEPLOY_AR.md.' }
} catch {
  if ($null -ne $report) { $report.status = 'failed'; $report.error = $_.Exception.Message; Write-DeployReport }
  Write-Error $_ -ErrorAction Continue
  if ($serviceWasStopped) { Write-Warning 'This project service was stopped. Review the error and backup before restarting; no unrelated Node process was stopped.' }
  exit 1
} finally {
  Set-Location -LiteralPath $originalLocation.Path
}
