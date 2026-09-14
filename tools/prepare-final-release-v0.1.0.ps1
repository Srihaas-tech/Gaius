[CmdletBinding()]
param(
    [string]$Stage = 'port/target/release-v0.1.0-final-20260913',
    [Parameter(Mandatory = $true)][string]$Singleplayer12111Evidence,
    [Parameter(Mandatory = $true)][string]$Singleplayer262Evidence,
    [Parameter(Mandatory = $true)][string]$Multiplayer12111Evidence,
    [Parameter(Mandatory = $true)][string]$Multiplayer262Evidence
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$requiredAssets = @(
    'Gaius-1.21.11.html', 'Gaius-1.21.11.manifest.json',
    'Gaius-26.2.html', 'Gaius-26.2.manifest.json',
    'gaius-server-plugin-0.1.0.jar', 'RELEASE-NOTES.md',
    'release.manifest.json', 'SHA256SUMS'
)

function Fail([string]$Message) { throw "FINAL RELEASE PREP: $Message" }
function Resolve-Input([string]$Path, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Path)) { Fail "$Label was not supplied" }
    $candidate = if ([IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $root $Path }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { Fail "$Label not found: $candidate" }
    (Resolve-Path -LiteralPath $candidate).Path
}
function Read-Json([string]$Path, [string]$Label) {
    try { Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { Fail "$Label is not valid JSON: $Path ($($_.Exception.Message))" }
}
function Get-Identity([string]$Path) {
    [ordered]@{
        bytes = [long](Get-Item -LiteralPath $Path).Length
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
function Assert-SamePath([string]$Actual, [string]$Expected, [string]$Label) {
    $a = [IO.Path]::GetFullPath($Actual).TrimEnd('\', '/')
    $e = [IO.Path]::GetFullPath($Expected).TrimEnd('\', '/')
    if (-not [string]::Equals($a, $e, [StringComparison]::OrdinalIgnoreCase)) {
        Fail "$Label path mismatch (actual=$a expected=$e)"
    }
}
function Verify-Portable([string]$Profile) {
    $dist = Join-Path $root "port/web/dist/$Profile"
    $html = Join-Path $dist 'Gaius.html'
    $manifestPath = Join-Path $dist 'Gaius.manifest.json'
    $classes = Join-Path $dist 'classes.js'
    foreach ($path in @($html, $manifestPath, $classes)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0) {
            Fail "$Profile artifact is missing or empty: $path"
        }
    }
    $manifest = Read-Json $manifestPath "$Profile portable manifest"
    if ($manifest.kind -ne 'gaius-portable-artifact' -or $manifest.profile -ne $Profile -or $manifest.artifact -ne 'Gaius.html') {
        Fail "$Profile portable manifest identity is invalid"
    }
    $classesIdentity = Get-Identity $classes
    if ([long]$manifest.classesJs.rawBytes -ne [long]$classesIdentity.bytes -or
        [string]$manifest.classesJs.rawSha256 -ne [string]$classesIdentity.sha256) {
        Fail "$Profile classes.js does not match its portable manifest"
    }
    $compiler = $manifest.classesJs.compiler
    if ($compiler.optimizationLevel -ne 'ADVANCED' -or $compiler.minifying -ne $true -or
        $compiler.assertionsRemoved -ne $true -or $compiler.shortFileNames -ne $true) {
        Fail "$Profile client is not a release ADVANCED/minified/assertions-removed/short-names build"
    }
    [pscustomobject]@{
        Profile = $Profile; Dist = $dist; Html = $html; ManifestPath = $manifestPath
        Manifest = $manifest; HtmlIdentity = Get-Identity $html
    }
}
function Verify-Single([string]$EvidencePath, [object]$Portable) {
    $profile = $Portable.Profile
    $evidence = Read-Json $EvidencePath "$profile singleplayer evidence"
    if ($evidence.completed -ne $true -or $evidence.success -ne $true -or $evidence.profile -ne $profile) {
        Fail "$profile singleplayer evidence requires matching profile, completed=true, and success=true"
    }
    if ($evidence.mode -notin @('single', 'both') -or $null -eq $evidence.singleRuntime -or $evidence.singleRuntime.level -ne $true) {
        Fail "$profile singleplayer evidence did not enter a level in single/both mode"
    }
    $singleRuntime = $evidence.singleRuntime
    if ($singleRuntime.protocol -ne 'file:' -or $singleRuntime.portableBuild -ne $true) {
        Fail "$profile singleplayer evidence is not a portable file:// run"
    }
    if ($singleRuntime.wasm.ready -ne $true -or $singleRuntime.wasm.disabled -eq $true -or
        $null -ne $singleRuntime.wasm.error -or $singleRuntime.storage -ne 'ok' -or $singleRuntime.idb -ne 'ok') {
        Fail "$profile singleplayer WASM/storage/IndexedDB gate failed"
    }
    if ($singleRuntime.terrain.ready -ne $true -or
        [long]$singleRuntime.terrain.loadedChunkCount -le 0 -or
        [long]$singleRuntime.terrain.chunkEventCount -le 0 -or
        $singleRuntime.terrain.visual.terrainVisualPass -ne $true) {
        Fail "$profile singleplayer terrain/new-chunk visual gate failed"
    }
    if ($evidence.cleanup.cdpClosed -ne $true -or $evidence.cleanup.chromeExited -ne $true -or
        $evidence.cleanup.profileRemoved -ne $true) {
        Fail "$profile singleplayer Chrome/profile cleanup gate failed"
    }
    if (@($evidence.exceptions).Count -ne 0 -or @($evidence.siblingFileRequests).Count -ne 0) {
        Fail "$profile singleplayer evidence contains exceptions or sibling file requests"
    }
    if ([string]::IsNullOrWhiteSpace([string]$evidence.artifact)) { Fail "$profile evidence has no artifact path" }
    $artifact = if ([IO.Path]::IsPathRooted([string]$evidence.artifact)) {
        [string]$evidence.artifact
    } else { Join-Path (Split-Path -Parent $EvidencePath) ([string]$evidence.artifact) }
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { Fail "$profile evidence artifact is missing: $artifact" }
    Assert-SamePath (Resolve-Path -LiteralPath $artifact).Path (Resolve-Path -LiteralPath $Portable.Html).Path "$profile evidence"
    if (-not ($evidence.PSObject.Properties.Name -contains 'artifactIdentity') -or $null -eq $evidence.artifactIdentity) {
        Fail "$profile evidence is legacy/stale: artifactIdentity is required"
    }
    if ([long]$evidence.artifactIdentity.bytes -ne [long]$Portable.HtmlIdentity.bytes -or
        [string]$evidence.artifactIdentity.sha256 -ne [string]$Portable.HtmlIdentity.sha256 -or
        $evidence.artifactIdentity.unchanged -ne $true) {
        Fail "$profile evidence artifactIdentity is stale relative to the current Gaius.html"
    }
    [pscustomobject]@{ Path = $EvidencePath; Evidence = $evidence; Identity = $Portable.HtmlIdentity }
}
function Verify-Contract([object]$Portable) {
    $profile = $Portable.Profile
    $path = Join-Path $root "port/target/$profile/browser-full-path-artifact-contract.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "$profile artifact contract is missing: $path" }
    $contract = Read-Json $path "$profile artifact contract"
    if ($contract.status -ne 'pass' -or $contract.profile.id -ne $profile -or
        $contract.artifact.classesSha256 -ne $Portable.Manifest.classesJs.rawSha256 -or
        [long]$contract.artifact.classesBytes -ne [long]$Portable.Manifest.classesJs.rawBytes) {
        Fail "$profile artifact contract is stale or failed"
    }
    Assert-SamePath (Resolve-Path -LiteralPath $contract.paths.portableHtml).Path $Portable.Html "$profile contract HTML"
    Assert-SamePath (Resolve-Path -LiteralPath $contract.paths.manifest).Path $Portable.ManifestPath "$profile contract manifest"
    $path
}
function Verify-Multiplayer([string]$EvidencePath, [object]$Portable, [string]$Validator) {
    $profile = $Portable.Profile
    $evidence = Read-Json $EvidencePath "$profile multiplayer evidence"
    if ($evidence.profile -ne $profile) {
        Fail "$profile multiplayer evidence profile mismatch: $($evidence.profile)"
    }

    $priorTarget = $env:TARGET
    $priorRelay = $env:RELAY
    $priorArtifact = $env:ARTIFACT
    $priorProfile = $env:PROFILE
    $validatorOutput = $null
    $validatorExitCode = $null
    try {
        $env:TARGET = 't40.sjcmc.cn:14803'
        $env:RELAY = 'wss://ellan.site/tunnel'
        $env:PROFILE = $profile
        $env:ARTIFACT = $Portable.Html
        $validatorOutput = & node $Validator $EvidencePath
        $validatorExitCode = $LASTEXITCODE
    } finally {
        if ($null -eq $priorTarget) { Remove-Item Env:TARGET -ErrorAction SilentlyContinue } else { $env:TARGET = $priorTarget }
        if ($null -eq $priorRelay) { Remove-Item Env:RELAY -ErrorAction SilentlyContinue } else { $env:RELAY = $priorRelay }
        if ($null -eq $priorArtifact) { Remove-Item Env:ARTIFACT -ErrorAction SilentlyContinue } else { $env:ARTIFACT = $priorArtifact }
        if ($null -eq $priorProfile) { Remove-Item Env:PROFILE -ErrorAction SilentlyContinue } else { $env:PROFILE = $priorProfile }
    }
    if ($validatorExitCode -ne 0) { Fail "$profile strict multiplayer terrain evidence validation failed" }
    try { $terrain = $validatorOutput | Out-String | ConvertFrom-Json }
    catch { Fail "$profile terrain validator returned invalid JSON: $($_.Exception.Message)" }
    if ($terrain.success -ne $true -or [string]::IsNullOrWhiteSpace([string]$terrain.schema)) {
        Fail "$profile strict multiplayer terrain evidence did not pass with a validator schema"
    }
    [pscustomobject]@{
        Path = $EvidencePath
        Identity = Get-Identity $EvidencePath
        Terrain = $terrain
    }
}
function Resolve-SafeStage([string]$Path) {
    $candidate = if ([IO.Path]::IsPathRooted($Path)) { [IO.Path]::GetFullPath($Path) } else { [IO.Path]::GetFullPath((Join-Path $root $Path)) }
    $targetRoot = [IO.Path]::GetFullPath((Join-Path $root 'port/target')).TrimEnd('\', '/')
    if (-not $candidate.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        Fail "refusing to clear stage outside port/target: $candidate"
    }
    $candidate
}
function Assert-ExactStage([string]$Path) {
    $actual = @(Get-ChildItem -LiteralPath $Path -Force -File | ForEach-Object Name | Sort-Object)
    $expected = @($requiredAssets | Sort-Object)
    if (($actual -join "`n") -ne ($expected -join "`n")) {
        Fail "stage is not exact-eight (actual=$($actual -join ', '))"
    }
    if (@(Get-ChildItem -LiteralPath $Path -Force -Directory).Count -ne 0) { Fail 'stage contains unexpected directories' }
}

$p12111 = Verify-Portable '1.21.11'
$p262 = Verify-Portable '26.2'
$single12111Path = Resolve-Input $Singleplayer12111Evidence '1.21.11 singleplayer evidence'
$single262Path = Resolve-Input $Singleplayer262Evidence '26.2 singleplayer evidence'
$multiplayer12111Path = Resolve-Input $Multiplayer12111Evidence '1.21.11 multiplayer evidence'
$multiplayer262Path = Resolve-Input $Multiplayer262Evidence '26.2 multiplayer evidence'
if ([string]::Equals($multiplayer12111Path, $multiplayer262Path, [StringComparison]::OrdinalIgnoreCase)) {
    Fail '1.21.11 and 26.2 multiplayer evidence must be independent files'
}
$single12111 = Verify-Single $single12111Path $p12111
$single262 = Verify-Single $single262Path $p262
$singleValidator = Join-Path $root 'tools/check-singleplayer-terrain-evidence.mjs'
if (-not (Test-Path -LiteralPath $singleValidator -PathType Leaf)) { Fail "tracked singleplayer terrain validator is missing: $singleValidator" }
foreach ($entry in @(@($single12111Path, $p12111), @($single262Path, $p262))) {
    $priorArtifact = $env:ARTIFACT; $priorProfile = $env:PROFILE
    try {
        $env:ARTIFACT = $entry[1].Html
        $env:PROFILE = $entry[1].Profile
        & node $singleValidator $entry[0] | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "$($entry[1].Profile) strict singleplayer terrain evidence validation failed" }
    } finally {
        if ($null -eq $priorArtifact) { Remove-Item Env:ARTIFACT -ErrorAction SilentlyContinue } else { $env:ARTIFACT = $priorArtifact }
        if ($null -eq $priorProfile) { Remove-Item Env:PROFILE -ErrorAction SilentlyContinue } else { $env:PROFILE = $priorProfile }
    }
}
$contract12111 = Verify-Contract $p12111
$contract262 = Verify-Contract $p262

$validator = Join-Path $root 'tools/check-multiplayer-terrain-evidence.mjs'
if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) { Fail "tracked multiplayer validator is missing: $validator" }
$multiplayer12111 = Verify-Multiplayer $multiplayer12111Path $p12111 $validator
$multiplayer262 = Verify-Multiplayer $multiplayer262Path $p262 $validator
if ($multiplayer12111.Identity.sha256 -eq $multiplayer262.Identity.sha256) {
    Fail '1.21.11 and 26.2 multiplayer evidence identities must be independent'
}

$plugin = Join-Path $root 'apps/server-plugin/target/gaius-server-plugin-0.1.0.jar'
$notesTemplate = Join-Path $root 'tools/release-v0.1.0-notes.md'
foreach ($path in @($plugin, $notesTemplate)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0) {
        Fail "required release input is missing or empty: $path"
    }
}

# Clear only after every input/evidence gate passed, and only below port/target.
$stagePath = Resolve-SafeStage $Stage
New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
$stagePath = (Resolve-Path -LiteralPath $stagePath).Path
foreach ($entry in @(Get-ChildItem -LiteralPath $stagePath -Force)) {
    Remove-Item -LiteralPath $entry.FullName -Recurse -Force
}
Copy-Item -LiteralPath $p12111.Html -Destination (Join-Path $stagePath 'Gaius-1.21.11.html')
Copy-Item -LiteralPath $p12111.ManifestPath -Destination (Join-Path $stagePath 'Gaius-1.21.11.manifest.json')
Copy-Item -LiteralPath $p262.Html -Destination (Join-Path $stagePath 'Gaius-26.2.html')
Copy-Item -LiteralPath $p262.ManifestPath -Destination (Join-Path $stagePath 'Gaius-26.2.manifest.json')
Copy-Item -LiteralPath $plugin -Destination (Join-Path $stagePath 'gaius-server-plugin-0.1.0.jar')
Copy-Item -LiteralPath $notesTemplate -Destination (Join-Path $stagePath 'RELEASE-NOTES.md')

$head = (git rev-parse --verify HEAD).Trim()
$releaseManifest = [ordered]@{
    schemaVersion = 4; tag = 'v0.1.0'; version = '0.1.0'; sourceHead = $head
    sourceBranch = 'main'; artifactBuildReason = 'rebuilt-from-final-main'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o'); profiles = @('1.21.11', '26.2')
    artifacts = [ordered]@{
        client12111 = [ordered]@{ file = 'Gaius-1.21.11.html'; identity = $p12111.HtmlIdentity }
        client262 = [ordered]@{ file = 'Gaius-26.2.html'; identity = $p262.HtmlIdentity }
        serverPlugin = [ordered]@{ file = 'gaius-server-plugin-0.1.0.jar'; identity = (Get-Identity $plugin) }
    }
    artifactContracts = [ordered]@{
        '1.21.11' = $contract12111.Substring($root.Length + 1).Replace('\', '/')
        '26.2' = $contract262.Substring($root.Length + 1).Replace('\', '/')
    }
    acceptanceEvidence = [ordered]@{
        '1.21.11.single' = [ordered]@{ file = [IO.Path]::GetFileName($single12111Path); identity = (Get-Identity $single12111Path); artifactIdentity = $single12111.Identity }
        '26.2.single' = [ordered]@{ file = [IO.Path]::GetFileName($single262Path); identity = (Get-Identity $single262Path); artifactIdentity = $single262.Identity }
        '1.21.11.multiplayer' = [ordered]@{ profile = '1.21.11'; file = [IO.Path]::GetFileName($multiplayer12111.Path); identity = $multiplayer12111.Identity; artifactIdentity = $p12111.HtmlIdentity; validatorSchema = $multiplayer12111.Terrain.schema; status = 'passed' }
        '26.2.multiplayer' = [ordered]@{ profile = '26.2'; file = [IO.Path]::GetFileName($multiplayer262.Path); identity = $multiplayer262.Identity; artifactIdentity = $p262.HtmlIdentity; validatorSchema = $multiplayer262.Terrain.schema; status = 'passed' }
    }
    relay = [ordered]@{ url = 'wss://ellan.site/tunnel'; target = 't40.sjcmc.cn:14803'; strictTerrainGate = 'passed' }
    pages = [ordered]@{
        home = 'https://typethe0ry.github.io/Gaius/'; '1.21.11' = 'https://typethe0ry.github.io/Gaius/1.21.11/'
        '26.2' = 'https://typethe0ry.github.io/Gaius/26.2/'; relayRegistry = 'https://typethe0ry.github.io/Gaius/relay-nodes.json'
    }
}
[IO.File]::WriteAllText((Join-Path $stagePath 'release.manifest.json'), (($releaseManifest | ConvertTo-Json -Depth 12) + "`n"), $utf8NoBom)
$hashLines = foreach ($file in Get-ChildItem -LiteralPath $stagePath -Force -File | Sort-Object Name) {
    "$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($file.Name)"
}
[IO.File]::WriteAllText((Join-Path $stagePath 'SHA256SUMS'), (($hashLines -join "`n") + "`n"), [Text.Encoding]::ASCII)
Assert-ExactStage $stagePath

Write-Host "Final release staging PASS: $stagePath" -ForegroundColor Green
Write-Host "  exactAssets=8 sourceHead=$head"
Write-Host "  1.21.11=$($p12111.HtmlIdentity.sha256) ($($p12111.HtmlIdentity.bytes) bytes)"
Write-Host "  26.2=$($p262.HtmlIdentity.sha256) ($($p262.HtmlIdentity.bytes) bytes)"
Write-Host "  1.21.11 multiplayer=ClientLevel, chunks>0 validator=$($multiplayer12111.Terrain.schema)"
Write-Host "  26.2 multiplayer=ClientLevel, chunks>0 validator=$($multiplayer262.Terrain.schema)"
Write-Host 'No release upload, tag/ref mutation, push, or Pages dispatch was performed.' -ForegroundColor Yellow
