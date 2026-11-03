$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspaceRoot
$packageInfo = Get-Content -Raw -LiteralPath (Join-Path $workspaceRoot 'package.json') | ConvertFrom-Json
$registrations = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq $packageInfo.build.productName }
foreach ($registration in $registrations) {
    $installedProgram = ($registration.DisplayIcon -replace ',\d+$', '').Trim('"')
    if ($installedProgram -and (Split-Path -Leaf $installedProgram) -eq 'Cloud Claude.exe' -and (Test-Path -LiteralPath $installedProgram -PathType Leaf)) {
        Start-Process -FilePath $installedProgram
        exit 0
    }
}
$releaseDirectory = Join-Path $workspaceRoot $packageInfo.build.directories.output.Replace('${version}', $packageInfo.version)
$unpacked = Join-Path $releaseDirectory 'win-unpacked\Cloud Claude.exe'
if (Test-Path -LiteralPath $unpacked -PathType Leaf) { Start-Process -FilePath $unpacked; exit 0 }
if (-not (Test-Path -LiteralPath 'node_modules\electron\dist\electron.exe')) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path -LiteralPath 'dist\index.html')) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$env:ELECTRON_RUN_AS_NODE = $null
Start-Process -FilePath (Join-Path $workspaceRoot 'node_modules\electron\dist\electron.exe') -ArgumentList '.' -WorkingDirectory $workspaceRoot
