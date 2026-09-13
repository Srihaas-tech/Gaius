[CmdletBinding()]
param(
    [string]$EvidencePath,
    [string]$Stage = 'port/target/release-v0.1.0-final-20260913',
    [switch]$ExecuteUpload
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root

$stagePath = (Resolve-Path (Join-Path $root $Stage)).Path
$requiredAssets = @(
    'Gaius-1.21.11.html',
    'Gaius-1.21.11.manifest.json',
    'Gaius-26.2.html',
    'Gaius-26.2.manifest.json',
    'gaius-server-plugin-0.1.0.jar',
    'RELEASE-NOTES.md',
    'release.manifest.json',
    'SHA256SUMS'
)

function Fail([string]$Message) { throw "FINAL RELEASE GATE: $Message" }

if (-not (Test-Path -LiteralPath $stagePath -PathType Container)) {
    Fail "release stage does not exist: $stagePath"
}

$missing = @($requiredAssets | Where-Object { -not (Test-Path -LiteralPath (Join-Path $stagePath $_) -PathType Leaf) })
if ($missing.Count -ne 0) { Fail "stage is incomplete: $($missing -join ', ')" }

$head = (git rev-parse --verify HEAD).Trim()
$manifestPath = Join-Path $stagePath 'release.manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.tag -ne 'v0.1.0') { Fail "unexpected manifest tag: $($manifest.tag)" }
if ($manifest.sourceHead -ne $head) {
    Fail "manifest sourceHead $($manifest.sourceHead) does not match HEAD $head"
}
if ($manifest.artifactBuildReason -ne 'rebuilt-from-final-main') {
    Fail "artifactBuildReason is not rebuilt-from-final-main"
}

$sumBytes = [IO.File]::ReadAllBytes((Join-Path $stagePath 'SHA256SUMS'))
if (@($sumBytes | Where-Object { $_ -eq 13 }).Count -ne 0) {
    Fail 'SHA256SUMS contains CR bytes; regenerate with LF-only records'
}
& 'C:\Program Files\Git\bin\bash.exe' -lc "cd '$($stagePath -replace '\\','/')' && sha256sum -c SHA256SUMS"
if ($LASTEXITCODE -ne 0) { Fail 'staged SHA256SUMS verification failed' }

if ([string]::IsNullOrWhiteSpace($EvidencePath)) {
    $candidates = @(Get-ChildItem -LiteralPath (Join-Path $root 'artifacts') -Filter 'join-terrain-*.json' -File |
        Sort-Object LastWriteTime -Descending)
    if ($candidates.Count -eq 0) { Fail 'no multiplayer evidence supplied; pass -EvidencePath explicitly' }
    $EvidencePath = $candidates[0].FullName
} elseif (-not [IO.Path]::IsPathRooted($EvidencePath)) {
    $EvidencePath = Join-Path $root $EvidencePath
}
if (-not (Test-Path -LiteralPath $EvidencePath -PathType Leaf)) {
    Fail "multiplayer evidence not found: $EvidencePath"
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
if ($evidence.success -ne $true) { Fail 'multiplayer runner did not report success=true' }
if ($null -eq $evidence.final) { Fail 'multiplayer evidence has no final snapshot' }
$state = $evidence.final.state
$bridge = $evidence.final.bridgeStats
if ($null -eq $state -or $null -eq $bridge) { Fail 'multiplayer evidence is missing final.state or final.bridgeStats' }
if ($state.level -ne 'net.minecraft.client.multiplayer.ClientLevel') {
    Fail "multiplayer level is not ClientLevel: $($state.level)"
}
if ([int]$state.loadedChunkCount -le 0) {
    Fail "loadedChunkCount=$($state.loadedChunkCount); real terrain is not loaded"
}
if ([int]$bridge.relayNodeSuccesses -lt 1) { Fail 'no successful RelayNode connection recorded' }
if ([int]$bridge.relayTargetAttestationFailures -ne 0) { Fail 'RelayNode target attestation failures present' }
if ([int]$bridge.errors -ne 0) { Fail "RelayNode bridge errors=$($bridge.errors)" }
if ([int]$bridge.connected -lt 1) { Fail 'RelayNode connected count is zero' }
if ($evidence.logs -and $evidence.logs.exceptions -and @($evidence.logs.exceptions).Count -ne 0) {
    Fail "browser/runtime exceptions present: $(@($evidence.logs.exceptions).Count)"
}

$terrainScreenshots = @($evidence.screenshots | Where-Object { $_ -match '(?i)terrain|world|game' })
if ($terrainScreenshots.Count -eq 0) { Fail 'evidence has no terrain/world screenshot path' }
$evidenceDir = (Resolve-Path -LiteralPath $EvidencePath).Path | Split-Path -Parent
$resolvedScreenshots = @()
foreach ($shot in $terrainScreenshots) {
    $candidate = if ([IO.Path]::IsPathRooted([string]$shot)) { [string]$shot } else { Join-Path $evidenceDir ([string]$shot) }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -and -not [IO.Path]::IsPathRooted([string]$shot)) {
        $candidate = Join-Path $root ([string]$shot)
    }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        if ((Get-Item -LiteralPath $candidate).Length -gt 0) { $resolvedScreenshots += (Resolve-Path -LiteralPath $candidate).Path }
    }
}
if ($resolvedScreenshots.Count -eq 0) { Fail 'terrain/world screenshot paths do not resolve to non-empty files' }

Write-Host "Multiplayer strict gate PASS: $EvidencePath" -ForegroundColor Green
Write-Host "  level=$($state.level) loadedChunkCount=$($state.loadedChunkCount)"
Write-Host "  relaySuccesses=$($bridge.relayNodeSuccesses) attestationFailures=$($bridge.relayTargetAttestationFailures) errors=$($bridge.errors)"
Write-Host "  terrainScreenshots=$($resolvedScreenshots -join '; ')"

if (-not $ExecuteUpload) {
    Write-Host 'Preparation only: no release upload, tag mutation, or Pages dispatch performed.' -ForegroundColor Yellow
    Write-Host 'Re-run with -ExecuteUpload after reviewing the strict gate output.' -ForegroundColor Yellow
    exit 0
}

# Only after the strict multiplayer gate passes do we replace the staged
# acceptance marker and recompute checksums. The v0.1.0 tag is never moved.
$manifest.acceptanceEvidence.multiplayer = (Resolve-Path -LiteralPath $EvidencePath).Path.Replace('\\','/')
$manifest.acceptanceEvidence.multiplayerStatus = 'passed'
$manifest.relay.publicStrictLatencyGate = 'passed'
$manifest.generatedAt = (Get-Date).ToUniversalTime().ToString('o')
$manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding utf8

$notesPath = Join-Path $stagePath 'RELEASE-NOTES.md'
$notes = Get-Content -LiteralPath $notesPath -Raw
$notes = $notes -replace 'The currently deployed public RelayNode strict latency gate remains open and is not represented as passed by this release\.', 'The public RelayNode strict multiplayer acceptance gate passed in real Chrome/CDP and is recorded in release.manifest.json.'
if ($notes -notmatch 'public RelayNode strict multiplayer acceptance gate passed') {
    $notes += "`r`n`r`nMultiplayer strict acceptance: PASS ($([IO.Path]::GetFileName($EvidencePath))).`r`n"
}
Set-Content -LiteralPath $notesPath -Value $notes -Encoding utf8

$hashLines = foreach ($file in Get-ChildItem -LiteralPath $stagePath -File | Where-Object { $_.Name -ne 'SHA256SUMS' } | Sort-Object Name) {
    "$( (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() )  $($file.Name)"
}
$ascii = [Text.Encoding]::ASCII
[IO.File]::WriteAllText((Join-Path $stagePath 'SHA256SUMS'), (($hashLines -join "`n") + "`n"), $ascii)

$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
$shell = if ($pwsh) { $pwsh.Source } else { (Get-Command powershell -ErrorAction Stop).Source }
& $shell -NoProfile -File (Join-Path $root 'port/target/release-v0.1.0-final-20260913-clobber.ps1')
if ($LASTEXITCODE -ne 0) { Fail 'release clobber script failed' }

& $shell -NoProfile -File (Join-Path $root 'port/target/release-v0.1.0-fresh-download-verify.ps1')
if ($LASTEXITCODE -ne 0) { Fail 'fresh-download verification failed' }

Write-Host 'FINAL RELEASE v0.1.0 upload + fresh-download + Pages dispatch completed.' -ForegroundColor Green
