$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$systemNode = Get-Command node -ErrorAction SilentlyContinue
$systemPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$bundledPnpm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"

Set-Location $projectRoot

if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
    if ($systemPnpm) {
        & $systemPnpm.Source install
    } elseif (Test-Path $bundledPnpm) {
        & $bundledPnpm install
    } else {
        throw "未找到 pnpm。请先安装 Node.js 和 pnpm，然后执行 pnpm install。"
    }
}

if ($systemNode) {
    & $systemNode.Source ".\node_modules\vite\bin\vite.js" --host 0.0.0.0
} elseif (Test-Path $bundledNode) {
    & $bundledNode ".\node_modules\vite\bin\vite.js" --host 0.0.0.0
} else {
    throw "未找到 Node.js。请先安装 Node.js 20 或更高版本。"
}
