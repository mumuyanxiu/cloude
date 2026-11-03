[CmdletBinding()]
param(
    [string]$Repository = 'mumuyanxiu/cloude',
    [string]$InstallDirectory,
    [switch]$DownloadOnly,
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid GitHub repository.' }
if ($InstallDirectory -and ($InstallDirectory -match '["\r\n]' -or -not [IO.Path]::IsPathRooted($InstallDirectory))) {
    throw 'InstallDirectory must be an absolute path without quotes or line breaks.'
}
if (-not $DownloadOnly -and (Get-Process -Name 'Cloud Claude' -ErrorAction SilentlyContinue)) {
    throw 'Save your work and close Cloud Claude, then run this script again.'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'Cloud-Claude-Updater'; Accept = 'application/vnd.github+json' }
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $headers
$version = $release.tag_name -replace '^v', ''
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'The latest release must have a stable vX.Y.Z tag.' }
$installerName = "Cloud-Claude-Setup-$version.exe"
$installerAsset = @($release.assets | Where-Object { $_.name -eq $installerName })
$checksumAsset = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' })
if ($installerAsset.Count -ne 1 -or $checksumAsset.Count -ne 1) { throw 'The release is incomplete: installer or checksum manifest is missing.' }
$assetPrefix = "https://github.com/$Repository/releases/download/$($release.tag_name)/"
foreach ($asset in @($installerAsset[0], $checksumAsset[0])) {
    if (-not $asset.browser_download_url.StartsWith($assetPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected release download URL.' }
}
$cacheDirectory = Join-Path ([IO.Path]::GetTempPath()) ('cloud-claude-update-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $cacheDirectory | Out-Null
$installerPath = Join-Path $cacheDirectory $installerName
$partialPath = "$installerPath.partial"
$manifestPath = Join-Path $cacheDirectory 'SHA256SUMS.txt'
try {
    Invoke-WebRequest -UseBasicParsing -Uri $checksumAsset[0].browser_download_url -OutFile $manifestPath -Headers $headers
    $matchesForInstaller = @(Get-Content -LiteralPath $manifestPath | Where-Object { $_ -match ('^[a-fA-F0-9]{64}  ' + [regex]::Escape($installerName) + '$') })
    if ($matchesForInstaller.Count -ne 1) { throw 'Installer checksum is missing or ambiguous.' }
    $expectedHash = $matchesForInstaller[0].Substring(0, 64)
    Write-Host "Downloading Cloud Claude $version..."
    Invoke-WebRequest -UseBasicParsing -Uri $installerAsset[0].browser_download_url -OutFile $partialPath -Headers $headers
    if ((Get-Item -LiteralPath $partialPath).Length -ne $installerAsset[0].size) { throw 'Installer download is incomplete.' }
    $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
    $installerStream = [IO.File]::OpenRead($partialPath)
    try { $actualHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash($installerStream))).Replace('-', '') }
    finally { $installerStream.Dispose(); $hashAlgorithm.Dispose() }
    if ($actualHash -ne $expectedHash) { throw 'Installer checksum verification failed.' }
    Move-Item -LiteralPath $partialPath -Destination $installerPath
    if ($DownloadOnly) { Write-Output $installerPath; return }
    $installerArguments = @()
    if ($Silent) { $installerArguments += '/S' }
    # NSIS requires /D to be the final argument, without surrounding quotes.
    if ($InstallDirectory) { $installerArguments += "/D=$InstallDirectory" }
    $startOptions = @{ FilePath = $installerPath; Wait = $true; PassThru = $true }
    if ($Silent) { $startOptions.WindowStyle = 'Hidden' }
    if ($installerArguments.Count) { $startOptions.ArgumentList = $installerArguments }
    $process = Start-Process @startOptions
    if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)." }
    Write-Host "Cloud Claude $version installed."
} finally {
    if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath }
    # Retain the verified installer for an offline retry or DownloadOnly use.
}
