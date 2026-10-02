$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$pythonExe = Join-Path $projectRoot 'ar_v2/.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) { throw 'AR V2 Python environment is missing. Follow ar_v2/README.md to install it.' }
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$logRoot = Join-Path $projectRoot 'output/ar-v2/launcher'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
function Test-Endpoint([string]$url) {
    try { $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2; return $response.StatusCode -eq 200 } catch { return $false }
}
if (-not (Test-Endpoint 'http://127.0.0.1:5199/api/status')) {
    Start-Process -FilePath $pythonExe -ArgumentList @('-m','ar_v2','serve','--config','ar_v2.project.yaml') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'api.stdout.log') -RedirectStandardError (Join-Path $logRoot 'api.stderr.log')
}
if (-not (Test-Endpoint 'http://127.0.0.1:5173/ar-v2.html')) {
    Start-Process -FilePath $nodeExe -ArgumentList @('node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5173','--strictPort') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'vite.stdout.log') -RedirectStandardError (Join-Path $logRoot 'vite.stderr.log')
}
$ready = $false
for ($attempt=0; $attempt -lt 40; $attempt++) {
    if ((Test-Endpoint 'http://127.0.0.1:5199/api/status') -and (Test-Endpoint 'http://127.0.0.1:5173/ar-v2.html')) { $ready=$true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw ('AR V2 did not start; see ' + $logRoot) }
Start-Process 'http://127.0.0.1:5173/ar-v2.html'
Write-Host 'AR V2 is running at http://127.0.0.1:5173/ar-v2.html'
