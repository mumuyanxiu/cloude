$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspaceRoot
$packageInfo = Get-Content -Raw -LiteralPath (Join-Path $workspaceRoot 'package.json') | ConvertFrom-Json
# The existing appId derives this stable NSIS key across the Cloude rename.
$registrationKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\a96f4e33-a367-5749-a236-fb5eb8c4a0c7'
$registrations = Get-ItemProperty -LiteralPath ("HKCU:\$registrationKey"), ("HKLM:\$registrationKey") -ErrorAction SilentlyContinue
$programNames = @('Cloude.exe', 'Cloud Claude.exe')
foreach ($registration in $registrations) {
    $installedProgram = ($registration.DisplayIcon -replace ',\d+$', '').Trim('"')
    if ($installedProgram -and ($programNames -contains (Split-Path -Leaf $installedProgram)) -and (Test-Path -LiteralPath $installedProgram -PathType Leaf)) {
        Start-Process -FilePath $installedProgram
        exit 0
    }
}
$releaseDirectory = Join-Path $workspaceRoot $packageInfo.build.directories.output.Replace('${version}', $packageInfo.version)
$unpacked = Join-Path $releaseDirectory ('win-unpacked\' + $packageInfo.build.productName + '.exe')
if (Test-Path -LiteralPath $unpacked -PathType Leaf) { Start-Process -FilePath $unpacked; exit 0 }
if (-not (Test-Path -LiteralPath 'node_modules\electron\dist\electron.exe')) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path -LiteralPath 'dist\index.html') -or -not (Test-Path -LiteralPath 'runtime\paseo\desktop-dist\main.js')) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$env:ELECTRON_RUN_AS_NODE = $null
Start-Process -FilePath (Join-Path $workspaceRoot 'node_modules\electron\dist\electron.exe') -ArgumentList '.' -WorkingDirectory $workspaceRoot
