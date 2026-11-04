$ErrorActionPreference = 'Stop'
$global:cloudeFixtureInstallerBytes = [Text.Encoding]::UTF8.GetBytes('synthetic-installer-fixture')
$algorithm = [Security.Cryptography.SHA256]::Create()
$global:cloudeFixtureExpectedHash = ([BitConverter]::ToString($algorithm.ComputeHash($global:cloudeFixtureInstallerBytes))).Replace('-', '').ToLowerInvariant()
$algorithm.Dispose()
$global:cloudeFixtureMode = 'ok'
$global:cloudeFixtureInstalls = @()
$global:cloudeFixtureDownloads = @()
$global:cloudeFixtureProcessQueries = @()
$global:cloudeFixtureInstallerNames = @('Cloud-Claude-Setup-1.2.3.exe', 'Cloude-Setup-1.2.3.exe')
$global:cloudeFixtureAssetPrefix = 'https://github.com/example/workspace/releases/download/v1.2.3/'
function Invoke-RestMethod {
    param($Uri, $Headers)
    if ($Uri -ne 'https://api.github.com/repos/example/workspace/releases/latest') { throw 'Unexpected API URL' }
    if ($Headers['User-Agent'] -ne 'Cloude-Updater') { throw 'Unexpected updater user agent' }
    $assets = @($global:cloudeFixtureInstallerNames | ForEach-Object {
        [pscustomobject]@{ name = $_; size = $global:cloudeFixtureInstallerBytes.Length; browser_download_url = $global:cloudeFixtureAssetPrefix + $_ }
    })
    $assets += [pscustomobject]@{ name = 'SHA256SUMS.txt'; browser_download_url = $global:cloudeFixtureAssetPrefix + 'SHA256SUMS.txt' }
    if ($global:cloudeFixtureMode -eq 'missing') { $assets = @($assets | Where-Object { $_.name -ne 'SHA256SUMS.txt' }) }
    if ($global:cloudeFixtureMode -eq 'duplicate') { $assets += $assets[0] }
    if ($global:cloudeFixtureMode -eq 'foreign') { $assets[0].browser_download_url = 'https://example.com/unexpected.exe' }
    if ($global:cloudeFixtureMode -eq 'foreign-manifest') { $assets[-1].browser_download_url = 'https://example.com/SHA256SUMS.txt' }
    [pscustomobject]@{ tag_name = 'v1.2.3'; assets = $assets }
}
function Invoke-WebRequest {
    param($Uri, $OutFile, $Headers, [switch]$UseBasicParsing)
    $global:cloudeFixtureDownloads += $Uri
    if ($Uri.EndsWith('SHA256SUMS.txt')) {
        $lines = @($global:cloudeFixtureInstallerNames | ForEach-Object { "$global:cloudeFixtureExpectedHash  $_" })
        if ($global:cloudeFixtureMode -eq 'missing-checksum') { $lines = @() }
        if ($global:cloudeFixtureMode -eq 'duplicate-checksum') { $lines += $lines[0] }
        [IO.File]::WriteAllText($OutFile, ($lines -join "`n") + "`n")
    } else {
        $bytes = $global:cloudeFixtureInstallerBytes
        if ($global:cloudeFixtureMode -eq 'corrupt') { $bytes = [Text.Encoding]::UTF8.GetBytes('synthetic-installer-fixturE') }
        if ($global:cloudeFixtureMode -eq 'short') { $bytes = [Text.Encoding]::UTF8.GetBytes('incomplete') }
        [IO.File]::WriteAllBytes($OutFile, $bytes)
    }
}
function Get-Process {
    [CmdletBinding()] param([string[]]$Name)
    $global:cloudeFixtureProcessQueries += $Name
    $runningName = @{ 'running-cloude' = 'Cloude'; 'running-legacy' = 'Cloud Claude' }[$global:cloudeFixtureMode]
    if ($runningName -and $Name -contains $runningName) { [pscustomobject]@{ Id = 1; Name = $runningName } }
}
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru, $WindowStyle)
    $global:cloudeFixtureInstalls += [pscustomobject]@{ Path = $FilePath; Arguments = $ArgumentList; WindowStyle = $WindowStyle; Wait = $Wait; PassThru = $PassThru }
    [pscustomobject]@{ ExitCode = 0 }
}
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
$updateScript = Join-Path $PSScriptRoot '..\scripts\update-windows.ps1'
& $updateScript -Repository 'example/workspace' -InstallDirectory 'D:\Apps\Test Workspace' -Silent
Assert ($global:cloudeFixtureInstalls.Count -eq 1) 'Verified installer must run exactly once.'
$installation = $global:cloudeFixtureInstalls[0]
Assert ((Split-Path -Leaf $installation.Path) -eq 'Cloude-Setup-1.2.3.exe') 'Cloude installer must take priority when both names exist.'
Assert ($installation.Arguments[-1] -eq '/D=D:\Apps\Test Workspace') 'NSIS destination must be the final argument.'
Assert ($installation.Arguments[0] -eq '/S') 'Silent installation argument missing.'
Assert ($installation.WindowStyle -eq 'Hidden') 'Silent process must stay hidden.'
Assert ($installation.Wait -and $installation.PassThru) 'Installer exit status must be awaited.'
Assert ($global:cloudeFixtureDownloads[-1].EndsWith('/Cloude-Setup-1.2.3.exe')) 'Download must use the preferred Cloude release asset.'
Assert ((Split-Path -Leaf (Split-Path -Parent $installation.Path)) -like 'cloude-update-*') 'Update cache must use the Cloude prefix.'
Assert ($global:cloudeFixtureProcessQueries -contains 'Cloude') 'Cloude processes must be checked.'
Assert ($global:cloudeFixtureProcessQueries -contains 'Cloud Claude') 'Legacy Cloud Claude processes must be checked.'
foreach ($installerName in @('Cloude-Setup-1.2.3.exe', 'Cloud-Claude-Setup-1.2.3.exe')) {
    $global:cloudeFixtureInstallerNames = @($installerName)
    $downloadedPath = & $updateScript -Repository 'example/workspace' -DownloadOnly
    Assert (Test-Path -LiteralPath $downloadedPath) 'DownloadOnly must return a verified file.'
    Assert ((Split-Path -Leaf $downloadedPath) -eq $installerName) 'DownloadOnly must support current and legacy installer names.'
    Assert ($global:cloudeFixtureInstalls.Count -eq 1) 'DownloadOnly must not launch an installer.'
}
$global:cloudeFixtureInstallerNames = @('Cloude-Setup-1.2.3.exe')
$expectedFailures = [ordered]@{
    missing = 'incomplete'
    duplicate = 'incomplete'
    foreign = 'Unexpected release download URL'
    'foreign-manifest' = 'Unexpected release download URL'
    corrupt = 'checksum verification failed'
    short = 'download is incomplete'
    'missing-checksum' = 'checksum is missing or ambiguous'
    'duplicate-checksum' = 'checksum is missing or ambiguous'
    'running-cloude' = 'close Cloude'
    'running-legacy' = 'close Cloude'
}
foreach ($failure in $expectedFailures.Keys) {
    $global:cloudeFixtureMode = $failure
    $rejected = $false
    try { & $updateScript -Repository 'example/workspace' } catch { $rejected = $_.Exception.Message -match $expectedFailures[$failure] }
    Assert $rejected "Unsafe update must be rejected: $failure"
    Assert ($global:cloudeFixtureInstalls.Count -eq 1) "Installer unexpectedly ran: $failure"
}
foreach ($runningMode in @('running-cloude', 'running-legacy')) {
    $global:cloudeFixtureMode = $runningMode
    $downloadedPath = & $updateScript -Repository 'example/workspace' -DownloadOnly
    Assert (Test-Path -LiteralPath $downloadedPath) 'A running app must still allow DownloadOnly.'
    Assert ($global:cloudeFixtureInstalls.Count -eq 1) 'DownloadOnly must never install while an app is running.'
}
$global:cloudeFixtureMode = 'ok'
$invalidParameters = @(
    @{ Repository = 'invalid/repository/path' },
    @{ InstallDirectory = 'relative\directory' },
    @{ InstallDirectory = 'D:\Apps\"Quoted"' },
    @{ InstallDirectory = "D:\Apps\Bad`nDirectory" }
)
foreach ($parameters in $invalidParameters) {
    $downloadsBefore = $global:cloudeFixtureDownloads.Count
    $rejected = $false
    try { & $updateScript @parameters } catch { $rejected = $_.Exception.Message -match 'Invalid GitHub repository|InstallDirectory must be' }
    Assert $rejected 'Invalid parameters must be rejected.'
    Assert ($global:cloudeFixtureDownloads.Count -eq $downloadsBefore) 'Invalid parameters must fail before downloading.'
    Assert ($global:cloudeFixtureInstalls.Count -eq 1) 'Invalid parameters must not launch an installer.'
}
Write-Output 'PASS online update script: Cloude priority, legacy fallback, both process names, verified install, destination, silent mode, download-only, release assets, URLs, size, checksums and parameters'
