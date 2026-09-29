$ErrorActionPreference = "Stop"
$navisworks = "F:\2.Software\navisworks\Navisworks Manage 2026"
$compiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$output = Join-Path $PSScriptRoot "bin"
New-Item -ItemType Directory -Force -Path $output | Out-Null

& $compiler /nologo /target:library /platform:x64 "/out:$output\BridgePlugin.dll" "/reference:$navisworks\Autodesk.Navisworks.Api.dll" "/reference:$navisworks\Autodesk.Navisworks.ComApi.dll" "/reference:$navisworks\Autodesk.Navisworks.Interop.ComApi.dll" "$PSScriptRoot\BridgePlugin.cs"
if ($LASTEXITCODE -ne 0) { throw "BridgePlugin compilation failed." }

& $compiler /nologo /target:exe /platform:x64 "/out:$output\BridgeRunner.exe" "/reference:$navisworks\Autodesk.Navisworks.Api.dll" "/reference:$navisworks\Autodesk.Navisworks.Automation.dll" "$PSScriptRoot\BridgeRunner.cs"
if ($LASTEXITCODE -ne 0) { throw "BridgeRunner compilation failed." }

Copy-Item -LiteralPath "$navisworks\Autodesk.Navisworks.Api.dll" -Destination $output -Force
Copy-Item -LiteralPath "$navisworks\Autodesk.Navisworks.Automation.dll" -Destination $output -Force
Copy-Item -LiteralPath "$navisworks\Autodesk.Navisworks.ComApi.dll" -Destination $output -Force
Copy-Item -LiteralPath "$navisworks\Autodesk.Navisworks.Interop.ComApi.dll" -Destination $output -Force
