param([string]$DestinationDirectory)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$packageInfo = Get-Content -Raw -LiteralPath (Join-Path $workspaceRoot 'package.json') | ConvertFrom-Json
$releaseDirectory = Join-Path $workspaceRoot $packageInfo.build.directories.output.Replace('${version}', $packageInfo.version)
$programPath = Join-Path $releaseDirectory 'win-unpacked\Cloud Claude.exe'
if (-not (Test-Path -LiteralPath $programPath -PathType Leaf)) {
    throw 'Please build the Windows application first: npm run package'
}
if (-not $DestinationDirectory) {
    $DestinationDirectory = [Environment]::GetFolderPath('Desktop')
}
if (-not (Test-Path -LiteralPath $DestinationDirectory -PathType Container)) {
    throw 'The shortcut destination folder does not exist.'
}
# Compose the Chinese label without relying on Windows PowerShell 5.1 UTF-8 detection.
$label = 'Cloud Claude ' + [string][char]0x5DE5 + [string][char]0x4F5C + [string][char]0x53F0
$shortcutPath = Join-Path $DestinationDirectory ($label + '.lnk')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $programPath
$shortcut.WorkingDirectory = Split-Path -Parent $programPath
$shortcut.IconLocation = "$programPath,0"
$shortcut.Description = 'Cloud Claude workspace'
$shortcut.Save()
$verified = $shell.CreateShortcut($shortcutPath)
if ($verified.TargetPath -ne $programPath -or -not (Test-Path -LiteralPath $shortcutPath)) {
    throw 'Desktop shortcut verification failed.'
}
[pscustomobject]@{ Shortcut = $shortcutPath; Target = $verified.TargetPath; Icon = $verified.IconLocation } | ConvertTo-Json
