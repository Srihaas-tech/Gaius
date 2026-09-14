[CmdletBinding()]
param(
    [string]$Repo = 'TypeThe0ry/Gaius',
    [string]$Tag = 'v0.1.0',
    [string]$ExpectedSourceHead,
    [string]$Destination = 'port/target/release-v0.1.0-fresh-download-current',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
$requiredAssets = @(
    'Gaius-1.21.11.html', 'Gaius-1.21.11.manifest.json',
    'Gaius-26.2.html', 'Gaius-26.2.manifest.json',
    'gaius-server-plugin-0.1.0.jar', 'RELEASE-NOTES.md',
    'release.manifest.json', 'SHA256SUMS'
)

function Fail([string]$Message) { throw "FRESH RELEASE VERIFY: $Message" }
function Get-Identity([string]$Path) {
    [pscustomobject]@{
        bytes = [long](Get-Item -LiteralPath $Path).Length
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
function Resolve-SafeDestination([string]$Path) {
    $candidate = if ([IO.Path]::IsPathRooted($Path)) { [IO.Path]::GetFullPath($Path) } else { [IO.Path]::GetFullPath((Join-Path $root $Path)) }
    $targetRoot = [IO.Path]::GetFullPath((Join-Path $root 'port/target')).TrimEnd('\', '/')
    if (-not $candidate.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        Fail "refusing to clear download destination outside port/target: $candidate"
    }
    $candidate
}
function Assert-ExactAssets([string]$Directory) {
    $actual = @(Get-ChildItem -LiteralPath $Directory -Force -File | ForEach-Object Name | Sort-Object)
    $expected = @($requiredAssets | Sort-Object)
    if (($actual -join "`n") -ne ($expected -join "`n")) {
        Fail "downloaded asset set is not exact-eight (actual=$($actual -join ', '); expected=$($expected -join ', '))"
    }
    if (@(Get-ChildItem -LiteralPath $Directory -Force -Directory).Count -ne 0) { Fail 'download contains unexpected directories' }
}
function Verify-DownloadedAssets([string]$Directory, [string]$SourceHead) {
    Assert-ExactAssets $Directory
    $sumPath = Join-Path $Directory 'SHA256SUMS'
    $sumBytes = [IO.File]::ReadAllBytes($sumPath)
    if (@($sumBytes | Where-Object { $_ -eq 13 }).Count -ne 0) { Fail 'SHA256SUMS contains CR bytes' }
    $records = @{}
    $lines = [Text.Encoding]::ASCII.GetString($sumBytes) -split "`n" | Where-Object { $_ -ne '' }
    foreach ($line in $lines) {
        if ($line -notmatch '^([0-9a-f]{64})  ([^/\\]+)$') { Fail "invalid SHA256SUMS record: $line" }
        $name = $Matches[2]
        if ($name -eq 'SHA256SUMS' -or $records.ContainsKey($name)) { Fail "invalid/duplicate SHA256SUMS name: $name" }
        $records[$name] = $Matches[1]
    }
    $expectedRecords = @($requiredAssets | Where-Object { $_ -ne 'SHA256SUMS' } | Sort-Object)
    if ((@($records.Keys | Sort-Object) -join "`n") -ne ($expectedRecords -join "`n")) {
        Fail 'SHA256SUMS does not name exactly the seven non-sum assets'
    }
    foreach ($name in $expectedRecords) {
        $actual = (Get-FileHash -LiteralPath (Join-Path $Directory $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $records[$name]) { Fail "checksum mismatch for $name" }
    }

    try { $manifest = Get-Content -LiteralPath (Join-Path $Directory 'release.manifest.json') -Raw | ConvertFrom-Json }
    catch { Fail "release.manifest.json is invalid JSON: $($_.Exception.Message)" }
    if ($manifest.schemaVersion -ne 4 -or $manifest.tag -ne 'v0.1.0' -or $manifest.version -ne '0.1.0') {
        Fail 'release.manifest.json identity/schema is invalid'
    }
    if ($manifest.sourceHead -ne $SourceHead) {
        Fail "sourceHead mismatch (download=$($manifest.sourceHead) expected=$SourceHead)"
    }
    if ($manifest.relay.target -ne 't40.sjcmc.cn:14803' -or $manifest.relay.url -ne 'wss://ellan.site/tunnel' -or
        $manifest.relay.strictTerrainGate -ne 'passed' -or $manifest.acceptanceEvidence.'26.2.multiplayer'.status -ne 'passed') {
        Fail 'release manifest strict RelayNode terrain gate is invalid'
    }
    foreach ($entry in @(
        @('client12111', 'Gaius-1.21.11.html', 'Gaius-1.21.11.manifest.json', '1.21.11'),
        @('client262', 'Gaius-26.2.html', 'Gaius-26.2.manifest.json', '26.2')
    )) {
        $declared = $manifest.artifacts.($entry[0])
        if ($declared.file -ne $entry[1]) { Fail "$($entry[0]) filename mismatch" }
        $identity = Get-Identity (Join-Path $Directory $entry[1])
        if ([long]$declared.identity.bytes -ne $identity.bytes -or [string]$declared.identity.sha256 -ne $identity.sha256) {
            Fail "$($entry[0]) HTML identity mismatch"
        }
        $portable = Get-Content -LiteralPath (Join-Path $Directory $entry[2]) -Raw | ConvertFrom-Json
        if ($portable.kind -ne 'gaius-portable-artifact' -or $portable.profile -ne $entry[3] -or $portable.artifact -ne 'Gaius.html') {
            Fail "$($entry[3]) portable manifest identity mismatch"
        }
    }
    [pscustomobject]@{
        schema = 'gaius.fresh-release-verification.v1'; pass = $true; repo = $Repo; tag = $Tag
        sourceHead = $SourceHead; directory = $Directory; assets = @($requiredAssets)
    }
}

if ($SelfTest) {
    $directory = Join-Path ([IO.Path]::GetTempPath()) ("gaius-fresh-release-fixture-" + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $directory | Out-Null
        $head = ('a' * 40)
        foreach ($name in $requiredAssets | Where-Object { $_ -notin @('release.manifest.json', 'SHA256SUMS') }) {
            [IO.File]::WriteAllText((Join-Path $directory $name), "fixture:$name`n", [Text.UTF8Encoding]::new($false))
        }
        foreach ($entry in @(@('1.21.11', 'Gaius-1.21.11.manifest.json'), @('26.2', 'Gaius-26.2.manifest.json'))) {
            $portableManifest = @{ kind = 'gaius-portable-artifact'; profile = $entry[0]; artifact = 'Gaius.html' } |
                ConvertTo-Json
            [IO.File]::WriteAllText(
                (Join-Path $directory $entry[1]),
                $portableManifest + "`n",
                [Text.UTF8Encoding]::new($false)
            )
        }
        $i12111 = Get-Identity (Join-Path $directory 'Gaius-1.21.11.html')
        $i262 = Get-Identity (Join-Path $directory 'Gaius-26.2.html')
        $fixtureManifest = [ordered]@{
            schemaVersion = 4; tag = 'v0.1.0'; version = '0.1.0'; sourceHead = $head
            artifacts = [ordered]@{
                client12111 = [ordered]@{ file = 'Gaius-1.21.11.html'; identity = $i12111 }
                client262 = [ordered]@{ file = 'Gaius-26.2.html'; identity = $i262 }
            }
            acceptanceEvidence = [ordered]@{ '26.2.multiplayer' = [ordered]@{ status = 'passed' } }
            relay = [ordered]@{ target = 't40.sjcmc.cn:14803'; url = 'wss://ellan.site/tunnel'; strictTerrainGate = 'passed' }
        }
        [IO.File]::WriteAllText((Join-Path $directory 'release.manifest.json'), (($fixtureManifest | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
        $hashLines = foreach ($file in Get-ChildItem -LiteralPath $directory -Force -File | Sort-Object Name) {
            "$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($file.Name)"
        }
        [IO.File]::WriteAllText((Join-Path $directory 'SHA256SUMS'), (($hashLines -join "`n") + "`n"), [Text.Encoding]::ASCII)
        $result = Verify-DownloadedAssets $directory $head
        $extra = Join-Path $directory 'unexpected.bin'; [IO.File]::WriteAllText($extra, 'x')
        $rejected = $false
        try { $null = Verify-DownloadedAssets $directory $head } catch { $rejected = $true }
        if (-not $rejected) { Fail 'self-test did not reject an extra asset' }
        Remove-Item -LiteralPath $extra
        Write-Output ($result | ConvertTo-Json -Depth 6)
        exit 0
    } finally { Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue }
}

if ([string]::IsNullOrWhiteSpace($ExpectedSourceHead)) { $ExpectedSourceHead = (git rev-parse --verify HEAD).Trim() }
if ($ExpectedSourceHead -notmatch '^[0-9a-f]{40}$') { Fail "invalid expected source HEAD: $ExpectedSourceHead" }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'GitHub CLI (gh) is required' }

$releaseJson = gh release view $Tag --repo $Repo --json tagName,assets
if ($LASTEXITCODE -ne 0) { Fail "release not found: $Repo $Tag" }
try { $release = $releaseJson | ConvertFrom-Json }
catch { Fail "gh release view returned invalid JSON: $($_.Exception.Message)" }
if ($release.tagName -ne $Tag) { Fail "release tag mismatch: $($release.tagName)" }
$remoteAssets = @($release.assets | ForEach-Object name | Sort-Object)
if (($remoteAssets -join "`n") -ne (@($requiredAssets | Sort-Object) -join "`n")) {
    Fail "remote release asset set is not exact-eight: $($remoteAssets -join ', ')"
}

$destinationPath = Resolve-SafeDestination $Destination
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
foreach ($entry in @(Get-ChildItem -LiteralPath $destinationPath -Force)) {
    Remove-Item -LiteralPath $entry.FullName -Recurse -Force
}
& gh release download $Tag --repo $Repo --dir $destinationPath --clobber
if ($LASTEXITCODE -ne 0) { Fail 'gh release download failed' }
$result = Verify-DownloadedAssets $destinationPath $ExpectedSourceHead
$reportPath = $destinationPath.TrimEnd('\', '/') + '.verification.json'
[IO.File]::WriteAllText($reportPath, (($result | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Host "Fresh-download verification PASS: $destinationPath" -ForegroundColor Green
Write-Host "  exactAssets=8 sourceHead=$ExpectedSourceHead"
Write-Host "  report=$reportPath"
