$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$dist = Join-Path $root 'port\web\dist\1.21.11'
$required = @(
  'classes.js',
  'classes.js.build.json',
  'classes.js.release.json',
  'singleplayer-server.js',
  'singleplayer-server.js.build.json',
  'singleplayer-server.js.release.json',
  'singleplayer-server-worker.js',
  'singleplayer-server-worker.js.build.json',
  'gaius-hotpath.wasm',
  'gaius-hotpath.wasm.build.json',
  'Gaius.html',
  'Gaius.manifest.json',
  'relay-nodes.json',
  'relay-nodes.json.build.json'
)

foreach ($name in $required) {
  $path = Join-Path $dist $name
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Missing release artifact: $path"
  }
  if ((Get-Item -LiteralPath $path).Length -le 0) {
    throw "Empty release artifact: $path"
  }
}

& node --check (Join-Path $dist 'classes.js')
if ($LASTEXITCODE -ne 0) { throw 'classes.js node --check failed' }
& node --check (Join-Path $dist 'singleplayer-server.js')
if ($LASTEXITCODE -ne 0) { throw 'singleplayer-server.js node --check failed' }
& node --check (Join-Path $dist 'singleplayer-server-worker.js')
if ($LASTEXITCODE -ne 0) { throw 'singleplayer-server-worker.js node --check failed' }

$manifest = Get-Content -LiteralPath (Join-Path $dist 'Gaius.manifest.json') -Raw | ConvertFrom-Json
$checks = @(
  @{ Name = 'classes.js'; Expected = $manifest.classesJs.rawSha256 },
  @{ Name = 'classes.js.build.json'; Expected = $manifest.classesJs.build.sidecarSha256 },
  @{ Name = 'classes.js.release.json'; Expected = $manifest.classesJs.compiler.sidecarSha256 },
  @{ Name = 'singleplayer-server.js'; Expected = $manifest.singleplayerServerJs.rawSha256 },
  @{ Name = 'singleplayer-server.js.build.json'; Expected = $manifest.singleplayerServerJs.build.sidecarSha256 },
  @{ Name = 'singleplayer-server.js.release.json'; Expected = $manifest.singleplayerServerJs.compiler.sidecarSha256 },
  @{ Name = 'singleplayer-server-worker.js'; Expected = $manifest.singleplayerWorkerBootstrap.sha256 },
  @{ Name = 'singleplayer-server-worker.js.build.json'; Expected = $manifest.singleplayerWorkerBootstrap.build.sidecarSha256 },
  @{ Name = 'gaius-hotpath.wasm'; Expected = $manifest.wasmHotpath.rawSha256 },
  @{ Name = 'gaius-hotpath.wasm.build.json'; Expected = $manifest.wasmHotpath.build.sidecarSha256 },
  @{ Name = 'relay-nodes.json'; Expected = $manifest.relayRegistry.sha256 },
  @{ Name = 'relay-nodes.json.build.json'; Expected = $manifest.relayRegistry.build.sidecarSha256 }
)
foreach ($check in $checks) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $dist $check.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $check.Expected) {
    throw "Manifest hash mismatch: $($check.Name) expected=$($check.Expected) actual=$actual"
  }
  [PSCustomObject]@{ Artifact = $check.Name; SHA256 = $actual; Verified = $true }
}

$clientProfile = Get-Content -LiteralPath (Join-Path $dist 'classes.js.release.json') -Raw | ConvertFrom-Json
$workerProfile = Get-Content -LiteralPath (Join-Path $dist 'singleplayer-server.js.release.json') -Raw | ConvertFrom-Json
foreach ($profile in @($clientProfile, $workerProfile)) {
  if (!$profile.releaseGrade -or
      $profile.compiler.optimizationLevel -notin @('ADVANCED', 'FULL') -or
      !$profile.compiler.minifying -or
      !$profile.compiler.shortFileNames -or
      !$profile.compiler.assertionsRemoved -or
      $profile.compiler.debugInformationGenerated -or
      $profile.compiler.sourceMapsGenerated) {
    throw "Non-release compiler profile: $($profile.role)"
  }
}

$env:GAIUS_VERSION_PROFILE_PATH = 'versions/1.21.11.json'
$env:GAIUS_DIST_DIRECTORY = $dist
& node (Join-Path $root 'apps\bridge\browser-full-path-artifact-contract-smoke.mjs')
if ($LASTEXITCODE -ne 0) { throw 'portable artifact contract failed' }

Write-Output '1.21.11 release artifact gate passed'
