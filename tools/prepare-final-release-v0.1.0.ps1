[CmdletBinding()]
param(
    [string]$Stage = 'port/target/release-v0.1.0-final-20260913',
    [string]$Singleplayer12111Evidence,
    [string]$Singleplayer262Evidence,
    [string]$MultiplayerEvidence,
    [switch]$AllowPendingMultiplayer
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root

function Fail([string]$Message) { throw "FINAL RELEASE PREP: $Message" }
function Resolve-InputPath([string]$Path, [string]$Label, [switch]$Optional) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        if ($Optional) { return $null }
        Fail "$Label was not supplied"
    }
    $candidate = if ([IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $root $Path }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { Fail "$Label not found: $candidate" }
    return (Resolve-Path -LiteralPath $candidate).Path
}
function Read-Json([string]$Path, [string]$Label) {
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { Fail "$Label is not valid JSON: $Path ($($_.Exception.Message))" }
}
function Verify-SingleplayerEvidence([string]$Path, [string]$Profile, [string]$ArtifactPath) {
    $evidence = Read-Json $Path "$Profile singleplayer evidence"
    if ($evidence.success -ne $true -or $evidence.completed -ne $true) {
        Fail "$Profile singleplayer evidence did not report completed=true and success=true"
    }
    if ([string]$evidence.profile -ne $Profile) {
        Fail "$Profile singleplayer evidence profile mismatch: $($evidence.profile)"
    }
    $evidenceArtifact = [string]$evidence.artifact
    if ([string]::IsNullOrWhiteSpace($evidenceArtifact)) { Fail "$Profile singleplayer evidence has no artifact path" }
    if (-not [IO.Path]::IsPathRooted($evidenceArtifact)) { $evidenceArtifact = Join-Path (Split-Path -Parent $Path) $evidenceArtifact }
    if (-not (Test-Path -LiteralPath $evidenceArtifact -PathType Leaf)) {
        Fail "$Profile singleplayer evidence artifact no longer exists: $evidenceArtifact"
    }
    $actualEvidenceArtifact = (Resolve-Path -LiteralPath $evidenceArtifact).Path
    if ($actualEvidenceArtifact -ne (Resolve-Path -LiteralPath $ArtifactPath).Path) {
        Fail "$Profile singleplayer evidence points at a different artifact: $actualEvidenceArtifact"
    }
    if (@($evidence.exceptions).Count -ne 0) { Fail "$Profile singleplayer evidence contains runtime exceptions" }
    if (@($evidence.siblingFileRequests).Count -ne 0) { Fail "$Profile portable artifact requested sibling files" }
    return $evidence
}
function Verify-PortableArtifact([string]$Profile) {
    $dist = Join-Path $root "port/web/dist/$Profile"
    $html = Join-Path $dist 'Gaius.html'
    $manifest = Join-Path $dist 'Gaius.manifest.json'
    foreach ($required in @($html, $manifest)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Fail "$Profile artifact is missing: $required" }
        if ((Get-Item -LiteralPath $required).Length -le 0) { Fail "$Profile artifact is empty: $required" }
    }
    $portable = Read-Json $manifest "$Profile portable manifest"
    if ([string]$portable.kind -ne 'gaius-portable-artifact' -or [string]$portable.profile -ne $Profile) {
        Fail "$Profile portable manifest identity is invalid"
    }
    if ([string]$portable.classesJs.compiler.optimizationLevel -ne 'ADVANCED' -or
        $portable.classesJs.compiler.minifying -ne $true -or
        $portable.classesJs.compiler.assertionsRemoved -ne $true -or
        $portable.classesJs.compiler.shortFileNames -ne $true) {
        Fail "$Profile client is not release-grade ADVANCED/minified/assertions-removed/short-names"
    }
    return [pscustomobject]@{ Profile = $Profile; Dist = $dist; Html = $html; Manifest = $manifest; Portable = $portable }
}
function Verify-ArtifactContract([string]$Profile, [string]$ContractPath, [object]$PortableProfile) {
    if (-not (Test-Path -LiteralPath $ContractPath -PathType Leaf)) { Fail "artifact contract is missing: $ContractPath" }
    $contract = Read-Json $ContractPath "$Profile artifact contract"
    if ($contract.status -ne 'pass' -or $contract.profile.id -ne $Profile) {
        Fail "$Profile artifact contract did not pass with the expected profile identity"
    }
    if ([string]$contract.artifact.classesSha256 -ne [string]$PortableProfile.Portable.classesJs.rawSha256 -or
        [long]$contract.artifact.classesBytes -ne [long]$PortableProfile.Portable.classesJs.rawBytes) {
        Fail "$Profile artifact contract is stale relative to the current portable manifest"
    }
    if ((Resolve-Path -LiteralPath $contract.paths.portableHtml).Path -ne (Resolve-Path -LiteralPath $PortableProfile.Html).Path -or
        (Resolve-Path -LiteralPath $contract.paths.manifest).Path -ne (Resolve-Path -LiteralPath $PortableProfile.Manifest).Path) {
        Fail "$Profile artifact contract paths do not resolve to the current portable artifact"
    }
    return $contract
}

$profile12111 = Verify-PortableArtifact '1.21.11'
$profile262 = Verify-PortableArtifact '26.2'
$single12111Path = Resolve-InputPath $Singleplayer12111Evidence '1.21.11 singleplayer evidence'
$single262Path = Resolve-InputPath $Singleplayer262Evidence '26.2 singleplayer evidence'
$null = Verify-SingleplayerEvidence $single12111Path '1.21.11' $profile12111.Html
$null = Verify-SingleplayerEvidence $single262Path '26.2' $profile262.Html

$multiplayerPath = Resolve-InputPath $MultiplayerEvidence 'multiplayer evidence' -Optional
if (-not $multiplayerPath -and -not $AllowPendingMultiplayer) {
    Fail 'multiplayer evidence is required unless -AllowPendingMultiplayer is explicitly used'
}
if ($multiplayerPath) {
    $validator = Join-Path $root '..\Gaius-migration-2026-08-14\_tmp\validate-terrain-evidence.mjs'
    if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) {
        Fail "strict Node terrain validator not found: $validator"
    }
    & node $validator $multiplayerPath
    if ($LASTEXITCODE -ne 0) { Fail 'strict multiplayer terrain evidence validation failed' }
}

$stagePath = if ([IO.Path]::IsPathRooted($Stage)) { $Stage } else { Join-Path $root $Stage }
New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
$stagePath = (Resolve-Path -LiteralPath $stagePath).Path

$serverPlugin = Join-Path $root 'apps/server-plugin/target/gaius-server-plugin-0.1.0.jar'
if (-not (Test-Path -LiteralPath $serverPlugin -PathType Leaf) -or (Get-Item $serverPlugin).Length -le 0) {
    Fail "server plugin artifact is missing or empty: $serverPlugin"
}

Copy-Item -LiteralPath $profile12111.Html -Destination (Join-Path $stagePath 'Gaius-1.21.11.html') -Force
Copy-Item -LiteralPath $profile12111.Manifest -Destination (Join-Path $stagePath 'Gaius-1.21.11.manifest.json') -Force
Copy-Item -LiteralPath $profile262.Html -Destination (Join-Path $stagePath 'Gaius-26.2.html') -Force
Copy-Item -LiteralPath $profile262.Manifest -Destination (Join-Path $stagePath 'Gaius-26.2.manifest.json') -Force
Copy-Item -LiteralPath $serverPlugin -Destination (Join-Path $stagePath 'gaius-server-plugin-0.1.0.jar') -Force

$notesPath = Join-Path $stagePath 'RELEASE-NOTES.md'
if (-not (Test-Path -LiteralPath $notesPath -PathType Leaf)) {
    $notesTemplate = Join-Path $root 'port/target/release-v0.1.0-final-20260913/RELEASE-NOTES.md'
    if (-not (Test-Path -LiteralPath $notesTemplate -PathType Leaf)) {
        Fail "release notes template is missing: $notesTemplate"
    }
    Copy-Item -LiteralPath $notesTemplate -Destination $notesPath -Force
}

$head = (git rev-parse --verify HEAD).Trim()
$contract12111 = Join-Path $root 'port/target/1.21.11/browser-full-path-artifact-contract.json'
$contract262 = Join-Path $root 'port/target/26.2/browser-full-path-artifact-contract.json'
$null = Verify-ArtifactContract '1.21.11' $contract12111 $profile12111
$null = Verify-ArtifactContract '26.2' $contract262 $profile262

$manifest = [ordered]@{
    schemaVersion = 2
    tag = 'v0.1.0'
    version = '0.1.0'
    sourceHead = $head
    sourceBranch = 'main'
    reason = 'rebuilt-from-final-main'
    artifactBuildReason = 'rebuilt-from-final-main'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    profiles = @('1.21.11', '26.2')
    artifacts = [ordered]@{
        client12111 = 'Gaius-1.21.11.html'
        client262 = 'Gaius-26.2.html'
        serverPlugin = 'gaius-server-plugin-0.1.0.jar'
    }
    artifactContracts = [ordered]@{
        '1.21.11' = $contract12111.Substring($root.Length + 1).Replace('\', '/')
        '26.2' = $contract262.Substring($root.Length + 1).Replace('\', '/')
    }
    publicationGate = 'real Chrome/CDP singleplayer and multiplayer acceptance must pass before clobber upload'
    pages = [ordered]@{
        home = 'https://typethe0ry.github.io/Gaius/'
        '1.21.11' = 'https://typethe0ry.github.io/Gaius/1.21.11/'
        '26.2' = 'https://typethe0ry.github.io/Gaius/26.2/'
        relayRegistry = 'https://typethe0ry.github.io/Gaius/relay-nodes.json'
    }
    relay = [ordered]@{
        url = 'wss://ellan.site/tunnel'
        target = 't40.sjcmc.cn:14803'
        localValidation = 'completed'
        publicStrictLatencyGate = if ($multiplayerPath) { 'passed' } else { 'open' }
    }
    acceptanceEvidence = [ordered]@{
        '1.21.11.single' = $single12111Path.Replace('\', '/')
        '26.2.single' = $single262Path.Replace('\', '/')
        multiplayer = if ($multiplayerPath) { $multiplayerPath.Replace('\', '/') } else { 'pending' }
        multiplayerStatus = if ($multiplayerPath) { 'passed' } else { 'pending' }
    }
}

$utf8NoBom = [Text.UTF8Encoding]::new($false)
$manifestJson = $manifest | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText((Join-Path $stagePath 'release.manifest.json'), $manifestJson + "`n", $utf8NoBom)

$hashLines = foreach ($file in Get-ChildItem -LiteralPath $stagePath -File |
        Where-Object { $_.Name -ne 'SHA256SUMS' } | Sort-Object Name) {
    "$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($file.Name)"
}
[IO.File]::WriteAllText((Join-Path $stagePath 'SHA256SUMS'), (($hashLines -join "`n") + "`n"), [Text.Encoding]::ASCII)

& 'C:\Program Files\Git\bin\bash.exe' -lc "cd '$($stagePath -replace '\\','/')' && sha256sum -c SHA256SUMS"
if ($LASTEXITCODE -ne 0) { Fail 'staged SHA256SUMS verification failed' }

Write-Host "Final release staging prepared: $stagePath" -ForegroundColor Green
Write-Host "  sourceHead=$head"
Write-Host "  1.21.11=$($profile12111.Portable.classesJs.rawSha256)"
Write-Host "  26.2=$($profile262.Portable.classesJs.rawSha256)"
Write-Host "  multiplayerStatus=$($manifest.acceptanceEvidence.multiplayerStatus)"
Write-Host 'No release upload, tag mutation, push, or Pages dispatch was performed.' -ForegroundColor Yellow
