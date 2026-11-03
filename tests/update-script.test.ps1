$ErrorActionPreference = 'Stop'
$global:cloudClaudeFixtureInstallerBytes = [Text.Encoding]::UTF8.GetBytes('synthetic-installer-fixture')
$algorithm = [Security.Cryptography.SHA256]::Create()
$global:cloudClaudeFixtureExpectedHash = ([BitConverter]::ToString($algorithm.ComputeHash($global:cloudClaudeFixtureInstallerBytes))).Replace('-', '').ToLowerInvariant()
$algorithm.Dispose()
$global:cloudClaudeFixtureMode = 'ok'
$global:cloudClaudeFixtureInstalls = @()
$global:cloudClaudeFixtureDownloads = @()
$global:cloudClaudeFixtureAssetPrefix = 'https://github.com/example/workspace/releases/download/v1.2.3/'
function Invoke-RestMethod {
    param($Uri, $Headers)
    if ($Uri -ne 'https://api.github.com/repos/example/workspace/releases/latest') { throw 'Unexpected API URL' }
    $assets = @(
        [pscustomobject]@{ name = 'Cloud-Claude-Setup-1.2.3.exe'; size = $global:cloudClaudeFixtureInstallerBytes.Length; browser_download_url = $global:cloudClaudeFixtureAssetPrefix + 'Cloud-Claude-Setup-1.2.3.exe' },
        [pscustomobject]@{ name = 'SHA256SUMS.txt'; browser_download_url = $global:cloudClaudeFixtureAssetPrefix + 'SHA256SUMS.txt' }
    )
    if ($global:cloudClaudeFixtureMode -eq 'missing') { $assets = @($assets[0]) }
    if ($global:cloudClaudeFixtureMode -eq 'foreign') { $assets[0].browser_download_url = 'https://example.com/unexpected.exe' }
    [pscustomobject]@{ tag_name = 'v1.2.3'; assets = $assets }
}
function Invoke-WebRequest {
    param($Uri, $OutFile, $Headers, [switch]$UseBasicParsing)
    $global:cloudClaudeFixtureDownloads += $Uri
    if ($Uri.EndsWith('SHA256SUMS.txt')) {
        [IO.File]::WriteAllText($OutFile, "$global:cloudClaudeFixtureExpectedHash  Cloud-Claude-Setup-1.2.3.exe`n")
    } else {
        $bytes = $global:cloudClaudeFixtureInstallerBytes
        if ($global:cloudClaudeFixtureMode -eq 'corrupt') { $bytes = [Text.Encoding]::UTF8.GetBytes('synthetic-installer-fixturE') }
        [IO.File]::WriteAllBytes($OutFile, $bytes)
    }
}
function Get-Process {
    [CmdletBinding()] param($Name)
    if ($global:cloudClaudeFixtureMode -eq 'running') { [pscustomobject]@{ Id = 1 } }
}
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru, $WindowStyle)
    $global:cloudClaudeFixtureInstalls += [pscustomobject]@{ Path = $FilePath; Arguments = $ArgumentList; WindowStyle = $WindowStyle }
    [pscustomobject]@{ ExitCode = 0 }
}
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
$updateScript = Join-Path $PSScriptRoot '..\scripts\update-windows.ps1'
& $updateScript -Repository 'example/workspace' -InstallDirectory 'D:\Apps\Test Workspace' -Silent
Assert ($global:cloudClaudeFixtureInstalls.Count -eq 1) 'Verified installer must run exactly once.'
Assert ($global:cloudClaudeFixtureInstalls[0].Arguments[-1] -eq '/D=D:\Apps\Test Workspace') 'NSIS destination must be the final argument.'
Assert ($global:cloudClaudeFixtureInstalls[0].Arguments[0] -eq '/S') 'Silent installation argument missing.'
Assert ($global:cloudClaudeFixtureInstalls[0].WindowStyle -eq 'Hidden') 'Silent process must stay hidden.'
$downloadedPath = & $updateScript -Repository 'example/workspace' -DownloadOnly
Assert (Test-Path -LiteralPath $downloadedPath) 'DownloadOnly must return a verified file.'
Assert ($global:cloudClaudeFixtureInstalls.Count -eq 1) 'DownloadOnly must not launch an installer.'
foreach ($failure in @('missing', 'foreign', 'corrupt', 'running')) {
    $global:cloudClaudeFixtureMode = $failure
    $rejected = $false
    $expectedMessage = @{ missing = 'incomplete'; foreign = 'Unexpected release download URL'; corrupt = 'checksum verification failed'; running = 'close Cloud Claude' }[$failure]
    try { & $updateScript -Repository 'example/workspace' } catch { $rejected = $_.Exception.Message -match $expectedMessage }
    Assert $rejected "Unsafe update must be rejected: $failure"
    Assert ($global:cloudClaudeFixtureInstalls.Count -eq 1) "Installer unexpectedly ran: $failure"
}
Write-Output 'PASS online update script: verified install, destination, silent mode, download-only, incomplete release, foreign URL, corruption, running application'
